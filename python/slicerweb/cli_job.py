"""Running a CLI module away from the page, in a worker.

Desktop Slicer runs a CLI module as a separate program: it writes the chosen nodes to files, starts
the program with their paths, and reads back the files it wrote. That is what happens here, with a
worker in place of the process (see :mod:`slicerweb.jobs`): the page writes its input nodes to
files, the worker loads them into a scene of its own, calls the same implementation function as the
page would, and writes the outputs back for the page to read into the nodes that are waiting.

Both sides use the functions here, so a node makes the journey the same way in both directions.
Nothing in this module touches the application: the worker has no views, no module manager and no
``slicer.app``, only MRML and VTK.
"""

import logging
import os

import vtk

logger = logging.getLogger("slicerweb.cli")

#: What each kind of node is written as. The formats are the ones Slicer itself uses for these.
FILE_TYPES = {
    "vtkMRMLScalarVolumeNode": ".nrrd",
    "vtkMRMLLabelMapVolumeNode": ".nrrd",
    "vtkMRMLVolumeNode": ".nrrd",
    "vtkMRMLModelNode": ".vtp",
    "vtkMRMLMarkupsFiducialNode": ".mrk.json",
    "vtkMRMLTransformNode": ".tfm",
    "vtkMRMLTableNode": ".tsv",
}

_STORAGE_NODES = {
    "vtkMRMLScalarVolumeNode": "vtkMRMLVolumeArchetypeStorageNode",
    "vtkMRMLLabelMapVolumeNode": "vtkMRMLVolumeArchetypeStorageNode",
    "vtkMRMLVolumeNode": "vtkMRMLVolumeArchetypeStorageNode",
    "vtkMRMLModelNode": "vtkMRMLModelStorageNode",
    "vtkMRMLMarkupsFiducialNode": "vtkMRMLMarkupsFiducialStorageNode",
    "vtkMRMLTransformNode": "vtkMRMLTransformStorageNode",
    "vtkMRMLTableNode": "vtkMRMLTableStorageNode",
}


def fileNameFor(parameterName, nodeType):
    """Where a parameter's node is written, in the directory a job works in."""
    return "/work/" + parameterName + FILE_TYPES.get(nodeType, ".vtk")


def _storageNode(scene, node):
    storage = node.GetStorageNode()
    if storage is None:
        className = _STORAGE_NODES.get(node.GetClassName())
        storage = scene.AddNewNodeByClass(className) if className else node.CreateDefaultStorageNode()
        if storage is None:
            raise RuntimeError(f"{node.GetClassName()} cannot be written to a file")
        if storage.GetScene() is None:
            scene.AddNode(storage)
        node.SetAndObserveStorageNodeID(storage.GetID())
    return storage


def writeNode(node, path):
    """Write a node to a file, as Slicer writes the inputs of a CLI module."""
    scene = node.GetScene()
    storage = _storageNode(scene, node)
    storage.SetFileName(path)
    if not storage.WriteData(node):
        raise RuntimeError(f"{node.GetName()} could not be written to {path}")
    return path


def readNode(scene, path, nodeType, name=None):
    """Read a file written by writeNode back into a new node of this scene."""
    node = scene.AddNewNodeByClass(nodeType, name or os.path.basename(path))
    storage = _storageNode(scene, node)
    storage.SetFileName(path)
    if not storage.ReadData(node):
        raise RuntimeError(f"{path} could not be read as {nodeType}")
    return node


def readInto(node, path):
    """Read a file into a node that already exists (the output the page is waiting for)."""
    storage = _storageNode(node.GetScene(), node)
    storage.SetFileName(path)
    if not storage.ReadData(node):
        raise RuntimeError(f"{path} could not be read into {node.GetName()}")
    if hasattr(node, "CreateDefaultDisplayNodes") and node.GetDisplayNode() is None:
        node.CreateDefaultDisplayNodes()
    return node


# ---------------------------------------------------------------------------- inside the worker
def runInWorker(name, values, inputs, outputs):
    """Run a CLI module here, on files, and write what it made.

    Slicer's own C++ module is used when it is built into the application; otherwise the Python
    implementation of it (see :mod:`slicerweb.cli_modules`) runs instead.

    :param name: the module, e.g. ``"GaussianBlurImageFilter"``
    :param values: the parameters that are not nodes, as the panel holds them
    :param inputs: ``{parameter: [path, nodeType]}`` written by the page
    :param outputs: ``{parameter: [path, nodeType]}`` to write when it is done
    :return: the paths written, so that the page knows what to read back
    """
    import slicer

    from . import cli_modules

    progress("Reading the inputs", 0.05)
    scene = slicer.vtkMRMLScene()
    # slicer.util and the implementations reach for the scene through the slicer module, as they do
    # in the page; here it is a scene of this worker's own, with nothing in it but these nodes.
    slicer.mrmlScene = scene

    nodes = {}
    for parameter, (path, nodeType) in inputs.items():
        nodes[parameter] = readNode(scene, path, nodeType, parameter)
    for parameter, (path, nodeType) in outputs.items():
        nodes[parameter] = scene.AddNewNodeByClass(nodeType, parameter)

    progress(f"Running {name}", 0.2)
    if _runBuiltIn(scene, name, values, nodes):
        pass
    else:
        implementation = cli_modules.implementation(name)
        if implementation is None:
            raise RuntimeError(f"CLI module {name} is not available in the web browser")
        implementation({**values, **nodes})

    progress("Writing what it made", 0.9)
    written = {}
    for parameter, (path, nodeType) in outputs.items():
        written[parameter] = writeNode(nodes[parameter], path)
    return written


def _runBuiltIn(scene, name, values, nodes):
    """Run Slicer's own C++ module, if this application was built with it.

    It is run the way the application runs it: through vtkSlicerCLIModuleLogic, which writes the
    nodes to files, calls the module's entry point and reads the files back into the nodes. The
    worker has no application around it, so it is given an application logic of its own - the logic
    needs one for the temporary directory and for the queue the results come back through.
    """
    import slicer

    factory = getattr(slicer, "vtkSlicerWebCLIModule", None)
    if factory is None or factory.GetXMLDescription(name) is None:
        return False
    logic = factory.CreateLogic(name)
    if logic is None:
        return False

    # The node the logic reports its progress through comes from MRMLCLI, not MRMLCore, so a new
    # scene does not know the class: the application registers it with its own scene, and the
    # scene here needs it too, or the logic is handed nothing when it asks for one.
    scene.RegisterNodeClass(slicer.vtkMRMLCommandLineModuleNode())

    applicationLogic = slicer.vtkSlicerApplicationLogic()
    applicationLogic.SetMRMLScene(scene)
    applicationLogic.SetTemporaryPath("/work")
    applicationLogic.CreateProcessingThread()  # opens the result queues; starts no thread here
    # Reading a file back asks the scene's cache manager whether the name is a remote one, so the
    # scene needs the same data IO the application gives its own.
    remoteIO = slicer.vtkMRMLRemoteIOLogic()
    remoteIO.GetCacheManager().SetRemoteCacheDirectory("/work/cache")
    dataIO = slicer.vtkDataIOManagerLogic()
    dataIO.SetMRMLApplicationLogic(applicationLogic)
    dataIO.SetAndObserveDataIOManager(remoteIO.GetDataIOManager())
    applicationLogic.SetMRMLSceneDataIO(scene, remoteIO, dataIO)
    logic.SetMRMLScene(scene)
    logic.SetMRMLApplicationLogic(applicationLogic)

    cliNode = logic.CreateNodeInScene()
    for parameter, value in values.items():
        if value is not None and value != "":
            cliNode.SetParameterAsString(parameter, str(value))
    for parameter, node in nodes.items():
        cliNode.SetParameterAsString(parameter, node.GetID())

    # The module says how far it has got through the node, which the logic modifies as it goes
    observer = cliNode.AddObserver("ModifiedEvent", lambda caller, event: _cliProgress(caller))
    try:
        logic.ApplyAndWait(cliNode, False)
        status = cliNode.GetStatusString()
        if status != "Completed":
            raise RuntimeError(f"{name} {status.lower()}: {cliNode.GetErrorText() or 'no message'}")
    finally:
        cliNode.RemoveObserver(observer)
        scene.RemoveNode(cliNode)
    return True


def _cliProgress(cliNode):
    done = cliNode.GetProgress()
    progress("Running", 0.2 + 0.7 * min(max(done / 100.0 if done > 1 else done, 0.0), 1.0))


def progress(message, fraction):
    """Say how far the work has got. Nothing is listening outside a worker."""
    try:
        import slicerweb_job  # registered by the worker (web/src/core/jobWorker.ts)
    except ImportError:
        return
    slicerweb_job.progress(message, fraction)


def watch(filter, message, start=0.2, end=0.9):
    """Report a VTK filter's own progress as the module's, between these two marks.

    VTK's threaded image filters report about fifty times as they work, which is what fills the
    bar in the panel while a module runs; the ones that only report when they start and finish
    (marching cubes, for one) simply leave it where it was.
    """
    last = [0.0]

    def tick(caller, event):
        fraction = start + (end - start) * caller.GetProgress()
        if fraction - last[0] >= 0.02:
            last[0] = fraction
            progress(message, fraction)

    filter.AddObserver(vtk.vtkCommand.ProgressEvent, tick)
    return filter

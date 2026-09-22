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

    parameters = dict(values)
    for parameter, (path, nodeType) in inputs.items():
        parameters[parameter] = readNode(scene, path, nodeType, parameter)
    for parameter, (path, nodeType) in outputs.items():
        parameters[parameter] = scene.AddNewNodeByClass(nodeType, parameter)

    progress(f"Running {name}", 0.2)
    implementation = cli_modules.implementation(name)
    if implementation is None:
        raise RuntimeError(f"CLI module {name} is not available in the web browser")
    implementation(parameters)

    progress("Writing what it made", 0.9)
    written = {}
    for parameter, (path, nodeType) in outputs.items():
        written[parameter] = writeNode(parameters[parameter], path)
    return written


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

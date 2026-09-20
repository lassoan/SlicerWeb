"""Python implementations of CLI modules.

CLI modules are separate programs, which cannot be started from a web page (a worker based runner is
planned). Modules that call widely used CLI modules through slicer.cli.run() therefore fail. The CLI
modules implemented here in Python are run in place, so that such modules work:

- Decimation (SurfaceToolbox extension), used by the VMTK modules to simplify the input surface

slicer.cli.run()/runSync() use these implementations; other CLI modules raise an error that names the
module, as before.
"""

import logging

import slicer
import vtk

logger = logging.getLogger("slicerweb.cli")

# name (lower case) -> implementation(parameters dict)
_IMPLEMENTATIONS = {}


class CliModule:
    """Stands in for a CLI module object (slicer.modules.<name>)."""

    def __init__(self, name, title=None):
        self.name = name
        self.title = title or name

    def __repr__(self):
        return f"<CliModule {self.name}>"


def register(name, implementation, title=None):
    """Register a Python implementation of a CLI module, available as slicer.modules.<name>."""
    _IMPLEMENTATIONS[name.lower()] = implementation
    setattr(slicer.modules, name.lower(), CliModule(name, title))


def _node_or_value(value):
    """CLI parameters are nodes, node IDs or plain values."""
    if isinstance(value, str) and value.startswith("vtkMRML"):
        node = slicer.mrmlScene.GetNodeByID(value)
        if node is not None:
            return node
    return value


def run(module, node=None, parameters=None, wait_for_completion=False, **kwargs):
    """slicer.cli.run() for the browser: runs the Python implementation of the CLI module."""
    name = getattr(module, "name", str(module)).lower()
    implementation = _IMPLEMENTATIONS.get(name)
    if implementation is None:
        raise RuntimeError(f"CLI module {getattr(module, 'name', module)} is not available in the web browser")
    parameters = {key: _node_or_value(value) for key, value in (parameters or {}).items()}
    cliNode = node
    if cliNode is None:
        cliNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLCommandLineModuleNode", name)
    try:
        implementation(parameters)
        cliNode.SetStatus(cliNode.Completed)
    except Exception:
        cliNode.SetStatus(cliNode.CompletedWithErrors)
        raise
    return cliNode


def runSync(module, node=None, parameters=None, **kwargs):
    return run(module, node=node, parameters=parameters, wait_for_completion=True, **kwargs)


# ---------------------------------------------------------------------------- Decimation
def decimation(parameters):
    """Decimation CLI module (SurfaceToolbox): reduce the number of triangles of a surface."""
    inputModel = parameters.get("inputModel")
    outputModel = parameters.get("outputModel")
    if inputModel is None or outputModel is None:
        raise ValueError("Decimation: inputModel and outputModel are required")
    reductionFactor = float(parameters.get("reductionFactor", 0.8))
    method = str(parameters.get("method", "FastQuadric"))
    boundaryDeletion = bool(parameters.get("boundaryDeletion", True))
    inputMesh = inputModel.GetPolyData() if hasattr(inputModel, "GetPolyData") else inputModel
    if inputMesh is None:
        raise ValueError("Decimation: input model has no mesh")

    triangulator = vtk.vtkTriangleFilter()
    triangulator.SetInputData(inputMesh)
    if method == "DecimatePro":
        decimator = vtk.vtkDecimatePro()
        decimator.SetBoundaryVertexDeletion(boundaryDeletion)
        decimator.PreserveTopologyOn()
    else:
        # "FastQuadric" and "Quadric": quadric error metric decimation
        decimator = vtk.vtkQuadricDecimation()
        if hasattr(decimator, "SetVolumePreservation"):
            decimator.SetVolumePreservation(True)
    decimator.SetInputConnection(triangulator.GetOutputPort())
    decimator.SetTargetReduction(min(max(reductionFactor, 0.0), 0.999))
    normals = vtk.vtkPolyDataNormals()
    normals.SetInputConnection(decimator.GetOutputPort())
    normals.SetSplitting(False)
    normals.Update()
    outputMesh = normals.GetOutput()
    logger.info("Decimation (%s): %d -> %d points", method, inputMesh.GetNumberOfPoints(), outputMesh.GetNumberOfPoints())
    outputModel.SetAndObserveMesh(outputMesh)
    if outputModel.GetDisplayNode() is None:
        outputModel.CreateDefaultDisplayNodes()


def install():
    """Use the Python implementations for slicer.cli.run()/runSync() and slicer.modules.<name>."""
    import slicer.cli

    slicer.cli.run = run
    slicer.cli.runSync = runSync
    register("Decimation", decimation, "Decimation")

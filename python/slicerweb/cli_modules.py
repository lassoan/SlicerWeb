"""CLI modules, run inside the page.

A CLI module in desktop Slicer is a separate program that Slicer starts with the parameters the user
chose, described by an XML document the program itself prints. A web page cannot start programs, so
the modules here are Python implementations that run in place.

They are described by the very XML of the module they stand for, shipped in
``share/Slicer-X.Y/cli-modules``, so they carry the same name, category, parameters, defaults and
help as in desktop Slicer, and the panel is built from that description the way Slicer builds a CLI
module's GUI from it. A module is offered only when there is both a description and an
implementation, so adding another one is a matter of writing the function.

``slicer.cli.run()`` and ``runSync()`` call these implementations, so scripted modules that use a
CLI module work unchanged; anything else still raises an error that names the module.

What is not done here: a parent transform on an input node is ignored (the real modules resample
through it), and the implementations work on the whole volume rather than streaming it.
"""

import glob
import logging
import os
import xml.etree.ElementTree as ElementTree

import slicer
import vtk

from . import cli_job
from .modules import ModuleBase

logger = logging.getLogger("slicerweb.cli")

#: name (lower case) -> implementation(parameters dict)
_IMPLEMENTATIONS = {}
#: name (lower case) -> parsed XML description
_DESCRIPTIONS = None
#: The logics of the CLI modules built in as C++. The application logic only keeps a weak pointer to
#: a module's logic - on the desktop the module object owns it - so they are held here instead.
_BUILT_IN_LOGICS = {}

#: What a parameter of each XML tag is, and what kind of node it takes.
_NODE_TYPES = {
    "image": "vtkMRMLScalarVolumeNode",
    "geometry": "vtkMRMLModelNode",
    "transform": "vtkMRMLTransformNode",
    "table": "vtkMRMLTableNode",
    "pointfile": "vtkMRMLMarkupsFiducialNode",
}
_NUMBER_TAGS = ("integer", "float", "double")
_VECTOR_TAGS = ("integer-vector", "float-vector", "double-vector")


def implements(name):
    """Register the Python implementation of the CLI module of this name."""

    def decorator(function):
        _IMPLEMENTATIONS[name.lower()] = function
        return function

    return decorator


# ---------------------------------------------------------------------------- the XML description
def _text(element, tag, default=""):
    value = element.findtext(tag)
    return default if value is None else value.strip()


def _parameter(element):
    """One parameter of a CLI module, as the panel needs it."""
    tag = element.tag
    parameter = {
        "name": _text(element, "name") or _text(element, "longflag").lstrip("-"),
        "label": _text(element, "label"),
        "description": _text(element, "description"),
        "tag": tag,
        "channel": _text(element, "channel") or ("input" if tag in _NODE_TYPES else None),
        "default": _text(element, "default", None),
        "elements": [e.text for e in element.findall("element")],
        "nodeType": _NODE_TYPES.get(tag),
        "hidden": _text(element, "hidden") == "true",
    }
    if tag in _NUMBER_TAGS or tag in _VECTOR_TAGS:
        constraints = element.find("constraints")
        if constraints is not None:
            parameter["minimum"] = _text(constraints, "minimum", None)
            parameter["maximum"] = _text(constraints, "maximum", None)
            parameter["step"] = _text(constraints, "step", None)
    return parameter


def _parse_description(path):
    root = ElementTree.parse(path).getroot()
    name = os.path.splitext(os.path.basename(path))[0]
    groups = []
    for group in root.findall("parameters"):
        parameters = [_parameter(p) for p in group if p.tag not in ("label", "description")]
        parameters = [p for p in parameters if p["name"] and not p["hidden"]]
        if parameters:
            groups.append({"label": _text(group, "label") or "Parameters",
                           "description": _text(group, "description"),
                           "advanced": _text(group, "advanced") == "true",
                           "parameters": parameters})
    return {
        "name": name,
        "title": _text(root, "title") or name,
        "category": _text(root, "category"),
        "description": _text(root, "description"),
        "version": _text(root, "version"),
        "contributor": _text(root, "contributor"),
        "acknowledgements": _text(root, "acknowledgements"),
        "documentationUrl": _text(root, "documentation-url"),
        "groups": groups,
    }


def descriptions():
    """The XML descriptions of the CLI modules shipped with the application, by lower case name."""
    global _DESCRIPTIONS
    if _DESCRIPTIONS is None:
        _DESCRIPTIONS = {}
        directory = os.path.join(slicer.app.slicerSharePath or "", "cli-modules")
        for path in sorted(glob.glob(os.path.join(directory, "*.xml"))):
            try:
                description = _parse_description(path)
            except Exception:
                logger.exception("Could not read the CLI module description %s", path)
                continue
            _DESCRIPTIONS[description["name"].lower()] = description
    return _DESCRIPTIONS


def description(name):
    return descriptions().get(str(name).lower())


def implementation(name):
    """The function that stands for this CLI module, or None if there is none."""
    return _IMPLEMENTATIONS.get(str(name).lower())


def defaultValues(description):
    """What the panel starts with: the defaults of the XML, empty for the nodes."""
    values = {}
    for group in description["groups"]:
        for parameter in group["parameters"]:
            if parameter["nodeType"]:
                values[parameter["name"]] = None
            else:
                values[parameter["name"]] = parameter["default"]
    return values


# ---------------------------------------------------------------------------- running
class CliModuleDescriptor(ModuleBase):
    """A CLI module as the module manager holds it (there is no Qt module class to stand in for)."""

    kind = "cli"

    def __init__(self, description, implementation):
        super().__init__(
            description["name"], title=description["title"],
            categories=[description["category"]] if description["category"] else [],
            helpText=description["description"], acknowledgementText=description["acknowledgements"],
            contributors=[c.strip() for c in description["contributor"].split(",") if c.strip()])
        self.description = description
        self.implementation = implementation

    def initialize(self, app):
        """Nothing to build: the implementation is a function and the panel comes from the XML."""


def _node_or_value(value):
    """A CLI parameter is a node, a node ID or a plain value."""
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
    values = {key: _node_or_value(value) for key, value in (parameters or {}).items()}
    cliNode = node
    if cliNode is None:
        cliNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLCommandLineModuleNode", name)
    try:
        implementation(values)
        cliNode.SetStatus(cliNode.Completed)
    except Exception:
        cliNode.SetStatus(cliNode.CompletedWithErrors)
        raise
    return cliNode


def runSync(module, node=None, parameters=None, **kwargs):
    return run(module, node=node, parameters=parameters, wait_for_completion=True, **kwargs)


# ---------------------------------------------------------------------------- volume helpers
def _required(parameters, *names):
    missing = [name for name in names if parameters.get(name) is None]
    if missing:
        raise ValueError(f"{', '.join(missing)} {'are' if len(missing) > 1 else 'is'} required")
    return [parameters[name] for name in names]


def _number(parameters, name, default, cast=float):
    value = parameters.get(name, default)
    if value is None or value == "":
        return cast(default)
    return cast(value)


def _boolean(value, default=False):
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return default if value is None else bool(value)


def _vector(value, default, cast=float):
    if isinstance(value, str):
        parts = [p for p in value.replace(";", ",").split(",") if p.strip() != ""]
    elif value is None:
        parts = []
    else:
        parts = list(value)
    numbers = [cast(float(p)) for p in parts] if parts else list(default)
    while len(numbers) < len(default):
        numbers.append(numbers[-1] if numbers else default[len(numbers)])
    return numbers[:len(default)]


def _image_of(volumeNode):
    """The voxels with their real size.

    Slicer keeps a volume's geometry in the node (the image data itself is at unit spacing), while
    the VTK filters work in millimetres, so the spacing has to be put back on the way in.
    """
    image = vtk.vtkImageData()
    image.ShallowCopy(volumeNode.GetImageData())
    image.SetSpacing(volumeNode.GetSpacing())
    image.SetOrigin(0.0, 0.0, 0.0)
    return image


def _store_image(outputNode, image, referenceNode, spacing=None):
    """Put a filtered image in an output volume, with the geometry of the volume it came from."""
    result = vtk.vtkImageData()
    result.ShallowCopy(image)
    result.SetSpacing(1.0, 1.0, 1.0)
    result.SetOrigin(0.0, 0.0, 0.0)
    outputNode.SetAndObserveImageData(result)
    outputNode.CopyOrientation(referenceNode)
    if spacing is not None:
        outputNode.SetSpacing(*spacing)
    if outputNode.GetDisplayNode() is None:
        outputNode.CreateDefaultDisplayNodes()


def _array_of(image):
    """The voxels of a vtkImageData as a numpy array (k, j, i), sharing its memory."""
    from vtk.util import numpy_support

    shape = list(reversed(image.GetDimensions()))
    return numpy_support.vtk_to_numpy(image.GetPointData().GetScalars()).reshape(shape)


def _image_from_array(values, like):
    """A vtkImageData holding these voxels, shaped and spaced like the image they came from."""
    from vtk.util import numpy_support

    image = vtk.vtkImageData()
    image.SetDimensions(like.GetDimensions())
    image.SetSpacing(like.GetSpacing())
    image.AllocateScalars(numpy_support.get_vtk_array_type(values.dtype), 1)
    _array_of(image)[:] = values
    return image


def _cast_like(values, dtype):
    """Bring a result back to the type of the volume it came from, clamped rather than wrapped."""
    import numpy as np

    if np.issubdtype(dtype, np.integer):
        limits = np.iinfo(dtype)
        values = np.clip(np.rint(values), limits.min, limits.max)
    return values.astype(dtype)


def _same_grid(a, b):
    if list(a.GetImageData().GetDimensions()) != list(b.GetImageData().GetDimensions()):
        return False
    first, second = vtk.vtkMatrix4x4(), vtk.vtkMatrix4x4()
    a.GetIJKToRASMatrix(first)
    b.GetIJKToRASMatrix(second)
    return all(abs(first.GetElement(r, c) - second.GetElement(r, c)) < 1e-6 for r in range(4) for c in range(4))


def _interpolate(reslice, order):
    if order <= 0:
        reslice.SetInterpolationModeToNearestNeighbor()
    elif order == 1:
        reslice.SetInterpolationModeToLinear()
    else:
        reslice.SetInterpolationModeToCubic()


def _resampled_like(sourceNode, referenceNode, order=1):
    """The voxels of one volume on another volume's grid, as the arithmetic modules do."""
    if _same_grid(sourceNode, referenceNode):
        return _image_of(sourceNode)
    ijkToRas, rasToIjk = vtk.vtkMatrix4x4(), vtk.vtkMatrix4x4()
    referenceNode.GetIJKToRASMatrix(ijkToRas)
    sourceNode.GetRASToIJKMatrix(rasToIjk)
    resliceAxes = vtk.vtkMatrix4x4()
    vtk.vtkMatrix4x4.Multiply4x4(rasToIjk, ijkToRas, resliceAxes)
    reslice = vtk.vtkImageReslice()
    reslice.SetInputData(sourceNode.GetImageData())
    reslice.SetResliceAxes(resliceAxes)
    reslice.SetOutputExtent(referenceNode.GetImageData().GetExtent())
    reslice.SetOutputSpacing(1.0, 1.0, 1.0)
    reslice.SetOutputOrigin(0.0, 0.0, 0.0)
    _interpolate(reslice, order)
    reslice.Update()
    image = vtk.vtkImageData()
    image.ShallowCopy(reslice.GetOutput())
    image.SetSpacing(referenceNode.GetSpacing())
    return image


# ---------------------------------------------------------------------------- implementations
@implements("ThresholdScalarVolume")
def _threshold_scalar_volume(parameters):
    inputVolume, outputVolume = _required(parameters, "InputVolume", "OutputVolume")
    thresholdType = str(parameters.get("ThresholdType") or "Outside")
    outsideValue = _number(parameters, "OutsideValue", 0)
    negate = _boolean(parameters.get("Negate"))

    threshold = vtk.vtkImageThreshold()
    cli_job.watch(threshold, "Thresholding")
    threshold.SetInputData(_image_of(inputVolume))
    if thresholdType == "Below":
        threshold.ThresholdByLower(_number(parameters, "ThresholdValue", 128))
    elif thresholdType == "Above":
        threshold.ThresholdByUpper(_number(parameters, "ThresholdValue", 128))
    else:
        threshold.ThresholdBetween(_number(parameters, "Lower", 1), _number(parameters, "Upper", 200))
    # Below and Above name the voxels that are replaced; Outside keeps what is between the two
    # values. Negate replaces the other side instead.
    replaceInside = thresholdType in ("Below", "Above")
    if negate:
        replaceInside = not replaceInside
    # Giving the filter a value switches the matching replacement on, so the flags are set last
    threshold.SetInValue(outsideValue)
    threshold.SetOutValue(outsideValue)
    threshold.SetReplaceIn(replaceInside)
    threshold.SetReplaceOut(not replaceInside)
    threshold.SetOutputScalarType(inputVolume.GetImageData().GetScalarType())
    threshold.Update()
    _store_image(outputVolume, threshold.GetOutput(), inputVolume)


def _arithmetic(parameters, operation):
    """Two volumes, voxel by voxel, the second one resampled onto the first one's grid.

    The arithmetic is done in floating point and brought back to the type of the first volume,
    so that a sum that does not fit is clamped rather than wrapped around.
    """
    import numpy as np

    volume1, volume2, outputVolume = _required(parameters, "inputVolume1", "inputVolume2", "outputVolume")
    order = _number(parameters, "order", 1, int)
    firstImage = _image_of(volume1)
    first = _array_of(firstImage)
    second = _array_of(_resampled_like(volume2, volume1, order))
    result = operation(first.astype(np.float64), second.astype(np.float64))
    _store_image(outputVolume, _image_from_array(_cast_like(result, first.dtype), firstImage), volume1)


@implements("AddScalarVolumes")
def _add_scalar_volumes(parameters):
    import numpy as np

    _arithmetic(parameters, np.add)


@implements("SubtractScalarVolumes")
def _subtract_scalar_volumes(parameters):
    import numpy as np

    _arithmetic(parameters, np.subtract)


@implements("MultiplyScalarVolumes")
def _multiply_scalar_volumes(parameters):
    import numpy as np

    _arithmetic(parameters, np.multiply)


_SCALAR_TYPES = {
    "Char": vtk.VTK_CHAR, "UnsignedChar": vtk.VTK_UNSIGNED_CHAR, "Short": vtk.VTK_SHORT,
    "UnsignedShort": vtk.VTK_UNSIGNED_SHORT, "Int": vtk.VTK_INT, "UnsignedInt": vtk.VTK_UNSIGNED_INT,
    "Float": vtk.VTK_FLOAT, "Double": vtk.VTK_DOUBLE,
}


@implements("CastScalarVolume")
def _cast_scalar_volume(parameters):
    inputVolume, outputVolume = _required(parameters, "InputVolume", "OutputVolume")
    scalarType = _SCALAR_TYPES.get(str(parameters.get("Type") or "UnsignedChar"))
    if scalarType is None:
        raise ValueError(f"Cast Scalar Volume: unknown type {parameters.get('Type')}")
    cast = vtk.vtkImageCast()
    cli_job.watch(cast, "Casting")
    cast.SetInputData(_image_of(inputVolume))
    cast.SetOutputScalarType(scalarType)
    cast.ClampOverflowOn()
    cast.Update()
    _store_image(outputVolume, cast.GetOutput(), inputVolume)


@implements("MaskScalarVolume")
def _mask_scalar_volume(parameters):
    import numpy as np

    inputVolume, maskVolume, outputVolume = _required(parameters, "InputVolume", "MaskVolume", "OutputVolume")
    label = _number(parameters, "Label", 1, int)
    replace = _number(parameters, "Replace", 0, int)

    inputImage = _image_of(inputVolume)
    voxels = _array_of(inputImage)
    maskVoxels = _array_of(_resampled_like(maskVolume, inputVolume, order=0))
    masked = np.where(maskVoxels == label, voxels, np.array(replace, dtype=voxels.dtype))
    _store_image(outputVolume, _image_from_array(masked, inputImage), inputVolume)


@implements("GaussianBlurImageFilter")
def _gaussian_blur(parameters):
    inputVolume, outputVolume = _required(parameters, "inputVolume", "outputVolume")
    sigma = _number(parameters, "sigma", 1.0)
    blur = vtk.vtkImageGaussianSmooth()
    cli_job.watch(blur, "Blurring")
    blur.SetInputData(_image_of(inputVolume))
    # The module's sigma is in millimetres, the filter's standard deviation in voxels
    blur.SetStandardDeviations(*[sigma / s for s in inputVolume.GetSpacing()])
    blur.SetDimensionality(3)
    blur.Update()
    _store_image(outputVolume, blur.GetOutput(), inputVolume)


@implements("MedianImageFilter")
def _median_filter(parameters):
    inputVolume, outputVolume = _required(parameters, "inputVolume", "outputVolume")
    radius = _vector(parameters.get("neighborhood"), [1, 1, 1], int)
    median = vtk.vtkImageMedian3D()
    cli_job.watch(median, "Filtering")
    median.SetInputData(_image_of(inputVolume))
    median.SetKernelSize(*[2 * r + 1 for r in radius])
    median.Update()
    _store_image(outputVolume, median.GetOutput(), inputVolume)


def _sinc_interpolator(window):
    interpolator = vtk.vtkImageSincInterpolator()
    getattr(interpolator, "SetWindowFunctionTo" + window)()
    interpolator.AntialiasingOn()
    return interpolator


@implements("ResampleScalarVolume")
def _resample_scalar_volume(parameters):
    inputVolume, outputVolume = _required(parameters, "InputVolume", "OutputVolume")
    spacing = _vector(parameters.get("outputPixelSpacing"), [0.0, 0.0, 0.0])
    spacing = [new if new > 0 else old for new, old in zip(spacing, inputVolume.GetSpacing())]
    kind = str(parameters.get("interpolationType") or "linear")

    resample = vtk.vtkImageResample()
    cli_job.watch(resample, "Resampling")
    resample.SetInputData(_image_of(inputVolume))
    for axis, (old, new) in enumerate(zip(inputVolume.GetSpacing(), spacing)):
        resample.SetAxisOutputSpacing(axis, new)
        resample.SetAxisMagnificationFactor(axis, old / new)
    if kind == "nearestNeighbor":
        resample.SetInterpolationModeToNearestNeighbor()
    elif kind == "linear":
        resample.SetInterpolationModeToLinear()
    elif kind == "bspline":
        resample.SetInterpolator(vtk.vtkImageBSplineInterpolator())
    else:
        # hamming, cosine, welch, lanczos, blackman: windowed sinc, named as in the module
        resample.SetInterpolator(_sinc_interpolator(kind.capitalize()))
    resample.Update()
    _store_image(outputVolume, resample.GetOutput(), inputVolume, spacing=spacing)


@implements("MergeModels")
def _merge_models(parameters):
    model1, model2, output = _required(parameters, "Model1", "Model2", "ModelOutput")
    append = vtk.vtkAppendPolyData()
    for model in (model1, model2):
        mesh = model.GetPolyData() if hasattr(model, "GetPolyData") else model
        if mesh is None:
            raise ValueError("Merge Models: an input model has no mesh")
        append.AddInputData(mesh)
    append.Update()
    output.SetAndObserveMesh(append.GetOutput())
    if output.GetDisplayNode() is None:
        output.CreateDefaultDisplayNodes()


@implements("GrayscaleModelMaker")
def _grayscale_model_maker(parameters):
    inputVolume, output = _required(parameters, "InputVolume", "OutputGeometry")
    threshold = _number(parameters, "Threshold", 100.0)
    smooth = _number(parameters, "Smooth", 15, int)
    decimate = _number(parameters, "Decimate", 0.25)
    splitNormals = _boolean(parameters.get("SplitNormals"), True)
    pointNormals = _boolean(parameters.get("PointNormals"), True)

    surface = vtk.vtkFlyingEdges3D() if hasattr(vtk, "vtkFlyingEdges3D") else vtk.vtkMarchingCubes()
    cli_job.watch(surface, "Finding the surface", end=0.6)
    surface.SetInputData(_image_of(inputVolume))
    surface.SetValue(0, threshold)
    surface.ComputeNormalsOff()
    pipeline = surface
    if smooth > 0:
        smoother = vtk.vtkWindowedSincPolyDataFilter()
        smoother.SetInputConnection(pipeline.GetOutputPort())
        smoother.SetNumberOfIterations(smooth)
        smoother.BoundarySmoothingOff()
        smoother.FeatureEdgeSmoothingOff()
        smoother.NonManifoldSmoothingOn()
        smoother.NormalizeCoordinatesOn()
        pipeline = smoother
    if decimate > 0:
        decimator = vtk.vtkDecimatePro()
        decimator.SetInputConnection(pipeline.GetOutputPort())
        decimator.SetTargetReduction(min(decimate, 0.999))
        decimator.PreserveTopologyOn()
        pipeline = decimator
    normals = vtk.vtkPolyDataNormals()
    normals.SetInputConnection(pipeline.GetOutputPort())
    normals.SetSplitting(splitNormals)
    normals.SetComputePointNormals(pointNormals)
    # The surface comes out in IJK millimetres; the model node holds it in RAS
    ijkToRas = vtk.vtkMatrix4x4()
    inputVolume.GetIJKToRASMatrix(ijkToRas)
    scale = vtk.vtkTransform()
    scale.SetMatrix(ijkToRas)
    scale.Scale(*[1.0 / s for s in inputVolume.GetSpacing()])
    toRas = vtk.vtkTransformPolyDataFilter()
    toRas.SetTransform(scale)
    toRas.SetInputConnection(normals.GetOutputPort())
    toRas.Update()

    output.SetAndObserveMesh(toRas.GetOutput())
    name = str(parameters.get("Name") or "").strip()
    if name and name != "Model":
        output.SetName(slicer.mrmlScene.GetUniqueNameByString(name))
    if output.GetDisplayNode() is None:
        output.CreateDefaultDisplayNodes()


@implements("Decimation")
def _decimation(parameters):
    """Decimation (SurfaceToolbox extension): reduce the number of triangles of a surface."""
    inputModel, outputModel = _required(parameters, "inputModel", "outputModel")
    reductionFactor = _number(parameters, "reductionFactor", 0.8)
    method = str(parameters.get("method") or "FastQuadric")
    boundaryDeletion = _boolean(parameters.get("boundaryDeletion"), True)
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


# ---------------------------------------------------------------------------- registration
def install():
    """Use the Python implementations for slicer.cli.run()/runSync(), and offer them as modules."""
    import slicer.cli

    slicer.cli.run = run
    slicer.cli.runSync = runSync

    _installBuiltIn()

    manager = slicer.app.moduleManager()
    offered = []
    for name, implementation in sorted(_IMPLEMENTATIONS.items()):
        found = description(name)
        if found is None:
            # A module of an extension, whose XML is not shipped here: it has no panel, but a
            # scripted module asking for slicer.modules.<name> has to find something to run
            setattr(slicer.modules, name, _Unlisted(name))
            continue
        manager.registerLoadableModule(CliModuleDescriptor(found, implementation))
        offered.append(found["name"])
    logger.info("CLI modules: %s", ", ".join(offered) or "none")


def _installBuiltIn():
    """Let the C++ of other modules use the CLI modules that are built into the application.

    A few CLI modules are compiled into SlicerWebCore and run through vtkSlicerCLIModuleLogic, the
    way desktop Slicer runs a CLI module that is a library rather than a program (see
    SlicerWebCore/vtkSlicerWebCLIModule.h). Their logic goes into the application logic under the
    module's name, which is where C++ looks for it: vtkSlicerCropVolumeLogic asks the application
    logic for "ResampleScalarVectorDWIVolume" when it crops with resampling.
    """
    factory = getattr(slicer, "vtkSlicerWebCLIModule", None)
    if factory is None:
        logger.debug("No CLI modules are built into this application")
        return
    appLogic = slicer.app.applicationLogic()
    for name in (factory.GetModuleNames() or "").split(";"):
        name = name.strip()
        if not name:
            continue
        logic = factory.CreateLogic(name)
        if logic is None:
            logger.warning("The CLI module %s is built in but its logic could not be made", name)
            continue
        logic.SetMRMLScene(slicer.mrmlScene)
        logic.SetMRMLApplicationLogic(appLogic)
        _BUILT_IN_LOGICS[name] = logic
        appLogic.SetModuleLogic(name, logic)
        logger.info("CLI module %s is built in and runs in the page", name)


def builtIn(name):
    """Whether this CLI module is compiled into the application and can be run from C++."""
    return slicer.app.applicationLogic().GetModuleLogic(str(name)) is not None


class _Unlisted:
    """An implemented CLI module that has no description, so it is run rather than shown."""

    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return f"<CLI module {self.name}>"

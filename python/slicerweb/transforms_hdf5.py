"""Transforms in HDF5 files (.h5), which is how Slicer saves them by default.

This build of ITK is without HDF5 - its build runs programs on the host, which a cross-compiled
build has no way to run - so the readers and writers ITK would use for .h5 are not there. HDF5
itself is, though: Pyodide has h5py.

What an ITK transform file holds is the same whichever container it is in::

    /TransformGroup/<n>/TransformType             "AffineTransform_double_3_3"
    /TransformGroup/<n>/TransformParameters       the numbers of the transform
    /TransformGroup/<n>/TransformFixedParameters  its centre, grid, and so on

and the text form of the same thing (the Insight legacy format, .tfm, which this build does read
and write) says::

    #Insight Transform File V1.0
    #Transform 0
    Transform: AffineTransform_double_3_3
    Parameters: 0 -1 0 1 0 0 0 0 2 10 -20 30.5
    FixedParameters: 1 2 3

So the two are transcoded here, and the transform itself is read and written by Slicer as usual:
everything that decides what a transform means - that ITK keeps it in LPS while Slicer keeps it in
RAS, that a file holds the transform from the parent, where the centre of transformation goes - is
left where it belongs, in vtkMRMLTransformStorageNode.

A displacement field stored in a .h5 file is a different matter: the field is an image inside the
file, which the text form cannot hold. Such a file is refused with a message that says so.
"""

import logging
import os

import vtk

logger = logging.getLogger("slicerweb.io")

#: What Slicer writes transforms into by default, and what is read here.
EXTENSIONS = (".h5", ".hdf5", ".hdf")
#: The format both ends of the transcoding share.
TEXT_EXTENSION = ".tfm"

GROUP = "TransformGroup"


def available():
    """Whether HDF5 files can be read and written here at all."""
    try:
        import h5py  # noqa: F401
    except ImportError:
        return False
    return True


def _text(value):
    """A string out of what h5py gives back (bytes, an array of one, or a string)."""
    if hasattr(value, "shape") and getattr(value, "size", 0) >= 1 and not isinstance(value, (bytes, str)):
        value = value[0] if value.shape else value[()]
    if isinstance(value, bytes):
        return value.decode("utf8", "replace")
    return str(value)


def read_transforms(path):
    """The transforms in an HDF5 file: ``[(type, parameters, fixedParameters), ...]``."""
    import h5py

    transforms = []
    with h5py.File(str(path), "r") as handle:
        if GROUP not in handle:
            raise ValueError(f"{os.path.basename(str(path))} holds no transform")
        group = handle[GROUP]
        # The groups are numbered, and the numbers are what puts them in order
        for name in sorted(group, key=lambda n: int(n) if n.isdigit() else n):
            entry = group[name]
            if "TransformType" not in entry:
                continue
            transformType = _text(entry["TransformType"][()])
            values = entry.get("TransformParameters")
            fixedValues = entry.get("TransformFixedParameters")
            if "DisplacementField" in transformType or (values is not None and values.ndim != 1):
                raise ValueError(
                    f"{os.path.basename(str(path))} holds a {transformType}, whose numbers are an "
                    "image rather than a list; the text form cannot hold one, so it cannot be read here")
            parameters = [float(v) for v in values[()]] if values is not None else []
            fixed = [float(v) for v in fixedValues[()]] if fixedValues is not None else []
            transforms.append((transformType, parameters, fixed))
    if not transforms:
        raise ValueError(f"{os.path.basename(str(path))} holds no transform")
    return transforms


def write_transforms(path, transforms):
    """Write transforms into an HDF5 file the way ITK writes them."""
    import h5py

    with h5py.File(str(path), "w") as handle:
        strings = h5py.special_dtype(vlen=bytes)
        for name, value in (("ITKVersion", "5.4.7"),
                            ("HDFVersion", "HDF5 library version: %s" % h5py.version.hdf5_version),
                            ("OSName", "SlicerWeb"),
                            ("OSVersion", _application_version())):
            dataset = handle.create_dataset(name, (1,), dtype=strings)
            dataset[0] = str(value).encode("utf8")
        group = handle.create_group(GROUP)
        for index, (transformType, parameters, fixed) in enumerate(transforms):
            entry = group.create_group(str(index))
            typeSet = entry.create_dataset("TransformType", (1,), dtype=strings)
            typeSet[0] = str(transformType).encode("utf8")
            entry.create_dataset("TransformParameters", data=[float(v) for v in parameters], dtype="f8")
            entry.create_dataset("TransformFixedParameters", data=[float(v) for v in fixed], dtype="f8")


def _application_version():
    """What to put in the file as the version that wrote it (ITK writes its own there)."""
    try:
        import slicer

        return slicer.app.applicationVersion
    except Exception:
        return ""


def read_text(path):
    """The transforms in an Insight transform file (.tfm)."""
    transforms = []
    current = {}
    with open(str(path)) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            name, _, value = line.partition(":")
            name, value = name.strip(), value.strip()
            if name == "Transform":
                if current:
                    transforms.append(current)
                current = {"type": value, "parameters": [], "fixed": []}
            elif name == "Parameters":
                current["parameters"] = [float(v) for v in value.split()]
            elif name == "FixedParameters":
                current["fixed"] = [float(v) for v in value.split()]
    if current:
        transforms.append(current)
    return [(t["type"], t["parameters"], t["fixed"]) for t in transforms]


def write_text(path, transforms):
    """Write transforms in the Insight transform format (.tfm)."""
    with open(str(path), "w") as handle:
        handle.write("#Insight Transform File V1.0\n")
        for index, (transformType, parameters, fixed) in enumerate(transforms):
            handle.write("#Transform %d\n" % index)
            handle.write("Transform: %s\n" % transformType)
            handle.write("Parameters: %s\n" % " ".join(repr(float(v)) for v in parameters))
            handle.write("FixedParameters: %s\n" % " ".join(repr(float(v)) for v in fixed))


def hdf5_to_text(hdf5Path, textPath):
    """An .h5 transform file as a .tfm one, which this build can read."""
    write_text(textPath, read_transforms(hdf5Path))
    return textPath


def text_to_hdf5(textPath, hdf5Path):
    """A .tfm transform file as an .h5 one, which is what the rest of Slicer expects."""
    write_transforms(hdf5Path, read_text(textPath))
    return hdf5Path


def companion_text_path(path):
    """Where the text form of a transform file is kept while it is being transcoded."""
    import tempfile

    name = os.path.splitext(os.path.basename(str(path)))[0] + TEXT_EXTENSION
    return os.path.join(tempfile.mkdtemp(prefix="transform-"), name)


OWNER = "slicerweb:hdf5-transforms"


class HDF5TransformFileReader:
    """Reads a transform out of an HDF5 file, by way of its text form."""

    def __init__(self, parent):
        self.parent = parent

    def description(self):
        return "Transform"

    def fileType(self):
        return "TransformFile"

    def extensions(self):
        return ["Transform (*.h5 *.hdf5 *.hdf)"]

    def canLoadFileConfidence(self, filePath):
        # Surer than the application's own reader, which knows the extension but cannot read it
        return 0.7 if str(filePath).lower().endswith(EXTENSIONS) else 0.0

    def load(self, properties):
        import shutil

        import slicer

        # Asked for before anything is caught: a package that is not there yet is installed by
        # the page, which then runs this again (see slicerweb.packages).
        import h5py  # noqa: F401

        filePath = str(properties["fileName"])
        textPath = companion_text_path(filePath)
        try:
            hdf5_to_text(filePath, textPath)
            nodes = vtk.vtkCollection()
            messages = slicer.vtkMRMLMessageCollection()
            loadProperties = dict(properties)
            loadProperties["fileName"] = textPath
            loadProperties.setdefault("name", os.path.splitext(os.path.basename(filePath))[0])
            if not slicer.app.coreIOManager().loadNodes("TransformFile", loadProperties, nodes, messages):
                raise RuntimeError(messages.GetAllMessagesAsString() or "the transform could not be read")
            loaded = [nodes.GetItemAsObject(i) for i in range(nodes.GetNumberOfItems())]
            for node in loaded:
                # The file it came from is the HDF5 one, not the text form made on the way
                storage = node.GetStorageNode()
                if storage is not None:
                    storage.SetFileName(filePath)
            self.parent.loadedNodes = [node.GetID() for node in loaded]
        except Exception as e:
            self.parent.userMessages().AddMessage(
                vtk.vtkCommand.ErrorEvent, f"Failed to read {os.path.basename(filePath)}: {e}")
            return False
        finally:
            shutil.rmtree(os.path.dirname(textPath), ignore_errors=True)
        return True


class HDF5TransformFileWriter:
    """Writes a transform into an HDF5 file, by way of its text form."""

    def __init__(self, parent):
        self.parent = parent

    def description(self):
        return "Transform"

    def fileType(self):
        return "TransformFile"

    def extensions(self, node=None):
        return ["Transform (*.h5 *.hdf5 *.hdf)"]

    def canWriteObjectConfidence(self, node):
        if node is None or not node.IsA("vtkMRMLTransformNode"):
            return 0.0
        return 0.7

    def write(self, properties):
        import shutil

        import slicer

        filePath = str(properties["fileName"])
        if not filePath.lower().endswith(EXTENSIONS):
            return False   # another writer's business

        # Asked for before anything is caught: a package that is not there yet is installed by
        # the page, which then runs this again (see slicerweb.packages).
        import h5py  # noqa: F401

        textPath = companion_text_path(filePath)
        try:
            writeProperties = dict(properties)
            writeProperties["fileName"] = textPath
            messages = slicer.vtkMRMLMessageCollection()
            if not slicer.app.coreIOManager().saveNodes("TransformFile", writeProperties, messages):
                raise RuntimeError(messages.GetAllMessagesAsString() or "the transform could not be written")
            text_to_hdf5(textPath, filePath)
            self.parent.writtenNodes = [properties.get("nodeID", "")]
        except Exception as e:
            self.parent.userMessages().AddMessage(
                vtk.vtkCommand.ErrorEvent, f"Failed to write {os.path.basename(filePath)}: {e}")
            return False
        finally:
            shutil.rmtree(os.path.dirname(textPath), ignore_errors=True)
        return True


#: What a transform is saved as when nothing says otherwise. Slicer's own default is "h5"; here it
#: is the text format, which this build writes without h5py and which a desktop Slicer reads just
#: as well. A file the user names .h5 is still written as one, by the writer above.
DEFAULT_WRITE_EXTENSION = "tfm"

_observer = None


@vtk.calldata_type(vtk.VTK_OBJECT)
def _on_node_added(caller, event, node):
    """What a new node means here: a transform to be saved, and what it will be saved as."""
    if node is None:
        return
    if node.IsA("vtkMRMLTransformStorageNode"):
        node.SetDefaultWriteFileExtension(DEFAULT_WRITE_EXTENSION)
    elif node.IsA("vtkMRMLTransformNode"):
        # Saving it as .h5 needs h5py, and module code that names such a file - a self test, say -
        # cannot wait for it to be installed: the page fetches it now, while nothing needs it yet.
        from . import packages

        packages.ensure_in_background("h5py")


def _hdf5_file_of(node):
    """The HDF5 file a transform node was read from, if that is where it comes from."""
    if node is None or not node.IsA("vtkMRMLTransformNode"):
        return ""
    storage = node.GetStorageNode()
    filePath = (storage.GetFileName() or "") if storage is not None else ""
    if not filePath.lower().endswith(EXTENSIONS) or not os.path.exists(filePath):
        return ""
    return filePath


def read_scene_transforms(nodes):
    """Read the transforms of a scene that were left empty because their files are HDF5.

    A scene bundle written by desktop Slicer keeps its transforms in .h5 files, which the storage
    node cannot read here: the node comes out of the scene as the identity. Each one is transcoded
    and read again, which leaves the scene as it was saved.
    """
    import shutil

    hdf5 = [node for node in nodes or [] if _hdf5_file_of(node)]
    if hdf5 and not available():
        logger.error("%d transform(s) of this scene are in HDF5 files, which cannot be read until "
                     "h5py is installed", len(hdf5))
        return

    for node in hdf5:
        storage = node.GetStorageNode()
        filePath = storage.GetFileName()
        textPath = companion_text_path(filePath)
        try:
            hdf5_to_text(filePath, textPath)
            storage.SetFileName(textPath)
            if not storage.ReadData(node):
                raise RuntimeError("the storage node would not read it")
        except Exception:
            logger.exception("The transform in %s could not be read", os.path.basename(filePath))
        finally:
            storage.SetFileName(filePath)
            shutil.rmtree(os.path.dirname(textPath), ignore_errors=True)


def install():
    """Let the application read and write transforms in HDF5 files."""
    global _observer

    import slicer

    from . import io_scripted

    io_scripted.register_handlers(OWNER, HDF5TransformFileReader, HDF5TransformFileWriter)

    scene = slicer.mrmlScene
    if scene is not None and _observer is None:
        _observer = scene.AddObserver(slicer.vtkMRMLScene.NodeAddedEvent, _on_node_added)

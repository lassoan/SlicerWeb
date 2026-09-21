"""Which readers and writers the application has: the list kept by vtkSlicerFileIOManager.

In desktop Slicer this list lives in qSlicerCoreIOManager, a Qt class. Here it lives in a VTK
class of the same shape (SlicerWebCore/vtkSlicerFileIOManager.h), so that it can be used without
Qt - and so that Slicer core can take the same class later.

Two kinds of handler end up in it:

- the readers and writers of the application itself (io.FILE_TYPES), registered here at startup as
  plain descriptors: what they are called, which file types they are, which extensions they take.
  The reading and writing is done by :mod:`slicerweb.io`, as it was;
- the readers and writers of modules, written in Python, which a module declares by defining a
  class named ``<ModuleName>FileReader`` or ``<ModuleName>FileWriter`` beside its module class -
  the same convention as desktop Slicer, where qSlicerScriptedLoadableModule::registerIO picks
  them up. :mod:`slicerweb.io_scripted` finds them and calls them.

Whoever does the work is named in the handler's *owner*: "" for the application's own, and
"python:<ModuleName>" for a module's. That is how a handler is found again, and how everything a
module registered is taken away when it is reloaded.
"""

import logging
import os

import slicer
import vtk

logger = logging.getLogger("slicerweb.io")

APPLICATION_OWNER = ""


def manager():
    """The one file IO manager of the application (made when it is first asked for)."""
    application = slicer.app
    existing = getattr(application, "_fileIOManager", None)
    if existing is not None:
        return existing
    created = slicer.vtkSlicerFileIOManager()
    created.SetScene(application.mrmlScene())
    application._fileIOManager = created
    return created


def _string_array(values):
    array = vtk.vtkStringArray()
    for value in values:
        array.InsertNextValue(str(value))
    return array


def strings_of(array):
    """A vtkStringArray as a list of Python strings."""
    return [array.GetValue(i) for i in range(array.GetNumberOfValues())]


def name_filter(description, extensions):
    """A name filter as Slicer writes them: ``Mimics project (*.mcs *.mcs.gz)``."""
    patterns = " ".join("*" + extension for extension in extensions)
    return f"{description} ({patterns})"


def register_reader(fileType, description, extensions=(), owner=APPLICATION_OWNER,
                    confidence=0.5, nameFilters=None):
    """Add a reader to the list and return it."""
    reader = slicer.vtkSlicerFileReader()
    reader.SetFileType(fileType)
    reader.SetDescription(description or fileType)
    reader.SetOwner(owner)
    reader.SetConfidenceForMatchingExtension(float(confidence))
    reader.SetNameFilters(_string_array(nameFilters if nameFilters is not None
                                        else [name_filter(description or fileType, extensions)]))
    manager().RegisterReader(reader)
    return reader


def register_writer(fileType, description, extensions=(), owner=APPLICATION_OWNER,
                    nodeClassName=None, confidence=0.5, nameFilters=None):
    """Add a writer to the list and return it."""
    writer = slicer.vtkSlicerFileWriter()
    writer.SetFileType(fileType)
    writer.SetDescription(description or fileType)
    writer.SetOwner(owner)
    writer.SetConfidenceForMatchingClass(float(confidence))
    if nodeClassName:
        writer.SetNodeClassName(nodeClassName)
    writer.SetNameFilters(_string_array(nameFilters if nameFilters is not None
                                        else [name_filter(description or fileType, extensions)]))
    manager().RegisterWriter(writer)
    return writer


def unregister_owner(owner):
    """Take away everything that *owner* registered (a module that is being reloaded)."""
    manager().UnregisterOwner(owner)


def readers_for_file(filePath):
    """The readers worth asking about this file, the surest of the ones that answered first.

    The manager ranks what it can judge for itself (an extension it knows). A reader of a module
    judges for itself in Python - it may look inside the file - so it is added here even where the
    manager passed it over, and the caller asks it (see io.IOManager.readerForFile).
    """
    readers = vtk.vtkCollection()
    registry = manager()
    registry.GetReadersForFile(str(filePath), readers)
    found = [readers.GetItemAsObject(i) for i in range(readers.GetNumberOfItems())]
    for i in range(registry.GetNumberOfReaders()):
        reader = registry.GetNthReader(i)
        if reader.GetOwner() and reader not in found:
            found.append(reader)
    return found


def writers_for_node(node):
    """The writers worth asking about this node, the surest of the ones that answered first.

    As with the readers: the manager ranks a writer that named the class of node it writes, and a
    writer of a module - which decides in Python, by what the node holds - is added here.
    """
    writers = vtk.vtkCollection()
    registry = manager()
    registry.GetWritersForObject(node, writers)
    found = [writers.GetItemAsObject(i) for i in range(writers.GetNumberOfItems())]
    for i in range(registry.GetNumberOfWriters()):
        writer = registry.GetNthWriter(i)
        if writer.GetOwner() and writer not in found:
            found.append(writer)
    return found


def file_type_for_file(filePath):
    """The file type of the reader that is surest it can read this file ("" if there is none)."""
    return manager().GetFileTypeForFile(str(filePath))


def extensions_for_file_type(fileType, writers=False):
    extensions = vtk.vtkStringArray()
    manager().GetExtensionsForFileType(fileType, writers, extensions)
    return strings_of(extensions)


def name_filters_for_file_type(fileType, writers=False):
    filters = vtk.vtkStringArray()
    manager().GetNameFiltersForFileType(fileType, writers, filters)
    return strings_of(filters)


def file_types(writers=False):
    types = vtk.vtkStringArray()
    if writers:
        manager().GetWriterFileTypes(types)
    else:
        manager().GetReaderFileTypes(types)
    return strings_of(types)


def description_for_file_type(fileType, writers=False):
    return manager().GetDescriptionForFileType(fileType, writers)


def register_application_handlers(fileTypes, writerDescriptions):
    """Put the readers and writers of the application itself in the list.

    :param fileTypes: ``[(fileType, [extension, ...]), ...]`` in the order they are preferred.
    :param writerDescriptions: ``{fileType: description}``.
    """
    unregister_owner(APPLICATION_OWNER)
    # The list is tried in order, and the first match wins, as io.FILE_TYPES always did; a later
    # entry is therefore registered as slightly less sure of itself than the one before it.
    confidence = 0.6
    for fileType, extensions in fileTypes:
        description = writerDescriptions.get(fileType, fileType)
        register_reader(fileType, description, extensions, confidence=confidence)
        register_writer(fileType, description, extensions, confidence=confidence,
                        nodeClassName=_NODE_CLASS_FOR_FILE_TYPE.get(fileType))
        confidence = max(0.05, confidence - 0.01)
    logger.debug("Registered %d readers of the application", manager().GetNumberOfReaders())


#: What each file type of the application writes, for the writer list (qSlicerNodeWriter).
_NODE_CLASS_FOR_FILE_TYPE = {
    "VolumeFile": "vtkMRMLVolumeNode",
    "ModelFile": "vtkMRMLModelNode",
    "SegmentationFile": "vtkMRMLSegmentationNode",
    "MarkupsFile": "vtkMRMLMarkupsNode",
    "TransformFile": "vtkMRMLTransformNode",
    "ColorTableFile": "vtkMRMLColorTableNode",
    "TableFile": "vtkMRMLTableNode",
    "TextFile": "vtkMRMLTextNode",
    "SequenceFile": "vtkMRMLSequenceNode",
}


def properties_from_dict(values):
    """A vtkSlicerIOProperties from a Python dictionary (for a reader written in C++)."""
    properties = slicer.vtkSlicerIOProperties()
    for name, value in (values or {}).items():
        if isinstance(value, bool):
            properties.SetBoolProperty(str(name), value)
        elif isinstance(value, int):
            properties.SetIntProperty(str(name), value)
        elif isinstance(value, float):
            properties.SetDoubleProperty(str(name), value)
        else:
            properties.SetStringProperty(str(name), str(value))
    return properties


def describe():
    """What is registered, for the log and for tests."""
    lines = []
    registry = manager()
    for i in range(registry.GetNumberOfReaders()):
        reader = registry.GetNthReader(i)
        lines.append("reader %s (%s) %s%s" % (
            reader.GetFileType(), reader.GetDescription(),
            strings_of_extensions(reader),
            " [%s]" % reader.GetOwner() if reader.GetOwner() else ""))
    for i in range(registry.GetNumberOfWriters()):
        writer = registry.GetNthWriter(i)
        lines.append("writer %s (%s) %s%s" % (
            writer.GetFileType(), writer.GetDescription(),
            strings_of_extensions(writer),
            " [%s]" % writer.GetOwner() if writer.GetOwner() else ""))
    return lines


def strings_of_name_filters(handler):
    """The name filters of a handler, as a list of strings."""
    filters = vtk.vtkStringArray()
    handler.GetNameFilters(filters)
    return strings_of(filters)


def strings_of_extensions(handler):
    extensions = vtk.vtkStringArray()
    handler.GetExtensions(extensions)
    return strings_of(extensions)


def lower_extension(filePath, knownExtensions):
    """The longest known extension the file name ends in (".seg.nrrd" rather than ".nrrd")."""
    name = os.path.basename(str(filePath)).lower()
    matched = ""
    for extension in knownExtensions:
        if name.endswith(extension) and len(extension) > len(matched):
            matched = extension
    return matched

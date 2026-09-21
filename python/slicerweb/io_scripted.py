"""The readers and writers that modules bring with them, written in Python.

A module declares one by defining a class beside its module class, named after the module:
``ImportMimicsFileReader`` in ImportMimics.py, ``FooFileWriter`` in Foo.py. Desktop Slicer picks
those up in qSlicerScriptedLoadableModule::registerIO, wraps each in a C++ class
(qSlicerScriptedFileReader) and hands it to qSlicerCoreIOManager. The same happens here, with the
wrapper being a vtkSlicerFileReader and the list being vtkSlicerFileIOManager
(see :mod:`slicerweb.io_registry`).

What a module's class has to provide is unchanged, so that a module written for the desktop needs
no change to work here:

    class <Module>FileReader:
        def __init__(self, parent): ...
        def description(self): ...            # "Materialise Mimics/3-matic project"
        def fileType(self): ...               # "MimicsProject"
        def extensions(self): ...             # ["Materialise ... project (*.mcs *.mxp)"]
        def canLoadFileConfidence(self, filePath): ...    # optional
        def canLoadFile(self, filePath): ...              # optional
        def load(self, properties): ...       # True if it read something
        # and it says what it read with: self.parent.loadedNodes = [nodeID, ...]

    class <Module>FileWriter:
        def description / fileType / extensions(obj) / canWriteObjectConfidence(obj) / write(properties)
        # and: self.parent.writtenNodes = [nodeID, ...]

``parent`` is the handler in the list: :class:`ScriptedIOParent` below, which answers the few
things those classes ask of it - ``userMessages()``, ``supportedNameFilters()``, ``loadedNodes``,
``writtenNodes`` - and keeps the C++ handler underneath in step.
"""

import logging

import slicer
import vtk

from . import io_registry

logger = logging.getLogger("slicerweb.io")

#: Python readers and writers of modules, by the name of the handler in the list.
_handlers = {}


def owner_of(moduleName):
    """What a module's handlers are registered under."""
    return "python:" + moduleName


class ScriptedIOParent:
    """What a module's reader or writer calls ``self.parent``.

    It stands for the C++ handler - in desktop Slicer a qSlicerScriptedFileReader, here a
    vtkSlicerFileReader - and offers what those classes use of it.
    """

    def __init__(self, handler):
        self.handler = handler

    # --- what a reader or writer says about itself, kept on the handler
    @property
    def loadedNodes(self):
        return io_registry.strings_of(self.handler.GetLoadedNodeIDs())

    @loadedNodes.setter
    def loadedNodes(self, nodeIDs):
        self.handler.ClearLoadedNodeIDs()
        for nodeID in nodeIDs or []:
            self.handler.AddLoadedNodeID(str(nodeID))

    @property
    def writtenNodes(self):
        return io_registry.strings_of(self.handler.GetWrittenNodeIDs())

    @writtenNodes.setter
    def writtenNodes(self, nodeIDs):
        self.handler.ClearWrittenNodeIDs()
        for nodeID in nodeIDs or []:
            self.handler.AddWrittenNodeID(str(nodeID))

    def userMessages(self):
        """Messages for the user about the last read or write (a vtkMRMLMessageCollection)."""
        return self.handler.GetUserMessages()

    def supportedNameFilters(self, filePath):
        """The name filters of this handler that the file name matches (qSlicerFileReader)."""
        extension = self.handler.GetMatchedExtension(str(filePath))
        if not extension:
            return []
        return [f for f in io_registry.strings_of_name_filters(self.handler) if extension in f.lower()]

    def scene(self):
        return slicer.mrmlScene

    def mrmlScene(self):
        return slicer.mrmlScene


def register_module_handlers(moduleName, moduleNamespace):
    """Register the reader and writer a module brings, if it has any. Returns their names."""
    unregister_module_handlers(moduleName)
    registered = []
    for suffix, register in (("FileReader", _register_reader), ("FileWriter", _register_writer)):
        cls = getattr(moduleNamespace, moduleName + suffix, None)
        if cls is None:
            continue
        try:
            registered.append(register(owner_of(moduleName), cls))
        except Exception:
            logger.exception("The %s of module %s could not be registered", suffix, moduleName)
    return registered


def register_handlers(owner, readerClass=None, writerClass=None):
    """Register a reader and a writer written in Python that are not a module's.

    The application has a few of its own - the transforms kept in HDF5 files, for one - and they
    are written the same way a module's are, with the same methods; *owner* says whose they are,
    so that they can be found again and taken away together.
    """
    io_registry.unregister_owner(owner)
    for key in [k for k, v in _handlers.items() if v[0] == owner]:
        del _handlers[key]
    registered = []
    if readerClass is not None:
        registered.append(_register_reader(owner, readerClass))
    if writerClass is not None:
        registered.append(_register_writer(owner, writerClass))
    return registered


def unregister_module_handlers(moduleName):
    """Take away what a module registered (it is being reloaded, or taken out)."""
    owner = owner_of(moduleName)
    io_registry.unregister_owner(owner)
    for key in [k for k, v in _handlers.items() if v[0] == owner]:
        del _handlers[key]


def _handler_key(handler):
    # A module's reader and its writer are both "python:<Module>" and the same file type, so which
    # of the two it is belongs in the key as well.
    return "%s|%s|%s" % (handler.GetOwner(), handler.GetFileType(),
                         "writer" if handler.IsWriter() else "reader")


def _register_reader(owner, cls):
    handler = slicer.vtkSlicerFileReader()
    parent = ScriptedIOParent(handler)
    instance = cls(parent)
    handler.SetOwner(owner)
    handler.SetFileType(str(instance.fileType()))
    handler.SetDescription(str(instance.description()))
    handler.SetNameFilters(_filters_of(instance.extensions()))
    io_registry.manager().RegisterReader(handler)
    _handlers[_handler_key(handler)] = (handler.GetOwner(), instance, parent)
    logger.info("%s reads %s (%s)", owner, handler.GetFileType(),
                ", ".join(io_registry.strings_of_extensions(handler)))
    return handler.GetFileType()


def _register_writer(owner, cls):
    handler = slicer.vtkSlicerFileWriter()
    parent = ScriptedIOParent(handler)
    instance = cls(parent)
    handler.SetOwner(owner)
    handler.SetFileType(str(instance.fileType()))
    handler.SetDescription(str(instance.description()))
    # A writer's extensions depend on what is being written; with nothing in hand it is asked
    # without a node, which is what qSlicerScriptedFileWriter does to fill the file dialog.
    try:
        handler.SetNameFilters(_filters_of(instance.extensions(None)))
    except Exception:
        logger.debug("The writer of %s named no extensions without a node", owner, exc_info=True)
    io_registry.manager().RegisterWriter(handler)
    _handlers[_handler_key(handler)] = (handler.GetOwner(), instance, parent)
    logger.info("%s writes %s", owner, handler.GetFileType())
    return handler.GetFileType()


def _filters_of(extensions):
    filters = vtk.vtkStringArray()
    for extension in extensions or []:
        filters.InsertNextValue(str(extension))
    return filters


def implementation(handler):
    """The Python object that does the work for a handler, or None."""
    found = _handlers.get(_handler_key(handler))
    return found[1] if found else None


def confidence_for_file(handler, filePath):
    """How sure a module's reader is that it can read this file."""
    reader = implementation(handler)
    if reader is None:
        return 0.0
    if hasattr(reader, "canLoadFileConfidence"):
        return float(reader.canLoadFileConfidence(str(filePath)))
    if hasattr(reader, "canLoadFile"):
        return 0.6 if reader.canLoadFile(str(filePath)) else 0.0
    return handler.CanLoadFileConfidence(str(filePath))


def confidence_for_node(handler, node):
    """How sure a module's writer is that it can write this node."""
    writer = implementation(handler)
    if writer is None:
        return 0.0
    if hasattr(writer, "canWriteObjectConfidence"):
        return float(writer.canWriteObjectConfidence(node))
    if hasattr(writer, "canWriteObject"):
        return 0.6 if writer.canWriteObject(node) else 0.0
    return 0.0


def load(handler, properties):
    """Read a file with a module's reader. Returns the node IDs it loaded."""
    reader = implementation(handler)
    if reader is None:
        raise RuntimeError("No module reads %s any more" % handler.GetFileType())
    handler.ClearLoadedNodeIDs()
    handler.GetUserMessages().ClearMessages()
    if not reader.load(dict(properties)):
        raise RuntimeError(_message_text(handler) or "The module could not read the file")
    return io_registry.strings_of(handler.GetLoadedNodeIDs())


def write(handler, properties):
    """Write a node with a module's writer. Returns the node IDs it wrote."""
    writer = implementation(handler)
    if writer is None:
        raise RuntimeError("No module writes %s any more" % handler.GetFileType())
    handler.ClearWrittenNodeIDs()
    handler.GetUserMessages().ClearMessages()
    if not writer.write(dict(properties)):
        raise RuntimeError(_message_text(handler) or "The module could not write the file")
    return io_registry.strings_of(handler.GetWrittenNodeIDs())


def _message_text(handler):
    """What the handler told the user about the last read or write, as one string."""
    messages = handler.GetUserMessages()
    return messages.GetAllMessagesAsString() if messages is not None else ""

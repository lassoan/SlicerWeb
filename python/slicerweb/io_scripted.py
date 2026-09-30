"""The readers and writers that modules bring with them, written in Python.

A module declares one by defining a class beside its module class, named after the module:
``ImportMimicsFileReader`` in ImportMimics.py, ``FooFileWriter`` in Foo.py. Slicer core turns
such a class into a reader or writer of its file IO manager (``slicer.ScriptedFileIO``): a subclass
of ``slicer.vtkSlicerScriptedFileReader`` is used as it is, and a class written the older way -
``description()``, ``fileType()``, ``extensions()``, ``load(properties)`` and ``self.parent`` - is
wrapped in ``LegacyScriptedFileReader``. This is what qSlicerScriptedLoadableModule does on the
desktop, and it is done the same way here, with the file IO manager of the application logic.

What is added here is for packages: a reader that needs a package that is not installed yet raises
ModuleNotFoundError, which the page answers by installing it and running the call again (see
:mod:`slicerweb.packages`). The reader is called from C++, which logs an exception and carries on,
so the error is kept here instead, and raised again once the call is back in Python
(:func:`raise_missing_module`).
"""

import logging
import traceback

logger = logging.getLogger("slicerweb.io")

#: The ModuleNotFoundError that a reader or writer raised during the current call, if any.
_missing_module = None

#: The readers and writers each module registered, by module name, so that they can be taken away.
_module_handlers = {}


def clear_missing_module():
    global _missing_module
    _missing_module = None


def raise_missing_module():
    """Raise the ModuleNotFoundError a reader or writer raised since clear_missing_module()."""
    global _missing_module
    error, _missing_module = _missing_module, None
    if error is not None:
        raise error


def _record_missing_module(error):
    global _missing_module
    if _missing_module is None:
        _missing_module = error


def _guarded(method):
    """A method that records a missing package, and otherwise raises what it raised."""

    def call(self, *args):
        try:
            return method(self, *args)
        except ModuleNotFoundError as error:
            _record_missing_module(error)
            raise

    call.__name__ = method.__name__
    call.__doc__ = method.__doc__
    return call


def _legacy_adapter(base):
    """A legacy reader or writer adapter that records a missing package the legacy class needs."""

    class Adapter(base):
        def _callLegacy(self, methodName, *args, errorResult=None):
            try:
                return getattr(self._legacy, methodName)(*args)
            except ModuleNotFoundError as error:
                _record_missing_module(error)
            except SystemExit:
                logging.warning(f"SystemExit raised in {self._legacyClassName}.{methodName} was ignored")
            except Exception:
                logging.error(f"{self._legacyClassName}.{methodName} failed:\n{traceback.format_exc()}")
            return errorResult

    Adapter.__name__ = base.__name__
    return Adapter


def create_reader(readerClass):
    """A reader of the file IO manager from a Python class (slicer.ScriptedFileIO.createScriptedFileReader)."""
    from slicer.ScriptedFileIO import LegacyScriptedFileReader, vtkSlicerScriptedFileReader

    if isinstance(readerClass, type) and issubclass(readerClass, vtkSlicerScriptedFileReader):
        # The bridge calls the methods that the class itself defines: a subclass that defines Load
        # is what makes it record a missing package.
        guarded = type(readerClass.__name__, (readerClass,), {"Load": _guarded(readerClass.Load)})
        return guarded()
    return _legacy_adapter(LegacyScriptedFileReader)(readerClass)


def create_writer(writerClass):
    """A writer of the file IO manager from a Python class (slicer.ScriptedFileIO.createScriptedFileWriter)."""
    from slicer.ScriptedFileIO import LegacyScriptedFileWriter, vtkSlicerScriptedFileWriter

    if isinstance(writerClass, type) and issubclass(writerClass, vtkSlicerScriptedFileWriter):
        guarded = type(writerClass.__name__, (writerClass,), {"Write": _guarded(writerClass.Write)})
        return guarded()
    return _legacy_adapter(LegacyScriptedFileWriter)(writerClass)


def file_io_manager():
    import slicer

    return slicer.app.applicationLogic().GetFileIOManager()


def register_module_handlers(moduleName, moduleNamespace):
    """Register the reader and writer a module brings, if it has any. Returns them.

    Same as slicer.ScriptedFileIO.registerScriptedFileIO, with the readers and writers made here.
    """
    unregister_module_handlers(moduleName)
    manager = file_io_manager()
    registered = []
    for suffix, create, register in (("FileWriter", create_writer, manager.RegisterWriter),
                                     ("FileReader", create_reader, manager.RegisterReader)):
        className = moduleName if moduleName.endswith(suffix) else moduleName + suffix
        handlerClass = getattr(moduleNamespace, className, None)
        if handlerClass is None:
            continue
        try:
            handler = create(handlerClass)
        except Exception:
            logger.exception("The %s of module %s could not be created", className, moduleName)
            continue
        register(handler)
        registered.append(handler)
        logger.info("%s %s %s", moduleName, "writes" if handler.IsWriter() else "reads", handler.GetFileType())
    _module_handlers[moduleName] = registered
    return registered


def unregister_module_handlers(moduleName):
    """Take away what a module registered (it is being reloaded, or taken out)."""
    manager = file_io_manager()
    for handler in _module_handlers.pop(moduleName, []):
        manager.UnregisterHandler(handler)

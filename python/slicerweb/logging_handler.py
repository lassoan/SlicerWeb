"""Route Python logging and VTK messages to the error log panel of the web page."""

import logging
import time

from . import host

_error_log = None


class ErrorLog:
    """Subset of ctkErrorLogModel: keeps recent messages; the web page displays them."""

    def __init__(self, maxEntries=2000):
        self.entries = []
        self.maxEntries = maxEntries

    def add(self, level, message, origin="Python"):
        entry = {"time": time.time(), "level": level, "origin": origin, "message": message}
        self.entries.append(entry)
        if len(self.entries) > self.maxEntries:
            del self.entries[: len(self.entries) - self.maxEntries]
        host.emit("log", entry)

    def clear(self):
        self.entries = []

    # ctkErrorLogModel compatible methods
    def setTerminalOutputs(self, *args):
        pass

    def logEntryCount(self):
        return len(self.entries)


class _Handler(logging.Handler):
    def emit(self, record):
        try:
            error_log().add(record.levelname, self.format(record), "Python")
        except Exception:  # pragma: no cover
            pass


def error_log():
    global _error_log
    if _error_log is None:
        _error_log = ErrorLog()
    return _error_log


def install():
    root = logging.getLogger()
    if not any(isinstance(h, _Handler) for h in root.handlers):
        root.addHandler(_Handler())
    if root.level == logging.NOTSET or root.level > logging.INFO:
        root.setLevel(logging.INFO)
    _install_vtk_output_window()


def _install_vtk_output_window():
    """Forward VTK error and warning messages (vtkOutputWindow) to the error log."""
    import vtk

    ow = vtk.vtkOutputWindow.GetInstance()

    def make_callback(level):
        def callback(caller, event, calldata=None):
            error_log().add(level, str(calldata).strip(), "VTK")

        callback.CallDataType = vtk.VTK_STRING
        return callback

    ow.AddObserver(vtk.vtkCommand.ErrorEvent, make_callback("ERROR"))
    ow.AddObserver(vtk.vtkCommand.WarningEvent, make_callback("WARNING"))

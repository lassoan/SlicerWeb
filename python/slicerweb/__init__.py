"""SlicerWeb runtime: 3D Slicer application services running in the web browser (Pyodide).

This package provides the Qt-free equivalents of the application-level objects of desktop Slicer
(``qSlicerApplication``, ``qSlicerLayoutManager``, ``qSlicerModuleManager``, ``qSlicerIOManager``),
built on the same C++ MRML/logic/displayable manager libraries and the same ``slicer`` Python package.

Typical use (done by the web application at startup)::

    import slicerweb
    app = slicerweb.initialize({"layout": "FourUp"})
    slicer.util.loadVolume("/data/MRHead.nrrd")
"""

from .version import __version__  # noqa: F401

_application = None


def initialize(config=None):
    """Create the application singleton and set up ``slicer.app``, ``slicer.mrmlScene``, modules.

    :param config: optional dict, see :class:`slicerweb.app.SlicerWebApplication`.
    :return: the :class:`slicerweb.app.SlicerWebApplication` instance.
    """
    global _application
    if _application is None:
        from .app import SlicerWebApplication

        _application = SlicerWebApplication(config or {})
        _application.startup()
    return _application


def application():
    """Return the application singleton (``None`` before :func:`initialize`)."""
    return _application

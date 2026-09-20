"""SlicerWeb runtime: 3D Slicer application services running in the web browser (Pyodide).

This package provides the Qt-free equivalents of the application-level objects of desktop Slicer
(``qSlicerApplication``, ``qSlicerLayoutManager``, ``qSlicerModuleManager``, ``qSlicerIOManager``),
built on the same C++ MRML/logic/displayable manager libraries and the same ``slicer`` Python package.

Typical use (done by the web application at startup)::

    import slicerweb
    app = slicerweb.initialize({"layout": "FourUp"})
    slicer.util.loadVolume("/data/MRHead.nrrd")
"""

import logging
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
        logging.getLogger("slicerweb").info("SlicerWeb Python build %s", buildTime() or "unknown")
    return _application


def application():
    """Return the application singleton (``None`` before :func:`initialize`)."""
    return _application


def buildTime():
    """When the Python code running in this page was built, or "" if it is not known.

    The wheel keeps its name from build to build, so this is what tells which code a page is running
    (a browser or a cache in front of the site may still hold an earlier one).
    """
    try:
        from ._build import BUILD_TIME
    except ImportError:
        return ""
    return BUILD_TIME

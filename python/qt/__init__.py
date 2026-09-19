"""Qt API for Slicer Python code running in the browser (see slicerweb.qtcompat)."""

from slicerweb.qtcompat import QT_NAMESPACE as _NS

globals().update(_NS)
__all__ = sorted(_NS)

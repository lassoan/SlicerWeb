"""PythonQt for Slicer Python code running in the browser (see slicerweb.qtcompat).

On the desktop, ``qt`` gathers the classes of PythonQt's modules into one, and code may also take
them from those modules (``from PythonQt import QtCore``). Here every one of them is the same
namespace as ``qt``.
"""

import qt as _qt

QtCore = QtGui = QtWidgets = QtNetwork = QtXml = QtSvg = QtUiTools = QtMultimedia = QtSql = QtOpenGL = _qt
Qt = _qt

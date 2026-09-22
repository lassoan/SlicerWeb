"""Qt value types, utilities and namespaces used by Slicer Python code."""

import logging
import datetime
import os

from . import dom
from .core import QObject, QProp, Signal

logger = logging.getLogger("slicerweb.qt")


class _Enum(int):
    pass


class Qt:
    # check states
    Unchecked, PartiallyChecked, Checked = 0, 1, 2
    # alignment
    AlignLeft, AlignRight, AlignHCenter, AlignJustify = 0x1, 0x2, 0x4, 0x8
    AlignTop, AlignBottom, AlignVCenter, AlignCenter = 0x20, 0x40, 0x80, 0x84
    # orientation
    Horizontal, Vertical = 1, 2
    # item data roles
    DisplayRole, DecorationRole, EditRole, ToolTipRole, UserRole = 0, 1, 2, 3, 256
    CheckStateRole = 10
    # keyboard modifiers and keys
    NoModifier, ShiftModifier, ControlModifier, AltModifier = 0, 0x02000000, 0x04000000, 0x08000000
    Key_Escape, Key_Return, Key_Enter, Key_Delete, Key_Space = 0x01000000, 0x01000004, 0x01000005, 0x01000007, 0x20
    # misc
    ScrollBarAlwaysOff, ScrollBarAsNeeded, ScrollBarAlwaysOn = 1, 0, 2
    ToolButtonIconOnly, ToolButtonTextOnly, ToolButtonTextBesideIcon, ToolButtonTextUnderIcon = 0, 1, 2, 3
    CustomContextMenu, NoContextMenu = 3, 0
    ElideRight, ElideLeft, ElideMiddle = 1, 0, 2
    RichText, PlainText, AutoText = 1, 0, 2
    TextSelectableByMouse = 1
    ItemIsEnabled, ItemIsSelectable, ItemIsEditable, ItemIsUserCheckable = 32, 1, 2, 16
    # cursor shapes (Qt::CursorShape), with the ones a module is likely to ask for
    ArrowCursor, UpArrowCursor, CrossCursor, WaitCursor, IBeamCursor = 0, 1, 2, 3, 4
    SizeVerCursor, SizeHorCursor, SizeBDiagCursor, SizeFDiagCursor, SizeAllCursor = 5, 6, 7, 8, 9
    BlankCursor, SplitVCursor, SplitHCursor, PointingHandCursor, ForbiddenCursor = 10, 11, 12, 13, 14
    WhatsThisCursor, BusyCursor, OpenHandCursor, ClosedHandCursor = 15, 16, 17, 18
    WA_DeleteOnClose = 55
    NoFocus, StrongFocus = 0, 11
    red, green, blue, black, white, gray, yellow, cyan, magenta = range(7, 16)
    AscendingOrder, DescendingOrder = 0, 1
    MatchExactly, MatchContains = 0, 1


class QSizePolicy:
    Fixed, Minimum, Maximum, Preferred, Expanding, MinimumExpanding, Ignored = 0, 1, 4, 5, 7, 3, 13

    def __init__(self, horizontal=Preferred, vertical=Preferred, *args):
        self._horizontal, self._vertical = horizontal, vertical

    def setHorizontalPolicy(self, policy):
        self._horizontal = policy

    def horizontalPolicy(self):
        return self._horizontal

    def setVerticalPolicy(self, policy):
        self._vertical = policy

    def verticalPolicy(self):
        return self._vertical

    def setHorizontalStretch(self, v):
        pass

    def setVerticalStretch(self, v):
        pass

    def setHeightForWidth(self, v):
        pass

    def hasHeightForWidth(self):
        return False


class QSize:
    def __init__(self, w=0, h=0):
        self._w, self._h = w, h

    def width(self):
        return self._w

    def height(self):
        return self._h

    def __call__(self):
        # Qt property in PythonQt (widget.sizeHint), also called as a getter (widget.sizeHint())
        return self

class QRect:
    def __init__(self, x=0, y=0, w=0, h=0):
        self._x, self._y, self._w, self._h = x, y, w, h

    def x(self):
        return self._x

    def y(self):
        return self._y

    def width(self):
        return self._w

    def height(self):
        return self._h

    def size(self):
        return QSize(self._w, self._h)

    def __call__(self):
        # a Qt property read as a getter, as PythonQt allows (screen.availableGeometry())
        return self


class QPoint:
    def __init__(self, x=0, y=0):
        self._x, self._y = x, y

    def x(self):
        return self._x

    def y(self):
        return self._y


class QColor:
    def __init__(self, *args):
        self._rgba = [0, 0, 0, 255]
        if len(args) == 1 and isinstance(args[0], str):
            self.setNamedColor(args[0])
        elif len(args) == 1 and isinstance(args[0], QColor):
            self._rgba = list(args[0]._rgba)
        elif len(args) >= 3:
            self._rgba = [int(args[0]), int(args[1]), int(args[2]), int(args[3]) if len(args) > 3 else 255]

    @staticmethod
    def fromRgbF(r, g, b, a=1.0):
        return QColor(round(r * 255), round(g * 255), round(b * 255), round(a * 255))

    @staticmethod
    def fromRgb(r, g, b, a=255):
        return QColor(r, g, b, a)

    def setNamedColor(self, name):
        names = {"red": "#ff0000", "green": "#00ff00", "blue": "#0000ff", "black": "#000000", "white": "#ffffff",
                 "gray": "#808080", "yellow": "#ffff00"}
        name = names.get(name, name).lstrip("#")
        if len(name) >= 6:
            self._rgba = [int(name[0:2], 16), int(name[2:4], 16), int(name[4:6], 16), 255]

    def name(self):
        return "#%02x%02x%02x" % tuple(self._rgba[:3])

    def red(self):
        return self._rgba[0]

    def green(self):
        return self._rgba[1]

    def blue(self):
        return self._rgba[2]

    def alpha(self):
        return self._rgba[3]

    def redF(self):
        return self._rgba[0] / 255.0

    def greenF(self):
        return self._rgba[1] / 255.0

    def blueF(self):
        return self._rgba[2] / 255.0

    def alphaF(self):
        return self._rgba[3] / 255.0

    def getRgbF(self):
        return (self.redF(), self.greenF(), self.blueF(), self.alphaF())

    def isValid(self):
        return True

    def __eq__(self, other):
        return isinstance(other, QColor) and other._rgba == self._rgba


class QIcon:
    Normal, Disabled, Active, Selected = 0, 1, 2, 3
    Off, On = 1, 0

    def __init__(self, *args):
        self._path = args[0] if args and isinstance(args[0], str) else None

    def isNull(self):
        return self._path is None

    def addFile(self, *args):
        pass

    def pixmap(self, *args):
        return QPixmap()


class QPixmap:
    def __init__(self, *args):
        pass

    def isNull(self):
        return True

    def scaled(self, *args):
        return self


class QFont:
    Bold, Normal = 75, 50

    def __init__(self, *args):
        pass

    def setBold(self, v):
        pass

    def setPointSize(self, v):
        pass

    def setFamily(self, f):
        pass

    def setItalic(self, v):
        pass

    def pointSize(self):
        return 10


class QKeySequence:
    def __init__(self, *args):
        self._text = args[0] if args else ""

    def toString(self):
        return str(self._text)


class QAction(QObject):
    triggered = Signal("triggered(bool)")
    toggled = Signal("toggled(bool)")

    text = QProp("", convert=str)
    checkable = QProp(False)
    checked = QProp(False)
    enabled = QProp(True)
    visible = QProp(True)
    toolTip = QProp("")

    def __init__(self, *args):
        parent = next((a for a in args if isinstance(a, QObject)), None)
        super().__init__(parent)
        texts = [a for a in args if isinstance(a, str)]
        if texts:
            self.text = texts[0]

    def trigger(self):
        if self.checkable:
            self.checked = not self.checked
            self.toggled.emit(self.checked)
        self.triggered.emit(self.checked)

    def setText(self, t):
        self.text = t

    def setCheckable(self, v):
        self.checkable = v

    def setChecked(self, v):
        self.checked = v

    def isChecked(self):
        return self.checked

    def setEnabled(self, v):
        self.enabled = v

    def setVisible(self, v):
        self.visible = v

    def setIcon(self, icon):
        pass

    def setShortcut(self, s):
        pass

    def setToolTip(self, t):
        self.toolTip = t

    def setData(self, d):
        self._data = d

    def data(self):
        return getattr(self, "_data", None)


class QShortcut(QObject):
    activated = Signal("activated()")

    def __init__(self, *args):
        super().__init__(None)

    def setKey(self, key):
        pass


class QTimer(QObject):
    timeout = Signal("timeout()")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._interval = 0
        self._singleShot = False
        self._handle = None
        self._proxy = None
        self._active = False

    @staticmethod
    def singleShot(msec, *args):
        callback = args[-1]
        if not callable(callback):
            logger.warning("QTimer.singleShot: unsupported arguments")
            return
        dom.set_timeout(callback, msec)

    def setInterval(self, msec):
        self._interval = int(msec)

    def interval(self):
        return self._interval

    def setSingleShot(self, v):
        self._singleShot = bool(v)

    def isSingleShot(self):
        return self._singleShot

    def isActive(self):
        return self._active

    def start(self, msec=None):
        if msec is not None:
            self._interval = int(msec)
        self.stop()
        self._active = True
        if self._singleShot:
            def fire():
                if self._active:
                    self._active = False
                    self.timeout.emit()

            dom.set_timeout(fire, self._interval)
        else:
            self._handle, self._proxy = dom.set_interval(lambda: self.timeout.emit(), max(1, self._interval))

    def stop(self):
        self._active = False
        if self._handle:
            dom.clear_interval(self._handle)
            self._handle = None


class QSettings(QObject):
    """QSettings backed by the application settings store (persisted in the browser)."""

    IniFormat, NativeFormat = 1, 0

    def __init__(self, *args):
        super().__init__(None)
        try:
            import slicer

            app = getattr(slicer, "app", None)
        except ImportError:
            app = None
        self._store = app.userSettings() if app is not None else None
        self._fallback = {}

    def _s(self):
        return self._store

    def value(self, key, defaultValue=None, *args):
        if self._store is None:
            return self._fallback.get(key, defaultValue)
        return self._store.value(key, defaultValue)

    def setValue(self, key, value):
        if self._store is None:
            self._fallback[key] = value
        else:
            self._store.setValue(key, value)

    def contains(self, key):
        return key in self._fallback if self._store is None else self._store.contains(key)

    def remove(self, key):
        if self._store is not None:
            self._store.remove(key)

    def beginGroup(self, g):
        if self._store is not None:
            self._store.beginGroup(g)

    def endGroup(self):
        if self._store is not None:
            self._store.endGroup()

    def allKeys(self):
        return [] if self._store is None else self._store.allKeys()

    def childKeys(self):
        return [] if self._store is None else self._store.childKeys()

    def sync(self):
        if self._store is not None:
            self._store.sync()

    def fileName(self):
        return "" if self._store is None else self._store.fileName()


class QFile:
    ReadOnly, WriteOnly, ReadWrite, Text = 1, 2, 3, 16

    def __init__(self, path):
        self._path = str(path)
        self._handle = None

    def exists(self):
        return os.path.exists(self._path)

    def open(self, mode):
        self._mode = mode
        return self.exists() or bool(mode & QFile.WriteOnly)

    def readAll(self):
        with open(self._path, "rb") as f:
            return f.read()

    def close(self):
        pass

    def fileName(self):
        return self._path


class QFileInfo:
    def __init__(self, path, name=None):
        """QFileInfo(path) or QFileInfo(dir, name), as slicer.util.tempDirectory() builds it."""
        if name is not None:
            directory = path.absolutePath() if hasattr(path, "absolutePath") else str(path)
            path = os.path.join(directory, str(name))
        self._path = str(path)

    def exists(self):
        return os.path.exists(self._path)

    def absoluteFilePath(self):
        return os.path.abspath(self._path)

    def absolutePath(self):
        return os.path.dirname(os.path.abspath(self._path))

    def fileName(self):
        return os.path.basename(self._path)

    def baseName(self):
        return os.path.basename(self._path).split(".")[0]

    def completeBaseName(self):
        return os.path.basename(self._path).rsplit(".", 1)[0]

    def suffix(self):
        return os.path.basename(self._path).rsplit(".", 1)[-1] if "." in self._path else ""

    def isDir(self):
        return os.path.isdir(self._path)

    def isFile(self):
        return os.path.isfile(self._path)

    def dir(self):
        return QDir(self.absolutePath())


class QDir:
    def __init__(self, path=""):
        self._path = str(path)

    def absolutePath(self):
        return os.path.abspath(self._path)

    def filePath(self, name):
        return os.path.join(self._path, name)

    def exists(self):
        return os.path.isdir(self._path)

    def mkpath(self, path):
        os.makedirs(os.path.join(self._path, path), exist_ok=True)
        return True

    @staticmethod
    def tempPath():
        return "/tmp"

    @staticmethod
    def homePath():
        return os.path.expanduser("~")


class QDateTime:
    """Date and time (the part of QDateTime that Slicer code uses: the current time, formatted)."""

    def __init__(self, value=None):
        self._value = value or datetime.datetime.now()

    @staticmethod
    def currentDateTime():
        return QDateTime()

    @staticmethod
    def currentDateTimeUtc():
        return QDateTime(datetime.datetime.now(datetime.timezone.utc))

    def toPython(self):
        return self._value

    def toString(self, fmt=None):
        return QLocale().toString(self, fmt)

    def toSecsSinceEpoch(self):
        return int(self._value.timestamp())

    def toMSecsSinceEpoch(self):
        return int(self._value.timestamp() * 1000)

    def secsTo(self, other):
        """Seconds from this moment to *other*, as QDateTime::secsTo counts them."""
        return int(other.toSecsSinceEpoch() - self.toSecsSinceEpoch())

    def msecsTo(self, other):
        return int(other.toMSecsSinceEpoch() - self.toMSecsSinceEpoch())

    def addSecs(self, seconds):
        return QDateTime(self._value + datetime.timedelta(seconds=seconds))

    def isValid(self):
        return True


class QLocale:
    """Number and date formatting. Only the C locale exists here, which is what Slicer asks for
    (it formats dates with an en-US locale so that the digits are the usual ones)."""

    C, English = 0, 31
    UnitedStates, AnyCountry = 225, 0

    def __init__(self, *args):
        pass

    @staticmethod
    def c():
        return QLocale()

    def name(self):
        return "en_US"

    def toString(self, value, fmt=None):
        """Qt date format (yyyy-MM-dd_hh+mm+ss.zzz) applied to a QDateTime, or a number as text."""
        if isinstance(value, QDateTime):
            value = value.toPython()
        if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
            if not fmt:
                return value.isoformat()
            text = str(fmt)
            milliseconds = "%03d" % (getattr(value, "microsecond", 0) // 1000)
            for qt_format, py_format in (("yyyy", "%Y"), ("MM", "%m"), ("dd", "%d"),
                                         ("hh", "%H"), ("mm", "%M"), ("ss", "%S")):
                text = text.replace(qt_format, value.strftime(py_format))
            return text.replace("zzz", milliseconds)
        return str(value)

    def toDouble(self, text):
        try:
            return float(text), True
        except (TypeError, ValueError):
            return 0.0, False

    def toInt(self, text):
        try:
            return int(text), True
        except (TypeError, ValueError):
            return 0, False


class QEventLoop:
    """Flags that modules pass to processEvents; there is no loop of our own to run."""

    AllEvents, ExcludeUserInputEvents, ExcludeSocketNotifiers, WaitForMoreEvents = 0, 1, 2, 4

    def processEvents(self, *args):
        pass

    def exec_(self, *args):
        return 0

    def quit(self):
        pass


class QTextDocument:
    """A piece of rich text. Modules build one to take the plain text out of an HTML message."""

    def __init__(self, text=""):
        self._html = str(text)

    def setHtml(self, html):
        self._html = str(html)

    def toHtml(self):
        return self._html

    def setPlainText(self, text):
        self._html = str(text)

    def toPlainText(self):
        """The text without the markup, with the usual entities read back."""
        import html
        import re

        text = re.sub(r"<br\s*/?>", "\n", self._html, flags=re.I)
        text = re.sub(r"</p\s*>", "\n", text, flags=re.I)
        return html.unescape(re.sub(r"<[^>]+>", "", text)).strip()

    def isEmpty(self):
        return not self.toPlainText()


class QUrl:
    TolerantMode = 0

    def __init__(self, url="", *args):
        self._url = str(url)

    def toString(self):
        return self._url

    def toLocalFile(self):
        return self._url[7:] if self._url.startswith("file://") else self._url

    @staticmethod
    def fromLocalFile(path):
        return QUrl("file://" + str(path))


class QDesktopServices:
    @staticmethod
    def openUrl(url):
        try:
            import js

            js.window.open(url.toString() if isinstance(url, QUrl) else str(url), "_blank")
            return True
        except Exception:
            return False


class QMessageBox:
    Ok, Cancel, Yes, No, Close, Discard, Save, Abort, Retry, Ignore = 0x400, 0x400000, 0x4000, 0x10000, 0x200000, 0x800000, 0x800, 0x40000, 0x80000, 0x100000
    NoIcon, Information, Warning, Critical, Question = 0, 1, 2, 3, 4
    AcceptRole, RejectRole = 0, 1

    def __init__(self, *args):
        self._text = ""
        self._icon = 0

    @staticmethod
    def _alert(text):
        try:
            import js

            js.window.alert(str(text))
        except Exception:
            logger.info(text)

    @staticmethod
    def _confirm(text):
        try:
            import js

            return bool(js.window.confirm(str(text)))
        except Exception:
            return True

    @classmethod
    def information(cls, parent, title, text, *args):
        cls._alert(text)
        return cls.Ok

    @classmethod
    def warning(cls, parent, title, text, *args):
        cls._alert(text)
        return cls.Ok

    @classmethod
    def critical(cls, parent, title, text, *args):
        cls._alert(text)
        return cls.Ok

    @classmethod
    def question(cls, parent, title, text, *args):
        return cls.Yes if cls._confirm(text) else cls.No

    def setText(self, text):
        self._text = text

    def setInformativeText(self, text):
        self._text += "\n" + text

    def setDetailedText(self, text):
        pass

    def setWindowTitle(self, t):
        pass

    def setIcon(self, icon):
        self._icon = icon

    def setStandardButtons(self, b):
        pass

    def setDefaultButton(self, b):
        pass

    def addButton(self, *args):
        return None

    def exec_(self):
        self._alert(self._text)
        return self.Ok

    exec = exec_


class QInputDialog:
    @staticmethod
    def getText(parent, title, label, *args):
        try:
            import js

            value = js.window.prompt(str(label), args[1] if len(args) > 1 else "")
            return value if value is not None else ""
        except Exception:
            return ""

    @staticmethod
    def getItem(parent, title, label, items, current=0, *args):
        items = list(items)
        return items[current] if items else ""


class QFileDialog:
    """File dialogs cannot block in the browser. Use the Data panel to load files."""

    @staticmethod
    def getOpenFileName(*args, **kwargs):
        logger.warning("File dialogs are not available in the browser: use the Data panel to load files")
        return ""

    @staticmethod
    def getOpenFileNames(*args, **kwargs):
        return []

    @staticmethod
    def getSaveFileName(*args, **kwargs):
        return ""

    @staticmethod
    def getExistingDirectory(*args, **kwargs):
        return ""


class QTableWidgetItem:
    def __init__(self, text=""):
        self._text = str(text)

    def text(self):
        return self._text

    def setText(self, text):
        self._text = str(text)

    def setFlags(self, flags):
        pass

    def setData(self, role, value):
        pass

    def setToolTip(self, t):
        pass


#: What each Qt cursor shape looks like in a browser.
_CSS_CURSORS = {
    Qt.ArrowCursor: "default", Qt.UpArrowCursor: "default", Qt.CrossCursor: "crosshair",
    Qt.WaitCursor: "wait", Qt.IBeamCursor: "text", Qt.SizeVerCursor: "ns-resize",
    Qt.SizeHorCursor: "ew-resize", Qt.SizeBDiagCursor: "nesw-resize", Qt.SizeFDiagCursor: "nwse-resize",
    Qt.SizeAllCursor: "move", Qt.BlankCursor: "none", Qt.SplitVCursor: "row-resize",
    Qt.SplitHCursor: "col-resize", Qt.PointingHandCursor: "pointer", Qt.ForbiddenCursor: "not-allowed",
    Qt.WhatsThisCursor: "help", Qt.BusyCursor: "progress", Qt.OpenHandCursor: "grab",
    Qt.ClosedHandCursor: "grabbing",
}


class QApplication:
    #: The cursors set over the application, as Qt keeps them: a stack, the last one showing.
    _overrideCursors = []

    @staticmethod
    def processEvents(*args):
        pass

    @staticmethod
    def setOverrideCursor(cursor):
        """Show this cursor over the whole page until it is restored (qt.Qt.WaitCursor and friends)."""
        QApplication._overrideCursors.append(cursor if isinstance(cursor, QCursor) else QCursor(cursor))
        QApplication._showCursor()

    @staticmethod
    def restoreOverrideCursor():
        if QApplication._overrideCursors:
            QApplication._overrideCursors.pop()
        QApplication._showCursor()

    @staticmethod
    def changeOverrideCursor(cursor):
        if QApplication._overrideCursors:
            QApplication._overrideCursors[-1] = cursor if isinstance(cursor, QCursor) else QCursor(cursor)
            QApplication._showCursor()

    @staticmethod
    def overrideCursor():
        """The cursor now showing over the application, or None.

        slicer.util puts the normal cursor back while a dialog is up by emptying this stack and
        filling it again afterwards, so the whole of it has to be here, not only the setting.
        """
        return QApplication._overrideCursors[-1] if QApplication._overrideCursors else None

    @staticmethod
    def _showCursor():
        cursor = QApplication.overrideCursor()
        try:
            import js

            js.document.body.style.cursor = _CSS_CURSORS.get(cursor.shape(), "wait") if cursor else ""
        except Exception:  # pragma: no cover - not in a browser
            pass

    @staticmethod
    def clipboard():
        return _Clipboard()

    @staticmethod
    def keyboardModifiers():
        return 0

    @staticmethod
    def instance():
        import slicer

        return slicer.app


class _Clipboard:
    def setText(self, text):
        try:
            import js

            js.navigator.clipboard.writeText(str(text))
        except Exception:
            pass

    def text(self):
        return ""


class QCursor:
    def __init__(self, shape=Qt.ArrowCursor, *args):
        self._shape = shape if isinstance(shape, int) else Qt.ArrowCursor

    def shape(self):
        return self._shape

    def setShape(self, shape):
        self._shape = shape

    @staticmethod
    def pos():
        return QPoint()


class QVariant:
    def __new__(cls, value=None):
        return value


class QStandardPaths:
    AppDataLocation, TempLocation, HomeLocation, DocumentsLocation = 17, 7, 8, 1

    @staticmethod
    def writableLocation(location):
        return {7: "/tmp", 8: os.path.expanduser("~")}.get(location, os.path.expanduser("~"))


class QProcess(QObject):
    """External processes cannot run in the browser. The class and its enumerations exist so that
    modules which use QProcess for optional features (e.g. batch processing) can be imported."""

    NotRunning, Starting, Running = 0, 1, 2
    FailedToStart, Crashed, Timedout, WriteError, ReadError, UnknownError = 0, 1, 2, 3, 4, 5
    NormalExit, CrashExit = 0, 1
    SeparateChannels, MergedChannels, ForwardedChannels = 0, 1, 2

    started = Signal("started()")
    finished = Signal("finished(int,QProcess::ExitStatus)")
    errorOccurred = Signal("errorOccurred(QProcess::ProcessError)")
    readyReadStandardOutput = Signal("readyReadStandardOutput()")
    readyReadStandardError = Signal("readyReadStandardError()")

    def state(self):
        return QProcess.NotRunning

    def start(self, *args, **kwargs):
        raise RuntimeError("External processes cannot be started in the web browser")

    startDetached = start
    execute = start

    def waitForFinished(self, msecs=30000):
        return False

    def waitForStarted(self, msecs=30000):
        return False

    def setProcessChannelMode(self, mode):
        pass

    def setWorkingDirectory(self, path):
        pass

    def setProcessEnvironment(self, env):
        pass

    def readAllStandardOutput(self):
        return b""

    def readAllStandardError(self):
        return b""

    def exitCode(self):
        return -1

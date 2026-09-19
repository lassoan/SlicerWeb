"""Qt widget and layout classes implemented with Slicer web widgets (custom elements).

Each class keeps the Python-side state (properties, children, signals) and mirrors it to a DOM
element. User interaction on the element updates the Python state and emits the Qt signal.
"""

import logging

from . import dom
from .core import QObject, QProp, Signal

logger = logging.getLogger("slicerweb.qt")


def _bool(v):
    return bool(v)


def _float(v):
    return float(v)


def _int(v):
    return int(v)


# --------------------------------------------------------------------------- base widget
class QWidget(QObject):
    _tag = "div"
    _classes = "sw-qwidget flex flex-col gap-1.5 min-w-0"

    windowTitleChanged = Signal("windowTitleChanged(QString)")
    customContextMenuRequested = Signal("customContextMenuRequested(QPoint)")

    def __init__(self, parent=None, *args, **kwargs):
        super().__init__(None)
        self._el = dom.create(self._tag, self._classes)
        self._layout = None
        self._visible = True
        self._enabled = True
        self._toolTip = ""
        self._windowTitle = ""
        self._styleSheet = ""
        if parent is not None:
            self.setParent(parent)
        self._init_element()

    def _init_element(self):
        pass

    def element(self):
        return self._el

    # --- layout
    def setLayout(self, layout):
        if layout is None:
            return
        self._layout = layout
        layout._setParentWidget(self)
        self._contentElement().appendChild(layout._el)

    def layout(self):
        return self._layout

    def _contentElement(self):
        return self._el

    # --- visibility / state
    def show(self):
        self.setVisible(True)

    def hide(self):
        self.setVisible(False)

    def setVisible(self, visible):
        self._visible = bool(visible)
        try:
            self._el.style.display = "" if self._visible else "none"
        except Exception:
            pass

    def setHidden(self, hidden):
        self.setVisible(not hidden)

    def isVisible(self):
        return self._visible

    def isHidden(self):
        return not self._visible

    visible = property(lambda self: self._visible, lambda self, v: self.setVisible(v))

    def setEnabled(self, enabled):
        self._enabled = bool(enabled)
        self._applyEnabled()

    def setDisabled(self, disabled):
        self.setEnabled(not disabled)

    def isEnabled(self):
        return self._enabled

    enabled = property(lambda self: self._enabled, lambda self, v: self.setEnabled(v))

    def _applyEnabled(self):
        if self._tag.startswith("sw-"):
            dom.set_prop(self._el, "enabled", self._enabled)
        else:
            try:
                self._el.style.opacity = "" if self._enabled else "0.45"
                self._el.style.pointerEvents = "" if self._enabled else "none"
            except Exception:
                pass

    def setToolTip(self, text):
        self._toolTip = str(text)
        try:
            self._el.title = self._toolTip
        except Exception:
            pass

    toolTip = property(lambda self: self._toolTip, lambda self, v: self.setToolTip(v))

    def setWindowTitle(self, title):
        self._windowTitle = str(title)
        self.windowTitleChanged.emit(self._windowTitle)

    def windowTitle(self):
        return self._windowTitle

    def setStyleSheet(self, sheet):
        self._styleSheet = sheet

    def styleSheet(self):
        return self._styleSheet

    # --- geometry-related calls accepted and ignored (layout is CSS based)
    def _noop(self, *args, **kwargs):
        return None

    setMinimumWidth = setMaximumWidth = setMinimumHeight = setMaximumHeight = _noop
    setFixedWidth = setFixedHeight = setFixedSize = setMinimumSize = setMaximumSize = _noop
    setSizePolicy = resize = move = setGeometry = setContentsMargins = setFocusPolicy = _noop
    setFocus = raise_ = activateWindow = update = repaint = adjustSize = setAttribute = _noop
    setContextMenuPolicy = setMouseTracking = setAutoFillBackground = setFont = setPalette = _noop

    def setMRMLScene(self, scene):
        self._mrmlScene = scene

    def mrmlScene(self):
        import slicer

        return getattr(self, "_mrmlScene", None) or slicer.mrmlScene

    def parentWidget(self):
        p = self.parent()
        return p if isinstance(p, QWidget) else None

    def width(self):
        return 0

    def height(self):
        return 0

    def size(self):
        from .types import QSize

        return QSize(0, 0)

    def close(self):
        self.hide()
        return True

    def grab(self):
        return None

    def mapToGlobal(self, point):
        return point

    def window(self):
        w = self
        while w.parentWidget() is not None:
            w = w.parentWidget()
        return w


class QFrame(QWidget):
    NoFrame, Box, Panel, StyledPanel, HLine, VLine = 0, 1, 2, 6, 4, 5
    Plain, Raised, Sunken = 16, 32, 48

    def setFrameShape(self, shape):
        if shape in (self.HLine, self.VLine):
            self._el.className = "border-t border-input my-1" if shape == self.HLine else "border-l border-input mx-1"

    def setFrameShadow(self, shadow):
        pass

    def setLineWidth(self, w):
        pass


# --------------------------------------------------------------------------- layouts
class QLayout(QObject):
    _classes = "flex flex-col gap-1.5 min-w-0"

    def __init__(self, parent=None):
        super().__init__(None)
        self._el = dom.create("div", self._classes)
        self._parentWidget = None
        self._items = []
        if isinstance(parent, QWidget):
            parent.setLayout(self)

    def _setParentWidget(self, widget):
        self._parentWidget = widget
        self.setParent(widget)
        for item in self._items:
            if isinstance(item, QWidget):
                item.setParent(widget)
            elif isinstance(item, QLayout):
                item._setParentWidget(widget)

    def _adopt(self, item):
        self._items.append(item)
        if self._parentWidget is not None:
            if isinstance(item, QWidget):
                item.setParent(self._parentWidget)
            elif isinstance(item, QLayout):
                item._setParentWidget(self._parentWidget)

    def addWidget(self, widget, *args, **kwargs):
        if widget is None:
            return
        self._adopt(widget)
        self._el.appendChild(widget._el)

    def addLayout(self, layout, *args):
        self._adopt(layout)
        self._el.appendChild(layout._el)

    def insertWidget(self, index, widget, *args):
        self.addWidget(widget)

    def removeWidget(self, widget):
        if widget in self._items:
            self._items.remove(widget)
            try:
                widget._el.remove()
            except Exception:
                pass

    def addStretch(self, stretch=1):
        spacer = dom.create("div", "flex-1")
        self._el.appendChild(spacer)

    def addSpacing(self, size):
        spacer = dom.create("div", "")
        try:
            spacer.style.minHeight = f"{int(size)}px"
            spacer.style.minWidth = f"{int(size)}px"
        except Exception:
            pass
        self._el.appendChild(spacer)

    def addItem(self, item):
        if isinstance(item, QSpacerItem):
            self.addStretch()

    def setSpacing(self, spacing):
        pass

    def setContentsMargins(self, *args):
        pass

    def setMargin(self, m):
        pass

    def setAlignment(self, *args):
        pass

    def count(self):
        return len(self._items)

    def itemAt(self, index):
        if 0 <= index < len(self._items):
            return _LayoutItem(self._items[index])
        return None

    def parentWidget(self):
        return self._parentWidget


class _LayoutItem:
    def __init__(self, item):
        self._item = item

    def widget(self):
        return self._item if isinstance(self._item, QWidget) else None

    def layout(self):
        return self._item if isinstance(self._item, QLayout) else None


class QSpacerItem:
    def __init__(self, *args):
        pass


class QVBoxLayout(QLayout):
    _classes = "flex flex-col gap-1.5 min-w-0"


class QHBoxLayout(QLayout):
    _classes = "flex flex-row flex-wrap items-center gap-1.5 min-w-0"

    def addWidget(self, widget, stretch=0, *args):
        super().addWidget(widget)
        if stretch and widget is not None:
            try:
                widget._el.style.flex = f"{int(stretch)} 1 0"
            except Exception:
                pass


class QBoxLayout(QVBoxLayout):
    TopToBottom, LeftToRight = 2, 0


class QFormLayout(QLayout):
    _classes = "flex flex-col gap-1.5 min-w-0"
    LabelRole, FieldRole, SpanningRole = 0, 1, 2

    def addRow(self, label, field=None):
        row = dom.create("div", "grid grid-cols-[minmax(80px,38%)_1fr] items-center gap-2 min-w-0")
        if field is None:
            # single widget/layout spanning the row
            item = label
            row.className = "min-w-0"
            self._appendItem(row, item)
        else:
            if isinstance(label, str):
                span = dom.create("span", "truncate text-[12px] text-muted-foreground")
                span.textContent = label
                row.appendChild(span)
            else:
                self._appendItem(row, label)
            cell = dom.create("div", "min-w-0")
            self._appendItem(cell, field)
            row.appendChild(cell)
        self._el.appendChild(row)

    def _appendItem(self, container, item):
        if isinstance(item, QWidget):
            self._adopt(item)
            container.appendChild(item._el)
        elif isinstance(item, QLayout):
            self._adopt(item)
            container.appendChild(item._el)
        elif isinstance(item, str):
            span = dom.create("span", "text-[13px]")
            span.textContent = item
            container.appendChild(span)

    def setWidget(self, row, role, widget):
        self.addRow(widget)

    def setFieldGrowthPolicy(self, policy):
        pass

    def setLabelAlignment(self, alignment):
        pass

    def rowCount(self):
        return len(self._items)


class QGridLayout(QLayout):
    _classes = "grid gap-1.5 min-w-0"

    def addWidget(self, widget, row=0, column=0, rowSpan=1, columnSpan=1, *args):
        self._place(widget, row, column, rowSpan, columnSpan)

    def addLayout(self, layout, row=0, column=0, rowSpan=1, columnSpan=1, *args):
        self._place(layout, row, column, rowSpan, columnSpan)

    def _place(self, item, row, column, rowSpan, columnSpan):
        if item is None:
            return
        self._adopt(item)
        el = item._el
        try:
            el.style.gridRow = f"{int(row) + 1} / span {max(1, int(rowSpan))}"
            el.style.gridColumn = f"{int(column) + 1} / span {max(1, int(columnSpan))}"
        except Exception:
            pass
        self._el.appendChild(el)

    def setColumnStretch(self, column, stretch):
        pass

    def setRowStretch(self, row, stretch):
        pass


# --------------------------------------------------------------------------- custom element widgets
class _ElementWidget(QWidget):
    """Widget rendered by a Slicer web widget custom element (<sw-...>)."""

    _events = {}  # element event name -> python handler method name

    def _init_element(self):
        for event, handler in self._events.items():
            dom.listen(self._el, event, getattr(self, handler))

    def _setElementProperty(self, name, value):
        dom.set_prop(self._el, name, value)


class QLabel(QWidget):
    _tag = "sw-label"
    _classes = ""

    linkActivated = Signal("linkActivated(QString)")

    def __init__(self, text="", parent=None, *args):
        if isinstance(text, QWidget):
            parent, text = text, ""
        super().__init__(parent)
        self.setText(text)

    def setText(self, text):
        self._text = str(text)
        dom.set_prop(self._el, "text", self._text)
        dom.set_prop(self._el, "richText", "<" in self._text and ">" in self._text)

    text = property(lambda self: self._text, lambda self, v: self.setText(v))

    def setWordWrap(self, wrap):
        dom.set_prop(self._el, "wordWrap", bool(wrap))

    def setOpenExternalLinks(self, v):
        pass

    def setTextFormat(self, f):
        pass

    def setAlignment(self, *a):
        pass

    def setPixmap(self, pixmap):
        pass

    def setTextInteractionFlags(self, flags):
        pass

    def clear(self):
        self.setText("")


class QAbstractButton(_ElementWidget):
    _tag = "sw-button"
    _classes = ""
    _events = {"clicked": "_onClicked", "toggled": "_onToggled"}

    clicked = Signal("clicked(bool)")
    toggled = Signal("toggled(bool)")
    pressed = Signal("pressed()")
    released = Signal("released()")

    text = QProp("", el="text", convert=str)
    checkable = QProp(False, el="checkable", convert=_bool)
    checked = QProp(False, el="checked", convert=_bool)

    def __init__(self, text="", parent=None, *args):
        if isinstance(text, QWidget):
            parent, text = text, ""
        super().__init__(parent)
        if text:
            self.text = text

    def _onClicked(self, checked=False):
        if self.checkable:
            QAbstractButton.checked.set_silently(self, bool(checked))
            dom.set_prop(self._el, "checked", self.checked)
        self.pressed.emit()
        self.released.emit()
        self.clicked.emit(bool(self.checked))

    def _onToggled(self, checked):
        if self.checkable:
            self.toggled.emit(bool(checked))

    def setText(self, text):
        self.text = text

    def setCheckable(self, v):
        self.checkable = v

    def isCheckable(self):
        return self.checkable

    def setChecked(self, v):
        changed = bool(v) != self.checked
        self.checked = v
        if changed:
            self.toggled.emit(self.checked)

    def isChecked(self):
        return self.checked

    def click(self):
        if self.checkable:
            self.setChecked(not self.checked)
        self.clicked.emit(self.checked)

    def toggle(self):
        self.setChecked(not self.checked)

    def setIcon(self, icon):
        pass

    def setIconSize(self, size):
        pass

    def setShortcut(self, s):
        pass

    def setAutoExclusive(self, v):
        pass

    def setDefaultAction(self, action):
        if action is not None:
            self.text = action.text
            self.clicked.connect(lambda *a: action.trigger())

    def setMenu(self, menu):
        self._menu = menu

    def setPopupMode(self, mode):
        pass

    def setToolButtonStyle(self, style):
        pass

    def setAutoRaise(self, v):
        pass

    def setDefault(self, v):
        dom.set_prop(self._el, "primary", bool(v))


class QPushButton(QAbstractButton):
    pass


class QToolButton(QAbstractButton):
    MenuButtonPopup, InstantPopup, DelayedPopup = 1, 2, 0


class QCheckBox(_ElementWidget):
    _tag = "sw-checkbox"
    _classes = ""
    _events = {"toggled": "_onToggled"}

    toggled = Signal("toggled(bool)")
    stateChanged = Signal("stateChanged(int)")
    clicked = Signal("clicked(bool)")

    text = QProp("", el="text", convert=str)
    checked = QProp(False, el="checked", convert=_bool)

    def __init__(self, text="", parent=None):
        if isinstance(text, QWidget):
            parent, text = text, ""
        super().__init__(parent)
        if text:
            self.text = text

    def _onToggled(self, checked):
        type(self).checked.set_silently(self, bool(checked))
        self.toggled.emit(self.checked)
        self.stateChanged.emit(2 if self.checked else 0)
        self.clicked.emit(self.checked)

    def setChecked(self, v):
        changed = bool(v) != self.checked
        self.checked = v
        if changed:
            self.toggled.emit(self.checked)
            self.stateChanged.emit(2 if self.checked else 0)

    def isChecked(self):
        return self.checked

    def checkState(self):
        return 2 if self.checked else 0

    def setCheckState(self, state):
        self.setChecked(state == 2)

    def setText(self, text):
        self.text = text

    def setTristate(self, v):
        pass


class QRadioButton(QCheckBox):
    pass


class QComboBox(_ElementWidget):
    _tag = "sw-combobox"
    _classes = ""
    _events = {"currentIndexChanged": "_onIndexChanged"}

    currentIndexChanged = Signal("currentIndexChanged(int)")
    currentTextChanged = Signal("currentTextChanged(QString)")
    activated = Signal("activated(int)")
    textActivated = Signal("textActivated(QString)")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._itemTexts = []
        self._itemData = []
        self._currentIndex = -1

    def _sync(self):
        dom.set_prop(self._el, "items", list(self._itemTexts))
        dom.set_prop(self._el, "currentIndex", self._currentIndex)

    def _onIndexChanged(self, index):
        self._setIndex(int(index), fromUser=True)

    def _setIndex(self, index, fromUser=False):
        if index == self._currentIndex:
            return
        self._currentIndex = index
        if not fromUser:
            dom.set_prop(self._el, "currentIndex", index)
        self.currentIndexChanged.emit(index)
        self.currentTextChanged.emit(self.currentText)
        if fromUser:
            self.activated.emit(index)
            self.textActivated.emit(self.currentText)

    def addItem(self, *args):
        text = next((a for a in args if isinstance(a, str)), "")
        data = args[-1] if len(args) >= 2 and not isinstance(args[-1], str) or (len(args) == 2 and isinstance(args[0], str)) else None
        if len(args) == 2 and isinstance(args[0], str):
            data = args[1]
        self._itemTexts.append(text)
        self._itemData.append(data)
        if self._currentIndex < 0:
            self._currentIndex = 0
            self._sync()
            self.currentIndexChanged.emit(0)
            self.currentTextChanged.emit(text)
        else:
            self._sync()

    def addItems(self, texts):
        for t in texts:
            self.addItem(str(t))

    def insertItem(self, index, text, data=None):
        self._itemTexts.insert(index, str(text))
        self._itemData.insert(index, data)
        self._sync()

    def removeItem(self, index):
        if 0 <= index < len(self._itemTexts):
            del self._itemTexts[index]
            del self._itemData[index]
            if self._currentIndex >= len(self._itemTexts):
                self._currentIndex = len(self._itemTexts) - 1
            self._sync()

    def clear(self):
        self._itemTexts, self._itemData = [], []
        self._currentIndex = -1
        self._sync()

    def count(self):
        return len(self._itemTexts)

    def itemText(self, index):
        return self._itemTexts[index] if 0 <= index < len(self._itemTexts) else ""

    def itemData(self, index, role=None):
        return self._itemData[index] if 0 <= index < len(self._itemData) else None

    def setItemData(self, index, value, role=None):
        if 0 <= index < len(self._itemData):
            self._itemData[index] = value

    def findText(self, text, *args):
        return self._itemTexts.index(text) if text in self._itemTexts else -1

    def findData(self, data, *args):
        return self._itemData.index(data) if data in self._itemData else -1

    def setCurrentIndex(self, index):
        self._setIndex(int(index))

    def setCurrentText(self, text):
        i = self.findText(text)
        if i >= 0:
            self._setIndex(i)

    currentIndex = property(lambda self: self._currentIndex, lambda self, v: self.setCurrentIndex(v))
    currentText = property(lambda self: self.itemText(self._currentIndex), lambda self, v: self.setCurrentText(v))

    def currentData(self, role=None):
        return self.itemData(self._currentIndex)

    def setEditable(self, v):
        pass

    def setToolTip(self, text):
        super().setToolTip(text)
        dom.set_prop(self._el, "toolTip", str(text))


class QLineEdit(_ElementWidget):
    _tag = "sw-lineedit"
    _classes = ""
    _events = {"textChanged": "_onTextChanged", "editingFinished": "_onEditingFinished"}

    textChanged = Signal("textChanged(QString)")
    textEdited = Signal("textEdited(QString)")
    editingFinished = Signal("editingFinished()")
    returnPressed = Signal("returnPressed()")

    text = QProp("", el="text", signal="textChanged", convert=str)
    placeholderText = QProp("", el="placeholderText", convert=str)
    readOnly = QProp(False, el="readOnly", convert=_bool)

    def __init__(self, text="", parent=None):
        if isinstance(text, QWidget):
            parent, text = text, ""
        super().__init__(parent)
        if text:
            self.text = text

    def _onTextChanged(self, text):
        type(self).text.set_silently(self, text)
        self.textEdited.emit(text)

    def _onEditingFinished(self, text=None):
        self.editingFinished.emit()
        self.returnPressed.emit()

    def setText(self, text):
        self.text = text

    def setPlaceholderText(self, text):
        self.placeholderText = text

    def setReadOnly(self, v):
        self.readOnly = v

    def clear(self):
        self.text = ""

    def setValidator(self, v):
        pass

    def setEchoMode(self, m):
        pass

    def setClearButtonEnabled(self, v):
        pass


class QTextEdit(_ElementWidget):
    _tag = "sw-textedit"
    _classes = ""
    _events = {"textChanged": "_onTextChanged"}

    textChanged = Signal("textChanged()")

    plainText = QProp("", el="plainText", convert=str)
    readOnly = QProp(False, el="readOnly", convert=_bool)
    placeholderText = QProp("", el="placeholderText", convert=str)

    def __init__(self, text="", parent=None):
        if isinstance(text, QWidget):
            parent, text = text, ""
        super().__init__(parent)
        if text:
            self.plainText = text

    def _onTextChanged(self, text):
        type(self).plainText.set_silently(self, text)
        self.textChanged.emit()

    def setPlainText(self, text):
        self.plainText = text
        self.textChanged.emit()

    def toPlainText(self):
        return self.plainText

    def setText(self, text):
        self.setPlainText(text)

    def setHtml(self, html):
        self.setPlainText(html)

    def toHtml(self):
        return self.plainText

    def append(self, text):
        self.setPlainText((self.plainText + "\n" if self.plainText else "") + str(text))

    def insertPlainText(self, text):
        self.setPlainText(self.plainText + str(text))

    def clear(self):
        self.setPlainText("")

    def setReadOnly(self, v):
        self.readOnly = v

    def setLineWrapMode(self, m):
        pass

    def verticalScrollBar(self):
        return _ScrollBar()

    def moveCursor(self, *args):
        pass


class QPlainTextEdit(QTextEdit):
    pass


class QTextBrowser(QTextEdit):
    def __init__(self, parent=None):
        super().__init__("", parent)
        self.readOnly = True

    def setOpenExternalLinks(self, v):
        pass


class _ScrollBar:
    def setValue(self, v):
        pass

    def maximum(self):
        return 0


class QAbstractSpinBox(_ElementWidget):
    _tag = "sw-spinbox"
    _classes = ""
    _events = {"valueChanged": "_onValueChanged"}

    valueChanged = Signal("valueChanged(double)")
    editingFinished = Signal("editingFinished()")

    value = QProp(0.0, el="value", signal="valueChanged", convert=_float)
    minimum = QProp(0.0, el="minimum", convert=_float)
    maximum = QProp(99.0, el="maximum", convert=_float)
    singleStep = QProp(1.0, el="singleStep", convert=_float)
    decimals = QProp(2, el="decimals", convert=_int)
    suffix = QProp("", el="suffix", convert=str)
    prefix = QProp("", el="prefix", convert=str)

    def __init__(self, parent=None):
        super().__init__(parent)
        dom.set_prop(self._el, "minimum", self.minimum)
        dom.set_prop(self._el, "maximum", self.maximum)
        dom.set_prop(self._el, "decimals", self.decimals)

    def _onValueChanged(self, value):
        type(self).value.set_silently(self, value)
        self.editingFinished.emit()

    def setValue(self, v):
        self.value = min(self.maximum, max(self.minimum, float(v)))

    def setMinimum(self, v):
        self.minimum = v

    def setMaximum(self, v):
        self.maximum = v

    def setRange(self, lo, hi):
        self.minimum, self.maximum = lo, hi

    def setSingleStep(self, v):
        self.singleStep = v

    def setDecimals(self, v):
        self.decimals = v

    def setSuffix(self, s):
        self.suffix = s

    def setPrefix(self, s):
        self.prefix = s

    def setSpecialValueText(self, t):
        pass

    def setKeyboardTracking(self, v):
        pass


class QDoubleSpinBox(QAbstractSpinBox):
    pass


class QSpinBox(QAbstractSpinBox):
    decimals = QProp(0, el="decimals", convert=_int)
    value = QProp(0, el="value", signal="valueChanged", convert=lambda v: int(round(float(v))))

    def __init__(self, parent=None):
        super().__init__(parent)
        self.decimals = 0


class QAbstractSlider(_ElementWidget):
    _tag = "sw-slider"
    _classes = ""
    _events = {"valueChanged": "_onValueChanged"}

    valueChanged = Signal("valueChanged(double)")
    sliderMoved = Signal("sliderMoved(double)")
    sliderReleased = Signal("sliderReleased()")
    sliderPressed = Signal("sliderPressed()")

    value = QProp(0.0, el="value", signal="valueChanged", convert=_float)
    minimum = QProp(0.0, el="minimum", convert=_float)
    maximum = QProp(99.0, el="maximum", convert=_float)
    singleStep = QProp(1.0, el="singleStep", convert=_float)
    pageStep = QProp(10.0, convert=_float)
    decimals = QProp(2, el="decimals", convert=_int)
    suffix = QProp("", el="suffix", convert=str)
    tracking = QProp(True, convert=_bool)

    def __init__(self, *args):
        parent = next((a for a in args if isinstance(a, QWidget)), None)
        super().__init__(parent)
        dom.set_prop(self._el, "minimum", self.minimum)
        dom.set_prop(self._el, "maximum", self.maximum)

    def _onValueChanged(self, value):
        type(self).value.set_silently(self, value)
        self.sliderMoved.emit(self.value)

    def setValue(self, v):
        self.value = min(self.maximum, max(self.minimum, float(v)))

    def setMinimum(self, v):
        self.minimum = v

    def setMaximum(self, v):
        self.maximum = v

    def setRange(self, lo, hi):
        self.minimum, self.maximum = lo, hi

    def setSingleStep(self, v):
        self.singleStep = v

    def setPageStep(self, v):
        self.pageStep = v

    def setDecimals(self, v):
        self.decimals = v

    def setSuffix(self, s):
        self.suffix = s

    def setOrientation(self, o):
        pass

    def setTickPosition(self, p):
        pass

    def setTickInterval(self, i):
        pass

    def setTracking(self, v):
        self.tracking = v


class QSlider(QAbstractSlider):
    decimals = QProp(0, el="decimals", convert=_int)
    value = QProp(0, el="value", signal="valueChanged", convert=lambda v: int(round(float(v))))

    def __init__(self, *args):
        super().__init__(*args)
        self.decimals = 0


class QProgressBar(_ElementWidget):
    _tag = "sw-progressbar"
    _classes = ""

    valueChanged = Signal("valueChanged(int)")

    value = QProp(0, el="value", signal="valueChanged", convert=_int)
    minimum = QProp(0, el="minimum", convert=_int)
    maximum = QProp(100, el="maximum", convert=_int)
    textVisible = QProp(True, el="textVisible", convert=_bool)

    def setValue(self, v):
        self.value = v

    def setRange(self, lo, hi):
        self.minimum, self.maximum = lo, hi

    def setMinimum(self, v):
        self.minimum = v

    def setMaximum(self, v):
        self.maximum = v

    def setTextVisible(self, v):
        self.textVisible = v

    def setFormat(self, f):
        pass

    def reset(self):
        self.value = self.minimum


# --------------------------------------------------------------------------- containers
class QGroupBox(QWidget):
    _tag = "fieldset"
    _classes = "sw-groupbox rounded-md border border-input/70 px-2 pt-1 pb-2 flex flex-col gap-1.5 min-w-0"

    toggled = Signal("toggled(bool)")
    clicked = Signal("clicked(bool)")

    def __init__(self, title="", parent=None):
        if isinstance(title, QWidget):
            parent, title = title, ""
        self._title = ""
        self._checkable = False
        self._checked = True
        super().__init__(parent)
        self.setTitle(title)

    def _init_element(self):
        self._legend = dom.create("legend", "px-1 text-[12px] text-muted-foreground")
        self._el.appendChild(self._legend)
        self._content = dom.create("div", "flex flex-col gap-1.5 min-w-0")
        self._el.appendChild(self._content)

    def _contentElement(self):
        return self._content

    def setTitle(self, title):
        self._title = str(title)
        self._legend.textContent = self._title

    title = property(lambda self: self._title, lambda self, v: self.setTitle(v))

    def setCheckable(self, v):
        self._checkable = bool(v)

    def setChecked(self, v):
        self._checked = bool(v)
        self.toggled.emit(self._checked)

    def isChecked(self):
        return self._checked

    checked = property(lambda self: self._checked, lambda self, v: self.setChecked(v))

    def setFlat(self, v):
        pass


class QScrollArea(QWidget):
    def setWidget(self, widget):
        self._widget = widget
        widget.setParent(self)
        self._el.appendChild(widget._el)

    def widget(self):
        return getattr(self, "_widget", None)

    def setWidgetResizable(self, v):
        pass

    def setHorizontalScrollBarPolicy(self, p):
        pass

    def setVerticalScrollBarPolicy(self, p):
        pass


class QStackedWidget(QWidget):
    currentChanged = Signal("currentChanged(int)")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._pages = []
        self._current = -1

    def addWidget(self, widget):
        self._pages.append(widget)
        widget.setParent(self)
        self._el.appendChild(widget._el)
        if self._current < 0:
            self.setCurrentIndex(0)
        else:
            widget.setVisible(False)
        return len(self._pages) - 1

    def setCurrentIndex(self, index):
        self._current = index
        for i, p in enumerate(self._pages):
            p.setVisible(i == index)
        self.currentChanged.emit(index)

    def setCurrentWidget(self, widget):
        if widget in self._pages:
            self.setCurrentIndex(self._pages.index(widget))

    def currentIndex(self):
        return self._current

    def currentWidget(self):
        return self._pages[self._current] if 0 <= self._current < len(self._pages) else None

    def count(self):
        return len(self._pages)

    def widget(self, index):
        return self._pages[index]


class QTabWidget(QWidget):
    currentChanged = Signal("currentChanged(int)")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._tabs = []
        self._current = -1

    def _init_element(self):
        self._bar = dom.create("div", "flex gap-[2px] border-b border-input")
        self._pagesEl = dom.create("div", "pt-2 flex flex-col gap-1.5")
        self._el.appendChild(self._bar)
        self._el.appendChild(self._pagesEl)
        self._buttons = []

    def addTab(self, widget, label, *args):
        if not isinstance(label, str):
            label = args[0] if args else ""
        index = len(self._tabs)
        self._tabs.append((widget, label))
        widget.setParent(self)
        self._pagesEl.appendChild(widget._el)
        button = dom.create("button", "rounded-t px-3 py-1 text-[12px]")
        button.textContent = label
        dom.listen(button, "click", lambda *a, i=index: self.setCurrentIndex(i))
        self._bar.appendChild(button)
        self._buttons.append(button)
        if self._current < 0:
            self.setCurrentIndex(0)
        else:
            widget.setVisible(False)
        return index

    def setCurrentIndex(self, index):
        self._current = index
        for i, (w, _) in enumerate(self._tabs):
            w.setVisible(i == index)
            self._buttons[i].className = "rounded-t px-3 py-1 text-[12px] " + ("bg-accent text-foreground" if i == index else "text-muted-foreground")
        self.currentChanged.emit(index)

    def currentIndex(self):
        return self._current

    def count(self):
        return len(self._tabs)

    def widget(self, index):
        return self._tabs[index][0]

    def setTabText(self, index, text):
        self._buttons[index].textContent = text

    def tabText(self, index):
        return self._tabs[index][1]


class QSplitter(QWidget):
    def addWidget(self, widget):
        widget.setParent(self)
        self._el.appendChild(widget._el)

    def setOrientation(self, o):
        pass

    def setSizes(self, sizes):
        pass


class QDialog(QWidget):
    accepted = Signal("accepted()")
    rejected = Signal("rejected()")
    finished = Signal("finished(int)")
    Accepted, Rejected = 1, 0

    def exec_(self):
        logger.warning("Modal dialogs are not supported in the browser; returning Rejected")
        return self.Rejected

    exec = exec_

    def accept(self):
        self.accepted.emit()
        self.finished.emit(1)

    def reject(self):
        self.rejected.emit()
        self.finished.emit(0)

    def setModal(self, v):
        pass


class QMainWindow(QWidget):
    pass


class QMenu(QWidget):
    triggered = Signal("triggered(QAction*)")
    aboutToShow = Signal("aboutToShow()")

    def __init__(self, *args):
        parent = next((a for a in args if isinstance(a, QWidget)), None)
        super().__init__(parent)
        self._actions = []

    def addAction(self, action, *args):
        if isinstance(action, str):
            from .types import QAction

            action = QAction(action, self)
        self._actions.append(action)
        return action

    def actions(self):
        return list(self._actions)

    def addSeparator(self):
        return None

    def addMenu(self, menu):
        return menu

    def exec_(self, *args):
        return None

    exec = exec_

    def popup(self, *args):
        pass

    def clear(self):
        self._actions = []


class QListWidget(QWidget):
    currentRowChanged = Signal("currentRowChanged(int)")
    itemSelectionChanged = Signal("itemSelectionChanged()")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._items = []
        self._current = -1

    def addItem(self, text):
        self._items.append(str(text))
        row = dom.create("div", "px-2 py-0.5 text-[13px] rounded hover:bg-accent/60 cursor-pointer")
        row.textContent = str(text)
        index = len(self._items) - 1
        dom.listen(row, "click", lambda *a, i=index: self.setCurrentRow(i))
        self._el.appendChild(row)

    def addItems(self, texts):
        for t in texts:
            self.addItem(t)

    def setCurrentRow(self, row):
        self._current = row
        self.currentRowChanged.emit(row)
        self.itemSelectionChanged.emit()

    def currentRow(self):
        return self._current

    def count(self):
        return len(self._items)

    def clear(self):
        self._items = []
        self._el.innerHTML = ""


class QTableWidget(QWidget):
    """Minimal table (read-only display)."""

    def __init__(self, *args):
        parent = next((a for a in args if isinstance(a, QWidget)), None)
        super().__init__(parent)
        self._rows, self._cols = 0, 0
        self._data = {}
        self._headers = []

    def setRowCount(self, n):
        self._rows = int(n)
        self._render()

    def setColumnCount(self, n):
        self._cols = int(n)
        self._render()

    def rowCount(self):
        return self._rows

    def columnCount(self):
        return self._cols

    def setHorizontalHeaderLabels(self, labels):
        self._headers = list(labels)
        self._render()

    def setItem(self, row, col, item):
        self._data[(row, col)] = item.text() if hasattr(item, "text") and callable(item.text) else str(item)
        self._render()

    def item(self, row, col):
        from .types import QTableWidgetItem

        return QTableWidgetItem(self._data.get((row, col), ""))

    def _render(self):
        rows = ["<table class='w-full text-[12px]'>"]
        if self._headers:
            rows.append("<tr>" + "".join(f"<th class='text-left text-muted-foreground'>{h}</th>" for h in self._headers) + "</tr>")
        for r in range(self._rows):
            rows.append("<tr>" + "".join(f"<td>{self._data.get((r, c), '')}</td>" for c in range(self._cols)) + "</tr>")
        rows.append("</table>")
        try:
            self._el.innerHTML = "".join(rows)
        except Exception:
            pass

    def horizontalHeader(self):
        return _Header()

    def verticalHeader(self):
        return _Header()

    def setEditTriggers(self, t):
        pass

    def setSelectionBehavior(self, b):
        pass

    def resizeColumnsToContents(self):
        pass


class _Header:
    def __getattr__(self, name):
        return lambda *a, **k: None

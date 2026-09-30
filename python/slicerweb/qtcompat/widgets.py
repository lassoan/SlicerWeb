"""Qt widget and layout classes implemented with Slicer web widgets (custom elements).

Each class keeps the Python-side state (properties, children, signals) and mirrors it to a DOM
element. User interaction on the element updates the Python state and emits the Qt signal.
"""

import logging

from . import dom
from .core import QObject, QProp, Signal, count_property, text_property
from .types import QAbstractItemView

logger = logging.getLogger("slicerweb.qt")


def _bool(v):
    return bool(v)


def _float(v):
    return float(v)


def _int(v):
    return int(v)


def _children(el):
    return [el.children.item(i) for i in range(el.children.length)]


def _empty(el):
    """Whether an item of a form row shows nothing, as Qt's layout items are empty: a hidden widget,
    a layout of items that are all empty, a label given as empty text."""
    if el.style.display == "none":
        return True
    if el.hasAttribute("data-layout"):
        return all(_empty(child) for child in _children(el))
    if el.hasAttribute("data-form-label"):
        return not (el.textContent or "").strip()
    return False


def _refresh_form_row(el):
    """Hide a row of a form layout when everything in it is empty - its label and its field, or the
    widget across it - and show it again when anything is shown: a row takes room of its own (and
    the spacing around it), which hidden widgets must not leave behind. Qt skips such rows too. A
    label given as text keeps its row, as a label does in Qt when only its field is hidden.
    el: the row, or an element in it (a widget of a layout in the field's cell, say)."""
    try:
        row = el
        # up through the layouts and the field's cell a widget can be in
        while row is not None and not row.hasAttribute("data-form-row") and (
                row.hasAttribute("data-layout") or row.hasAttribute("data-form-field")):
            row = row.parentElement
        if row is None or not row.hasAttribute("data-form-row"):
            return
        items = []
        for child in _children(row):
            items.extend(_children(child) if child.hasAttribute("data-form-field") else [child])
        hidden = bool(items) and all(_empty(item) for item in items)
        row.style.display = "none" if hidden else ""
    except Exception:
        pass


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

    def _destroy(self):
        """Release the widget: its element, its event listeners and its signal connections.

        A page element holds the Python callbacks listening to it, and those hold the widget, so a
        module GUI that is only dropped from the page stays alive (and its module with it). This is
        what makes a reloaded module leave nothing of the old one behind.
        """
        for child in list(self._children):
            destroy = getattr(child, "_destroy", None)
            if destroy is not None:
                destroy()
        for event, proxy in getattr(self, "_listeners", ()):
            try:
                self._el.removeEventListener(event, proxy)
                proxy.destroy()
            except Exception:
                logger.debug("Removing the %s listener failed", event, exc_info=True)
        self._listeners = []
        try:
            self._el.remove()
        except Exception:
            pass
        self.disconnect()
        self._children = []
        self._parent = None

    def setObjectName(self, value):
        """Name the element too (data-name="<objectName>"), for styling, tests and debugging."""
        super().setObjectName(value)
        try:
            self._el.setAttribute("data-name", self._objectName)
        except Exception:
            pass

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
            _refresh_form_row(self._el.parentElement)
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

    # Geometry: the page lays the widgets out, so the size is asked of it rather than computed here
    def _elementSize(self):
        """Size of the element in the page, or what the style sheet gives a control that is not shown
        yet. Module code sizes other widgets from it (a row of buttons beside a selector), so zero
        would not do: it is taken for a hint that was never filled in, and sizes come out negative."""
        width = height = 0
        try:
            rect = self._el.getBoundingClientRect()
            width, height = int(rect.width), int(rect.height)
        except Exception:
            pass
        return width or 120, height or 28   # 28: height of a control (h-7) in slicerweb-widgets.css

    @property
    def sizeHint(self):
        # Qt property (PythonQt: widget.sizeHint.height()); QSize is callable, so sizeHint() also works
        from .types import QSize

        return QSize(*self._elementSize())

    @property
    def minimumSizeHint(self):
        from .types import QSize

        return QSize(*self._elementSize())

    def adjustSize(self):
        pass

    def repaint(self):
        """Nothing to do: the browser paints when Python returns control."""

    def update(self):
        """Nothing to do: the browser paints when Python returns control."""

    def updateGeometry(self):
        pass

    def setSizePolicy(self, *args):
        pass

    def setMinimumWidth(self, width):
        pass

    def setMinimumHeight(self, height):
        pass

    def setMaximumWidth(self, width):
        pass

    def setMaximumHeight(self, height):
        pass

    def setFixedWidth(self, width):
        pass

    def setFixedHeight(self, height):
        pass

    def setFixedSize(self, *args):
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

    # a Qt property: modules set it (label.styleSheet = "...") as well as call it
    styleSheet = text_property(lambda self: self._styleSheet, setStyleSheet)

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

    def setFrameStyle(self, style):
        """Shape and shadow in one value, as Qt takes them (e.g. StyledPanel | Sunken)."""
        self.setFrameShape(style & 0x0F)
        self.setFrameShadow(style & 0xF0)


# --------------------------------------------------------------------------- layouts
class QLayout(QObject):
    _classes = "flex flex-col gap-1.5 min-w-0"

    def __init__(self, parent=None):
        super().__init__(None)
        self._el = dom.create("div", self._classes)
        # a layout has nothing to show of its own: a form row of one whose widgets are all hidden is
        # hidden too (_refresh_form_row)
        try:
            self._el.setAttribute("data-layout", "")
        except Exception:
            pass
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

    def addStrut(self, size):
        """At least this size across the layout's direction (the height of a row, the width of a
        column)."""
        try:
            self._el.style.minHeight = f"{int(size)}px"
        except Exception:
            pass

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
        self._el.appendChild(self._row(label, field))

    def insertRow(self, index, label, field=None):
        rows = list(self._el.children)
        row = self._row(label, field)
        if 0 <= int(index) < len(rows):
            self._el.insertBefore(row, rows[int(index)])
        else:
            self._el.appendChild(row)

    def _row(self, label, field=None):
        # sw-form-row: label and field side by side, stacked when the panel is narrow (main.css)
        row = dom.create("div", "sw-form-row min-w-0")
        row.setAttribute("data-form-row", "")
        if field is None:
            # single widget/layout spanning the row
            item = label
            row.className = "min-w-0"
            self._appendItem(row, item)
        else:
            if isinstance(label, str):
                span = dom.create("span", "sw-form-label truncate text-[12px] text-muted-foreground")
                span.textContent = label
                span.setAttribute("data-form-label", "")
                row.appendChild(span)
            else:
                self._appendItem(row, label)
            cell = dom.create("div", "min-w-0")
            cell.setAttribute("data-form-field", "")
            self._appendItem(cell, field)
            row.appendChild(cell)
        _refresh_form_row(row)
        return row

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
    # Tracks are sized by their content by default, which makes wide cells (a row of buttons, a long
    # label) overflow the module panel; minmax(0, auto) lets them shrink to the width available.
    _classes = "grid gap-1.5 min-w-0 [grid-auto-columns:minmax(0,auto)]"

    def addWidget(self, widget, row=0, column=0, rowSpan=1, columnSpan=1, *args):
        self._place(widget, row, column, rowSpan, columnSpan)

    # the spacing between cells is the page's (as setSpacing of any layout)
    def setHorizontalSpacing(self, spacing):
        pass

    def setVerticalSpacing(self, spacing):
        pass

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
            el.style.minWidth = "0"
            el.style.maxWidth = "100%"
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
        self._listeners = []
        for event, handler in self._events.items():
            proxy = dom.listen(self._el, event, getattr(self, handler))
            if proxy is not None:
                self._listeners.append((event, proxy))

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

    def group(self):
        """The QButtonGroup the button is in, or None."""
        return getattr(self, "_group", None)

    def setIcon(self, icon):
        """Show the icon of the button (a module resource file, or a Slicer application icon)."""
        from . import icons

        path = getattr(icon, "_path", icon if isinstance(icon, str) else None)
        dom.set_prop(self._el, "icon", icons.icon_url(path))

    def setIconSize(self, size):
        width = getattr(size, "width", None)
        if callable(width) and int(width()) > 0:
            dom.set_prop(self._el, "iconSize", int(width()))

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

    def menu(self):
        return getattr(self, "_menu", None)

    def setPopupMode(self, mode):
        pass

    def setToolButtonStyle(self, style):
        pass

    def setAutoRaise(self, v):
        pass

    def setDefault(self, v):
        dom.set_prop(self._el, "primary", bool(v))


class QPushButton(QAbstractButton):
    # fills the width its layout gives it, as a push button does in Qt (main.css)
    _classes = "sw-push-button"


class QDialogButtonBox(QWidget):
    """A row of dialog buttons: standard ones (Apply, Restore Defaults, ...) or ones with a text and a
    role. The box says which role was clicked through accepted/rejected/clicked, as in Qt."""

    # Qt's StandardButton values
    NoButton, Ok, Save, SaveAll, Open, Yes, YesToAll, No, NoToAll = 0, 0x400, 0x800, 0x1000, 0x2000, 0x4000, 0x8000, 0x10000, 0x20000
    Abort, Retry, Ignore, Close, Cancel, Discard, Help = 0x40000, 0x80000, 0x100000, 0x200000, 0x400000, 0x800000, 0x1000000
    Apply, Reset, RestoreDefaults = 0x2000000, 0x4000000, 0x8000000
    # ButtonRole
    InvalidRole, AcceptRole, RejectRole, DestructiveRole, ActionRole, HelpRole = -1, 0, 1, 2, 3, 4
    YesRole, NoRole, ResetRole, ApplyRole = 5, 6, 7, 8

    _STANDARD = {
        0x400: ("OK", 0), 0x800: ("Save", 0), 0x1000: ("Save All", 0), 0x2000: ("Open", 0), 0x4000: ("Yes", 5),
        0x8000: ("Yes to All", 5), 0x10000: ("No", 6), 0x20000: ("No to All", 6), 0x40000: ("Abort", 1),
        0x80000: ("Retry", 0), 0x100000: ("Ignore", 0), 0x200000: ("Close", 1), 0x400000: ("Cancel", 1),
        0x800000: ("Discard", 2), 0x1000000: ("Help", 4), 0x2000000: ("Apply", 8), 0x4000000: ("Reset", 7),
        0x8000000: ("Restore Defaults", 7),
    }

    accepted = Signal("accepted()")
    rejected = Signal("rejected()")
    clicked = Signal("clicked(QAbstractButton*)")
    helpRequested = Signal("helpRequested()")

    def __init__(self, *args):
        buttons = next((a for a in args if isinstance(a, int)), 0)
        parent = next((a for a in args if isinstance(a, QWidget)), None)
        super().__init__(parent)
        self.setLayout(QHBoxLayout())
        self._buttons = []  # [(button, role, standard button or None)]
        self.setStandardButtons(buttons)

    def addButton(self, button, role=None):
        standard = None
        if isinstance(button, int):
            standard = button
            text, role = self._STANDARD.get(button, ("", self.InvalidRole))
            button = QPushButton(text)
        elif isinstance(button, str):
            button = QPushButton(button)
        role = self.InvalidRole if role is None else role
        self._buttons.append((button, role, standard))
        self.layout().addWidget(button)
        button.clicked.connect(lambda *a, b=button, r=role: self._onClicked(b, r))
        return button

    def _onClicked(self, button, role):
        self.clicked.emit(button)
        if role in (self.AcceptRole, self.YesRole):
            self.accepted.emit()
        elif role in (self.RejectRole, self.NoRole):
            self.rejected.emit()
        elif role == self.HelpRole:
            self.helpRequested.emit()

    def setStandardButtons(self, buttons):
        for standard in self._STANDARD:
            if buttons & standard:
                self.addButton(standard)

    def standardButtons(self):
        result = 0
        for _, _, standard in self._buttons:
            result |= standard or 0
        return result

    def button(self, which):
        return next((b for b, _, s in self._buttons if s == which), None)

    def buttons(self):
        return [b for b, _, _ in self._buttons]

    def buttonRole(self, button):
        return next((r for b, r, _ in self._buttons if b is button), self.InvalidRole)


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
        # the element's own value too: a click changes only the native control, and an uncheck by the
        # button group later would otherwise not change the value and leave the control checked
        dom.set_prop(self._el, "checked", self.checked)
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

    def group(self):
        """The QButtonGroup the button is in, or None (QAbstractButton::group)."""
        return getattr(self, "_group", None)


class QRadioButton(QCheckBox):
    """A radio button: round, and exclusive - checking it unchecks the others of its button group, or,
    when it is in none, the other radio buttons of the same parent that are in none either (Qt's
    autoExclusive)."""

    def __init__(self, text="", parent=None):
        super().__init__(text, parent)
        dom.set_prop(self._el, "radio", True)

    def _uncheckSiblings(self):
        if self.group() is not None or not self.checked:
            return
        parent = self.parent()
        if parent is None:
            return
        for sibling in parent.findChildren(QRadioButton):
            if sibling is not self and sibling.parent() is parent and sibling.group() is None and sibling.checked:
                sibling.setChecked(False)

    def _onToggled(self, checked):
        super()._onToggled(checked)
        self._uncheckSiblings()

    def setChecked(self, v):
        super().setChecked(v)
        self._uncheckSiblings()


class QComboBox(_ElementWidget):
    _tag = "sw-combobox"
    _classes = ""
    _events = {"currentIndexChanged": "_onIndexChanged"}

    # QComboBox::SizeAdjustPolicy: how the box sizes itself to its contents. The web widget is
    # sized by its row, so the policy is accepted and kept, and changes nothing.
    AdjustToContents, AdjustToContentsOnFirstShow, AdjustToMinimumContentsLength, AdjustToMinimumContentsLengthWithIcon = 0, 1, 2, 3

    def setSizeAdjustPolicy(self, policy):
        self._sizeAdjustPolicy = policy

    def sizeAdjustPolicy(self):
        return getattr(self, "_sizeAdjustPolicy", QComboBox.AdjustToContentsOnFirstShow)

    currentIndexChanged = Signal("currentIndexChanged(int)")
    currentTextChanged = Signal("currentTextChanged(QString)")
    activated = Signal("activated(int)")
    textActivated = Signal("textActivated(QString)")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._itemTexts = []
        self._itemData = []   # Qt::UserRole, what itemData() and findData() give by default
        self._itemRoles = []  # the other roles (Qt::ToolTipRole, ...) of each item
        self._currentIndex = -1

    def _sync(self):
        # an item with a tooltip is handed over with it
        items = [{"text": text, "toolTip": str(roles[3])} if 3 in roles else text
                 for text, roles in zip(self._itemTexts, self._itemRoles)]
        dom.set_prop(self._el, "items", items)
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
        self._itemRoles.append({})
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
        self._itemRoles.insert(index, {})
        self._sync()

    def removeItem(self, index):
        if 0 <= index < len(self._itemTexts):
            del self._itemTexts[index]
            del self._itemData[index]
            del self._itemRoles[index]
            if self._currentIndex >= len(self._itemTexts):
                self._currentIndex = len(self._itemTexts) - 1
            self._sync()

    def clear(self):
        self._itemTexts, self._itemData, self._itemRoles = [], [], []
        self._currentIndex = -1
        self._sync()

    count = count_property(lambda self: len(self._itemTexts))

    def itemText(self, index):
        return self._itemTexts[index] if 0 <= index < len(self._itemTexts) else ""

    # Qt::ItemDataRole: DisplayRole 0 (the text), UserRole 256 (the data, the default)
    _DisplayRole, _UserRole = 0, 256

    def itemData(self, index, role=None):
        if not 0 <= index < len(self._itemData):
            return None
        role = self._UserRole if role is None else int(role)
        if role == self._UserRole:
            return self._itemData[index]
        if role == self._DisplayRole:
            return self._itemTexts[index]
        return self._itemRoles[index].get(role)

    def setItemData(self, index, value, role=None):
        """Set a role of an item: its data (Qt::UserRole, the default), its text, or another
        role such as Qt::ToolTipRole, shown when the item is pointed at."""
        if not 0 <= index < len(self._itemData):
            return
        role = self._UserRole if role is None else int(role)
        if role == self._UserRole:
            self._itemData[index] = value
        elif role == self._DisplayRole:
            self._itemTexts[index] = str(value)
            self._sync()
        else:
            self._itemRoles[index][role] = value
            self._sync()

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

    @property
    def currentData(self):
        """Qt property (PythonQt: comboBox.currentData); also callable as currentData()."""
        from .core import property_value

        index = self.currentIndex
        data = self._itemData[index] if 0 <= index < len(self._itemData) else None
        return property_value(data)

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
    """Multi-line text (the view follows the text, so scrolling to the cursor is automatic)."""

    _tag = "sw-textedit"
    _classes = ""
    _events = {"textChanged": "_onTextChanged"}

    textChanged = Signal("textChanged()")

    plainText = QProp("", el="plainText", convert=str)
    readOnly = QProp(False, el="readOnly", convert=_bool)
    placeholderText = QProp("", el="placeholderText", convert=str)

    def setTextInteractionFlags(self, flags):
        # Whether the text can be selected or edited with mouse and keyboard; read-only is readOnly
        pass

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

    def ensureCursorVisible(self):
        """Scroll to the end, which is where a log that is being appended to is read."""
        try:
            self._el.scrollTop = self._el.scrollHeight
        except Exception:
            pass

    def moveCursor(self, *args):
        self.ensureCursorVisible()

    def append(self, text):
        self.setPlainText((self.plainText + "\n" if self.plainText else "") + str(text))
        self.ensureCursorVisible()

    def insertPlainText(self, text):
        self.setPlainText(self.plainText + str(text))

    def insertHtml(self, html):
        """Rich text goes in as its text: the view shows plain text."""
        from .types import QTextDocument

        self.insertPlainText(QTextDocument(html).toPlainText())

    def clear(self):
        self.setPlainText("")

    def setReadOnly(self, v):
        self.readOnly = v

    def setLineWrapMode(self, m):
        pass

    def verticalScrollBar(self):
        return _ScrollBar()


class QPlainTextEdit(QTextEdit):
    """A text edit that keeps only the last so many lines, as a log view does."""

    def __init__(self, text="", parent=None):
        super().__init__(text, parent)
        self._maximumBlockCount = 0

    def setMaximumBlockCount(self, count):
        """Keep at most this many lines; 0, the default, keeps all of them."""
        self._maximumBlockCount = int(count)
        self._trim()

    def maximumBlockCount(self):
        return self._maximumBlockCount

    def blockCount(self):
        return len(self.plainText.split("\n")) if self.plainText else 0

    def setPlainText(self, text):
        super().setPlainText(text)
        self._trim()

    def appendPlainText(self, text):
        self.append(text)

    def _trim(self):
        limit = self._maximumBlockCount
        if limit <= 0:
            return
        lines = self.plainText.split("\n")
        if len(lines) > limit:
            # Straight to the base class: setPlainText is what called this.
            super().setPlainText("\n".join(lines[-limit:]))


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

    count = count_property(lambda self: len(self._pages))

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

    count = count_property(lambda self: len(self._tabs))

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

    def setToolTipsVisible(self, visible):
        self._toolTipsVisible = bool(visible)

    def toolTipsVisible(self):
        return getattr(self, "_toolTipsVisible", False)


class QListWidgetItem:
    """An item of a QListWidget: a text, a tool tip, data by role."""

    DisplayRole, ToolTipRole, UserRole = 0, 3, 256

    def __init__(self, *args):
        from .types import QIcon

        texts = [a for a in args if isinstance(a, str)]
        self._text = texts[0] if texts else ""
        self._toolTip = ""
        self._data = {}
        self._flags = None
        self._list = None
        self._icon = None
        for a in args:
            if isinstance(a, QListWidget):
                a.addItem(self)
            elif isinstance(a, QIcon):
                self._icon = a

    def _changed(self):
        if self._list is not None:
            self._list._render()

    def text(self):
        return self._text

    def setText(self, text):
        self._text = str(text)
        self._changed()

    def toolTip(self):
        return self._toolTip

    def setToolTip(self, text):
        self._toolTip = str(text)
        self._changed()

    def data(self, role):
        if role == self.DisplayRole:
            return self._text
        if role == self.ToolTipRole:
            return self._toolTip
        return self._data.get(int(role))

    def setData(self, role, value):
        if role == self.DisplayRole:
            self.setText(value)
        elif role == self.ToolTipRole:
            self.setToolTip(value)
        else:
            self._data[int(role)] = value

    def flags(self):
        return self._flags

    def setFlags(self, flags):
        self._flags = flags

    def icon(self):
        from .types import QIcon

        return self._icon if self._icon is not None else QIcon()

    def setIcon(self, icon):
        self._icon = icon
        self._changed()

    def listWidget(self):
        return self._list


class QListWidget(QWidget, QAbstractItemView):
    currentRowChanged = Signal("currentRowChanged(int)")
    currentItemChanged = Signal("currentItemChanged(QListWidgetItem*,QListWidgetItem*)")
    itemSelectionChanged = Signal("itemSelectionChanged()")
    itemClicked = Signal("itemClicked(QListWidgetItem*)")
    itemDoubleClicked = Signal("itemDoubleClicked(QListWidgetItem*)")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._items = []  # QListWidgetItem
        self._current = -1
        self._selectionCleared = False
        self._iconSize = 16
        self._viewMode = 0  # QListView.ListMode

    def setIconSize(self, size):
        width = getattr(size, "width", None)
        self._iconSize = int(width()) if callable(width) else int(size)
        self._render()

    def iconSize(self):
        from .types import QSize

        return QSize(self._iconSize, self._iconSize)

    def setViewMode(self, mode):
        """ListMode (rows) or IconMode (a grid of icons with their text below): a QListView enum,
        or its name as a .ui file gives it ("QListView::IconMode")."""
        if isinstance(mode, str):
            mode = 1 if mode.endswith("IconMode") else 0
        self._viewMode = int(mode)
        self._render()

    def viewMode(self):
        return self._viewMode

    def addItem(self, item):
        if not isinstance(item, QListWidgetItem):
            item = QListWidgetItem(str(item))
        item._list = self
        self._items.append(item)
        self._render()

    def addItems(self, texts):
        for t in texts:
            self.addItem(t)

    def insertItem(self, row, item):
        self.addItem(item)
        self._items.insert(int(row), self._items.pop())
        self._render()

    def item(self, row):
        row = int(row)
        return self._items[row] if 0 <= row < len(self._items) else None

    def row(self, item):
        return self._items.index(item) if item in self._items else -1

    def takeItem(self, row):
        row = int(row)
        if not 0 <= row < len(self._items):
            return None
        item = self._items.pop(row)
        item._list = None
        if self._current >= len(self._items):
            self._current = len(self._items) - 1
        self._render()
        return item

    def findItems(self, text, *args):
        return [item for item in self._items if item.text() == text]

    def currentItem(self):
        return self.item(self._current)

    def setCurrentItem(self, item):
        self.setCurrentRow(self.row(item))

    def selectedItems(self):
        item = self.currentItem()
        return [item] if item is not None and not self._selectionCleared else []

    def clearSelection(self):
        """As in Qt: nothing is selected, the current item stays what it is."""
        if not self._selectionCleared:
            self._selectionCleared = True
            self._render()
            self.itemSelectionChanged.emit()

    def setCurrentRow(self, row):
        previous = self.currentItem()
        self._current = row
        self._selectionCleared = False
        self._render()
        self.currentRowChanged.emit(row)
        self.currentItemChanged.emit(self.currentItem(), previous)
        self.itemSelectionChanged.emit()

    def currentRow(self):
        return self._current

    count = count_property(lambda self: len(self._items))

    def clear(self):
        self._items = []
        self._current = -1
        self._render()

    def _onRowClicked(self, row):
        self.setCurrentRow(row)
        self.itemClicked.emit(self.item(row))

    def _render(self):
        from . import icons

        el = self._el
        if el is None:
            return
        while el.firstChild:
            el.removeChild(el.firstChild)
        iconMode = self._viewMode == 1
        el.style.display = "flex"
        el.style.flexDirection = "row" if iconMode else "column"
        el.style.flexWrap = "wrap" if iconMode else "nowrap"
        el.style.gap = "4px" if iconMode else "0"
        for index, item in enumerate(self._items):
            selected = " bg-accent" if index == self._current and not self._selectionCleared else ""
            layout = " flex flex-col items-center p-1 text-center" if iconMode else " flex items-center gap-1.5 px-2 py-0.5"
            row = dom.create("div", "text-[13px] rounded hover:bg-accent/60 cursor-pointer" + layout + selected)
            path = getattr(item._icon, "_path", None)
            url = icons.icon_url(path) if path else ""
            if url:
                image = dom.create("img", "object-contain shrink-0")
                image.src = url
                image.style.width = image.style.height = f"{self._iconSize}px"
                row.appendChild(image)
            text = dom.create("span")
            text.textContent = item.text()
            if iconMode:
                text.style.maxWidth = f"{max(self._iconSize, 64)}px"
            row.appendChild(text)
            if item.toolTip():
                row.title = item.toolTip()
            dom.listen(row, "click", lambda *a, i=index: self._onRowClicked(i))
            el.appendChild(row)

    def setSelectionMode(self, mode):
        pass

    def setAlternatingRowColors(self, enabled):
        pass

    def setSortingEnabled(self, enabled):
        pass

    def sortItems(self, *args):
        pass


class QProgressDialog(QWidget):
    """Progress of a long computation: its range, value and label are kept. It is not drawn: the
    page shows the log, and nothing here blocks while it runs. It is never cancelled."""

    canceled = Signal("canceled()")

    minimumDuration = QProp(4000)
    windowModality = QProp(0)
    autoClose = QProp(True)
    autoReset = QProp(True)

    def __init__(self, *args):
        parent = next((a for a in args if isinstance(a, QWidget)), None)
        super().__init__(parent)
        self._minimum, self._maximum, self._value = 0, 100, -1
        self._labelText = ""
        texts = [a for a in args if isinstance(a, str)]
        if texts:
            self._labelText = texts[0]

    def setLabelText(self, text):
        self._labelText = str(text)

    def labelText(self):
        return self._labelText

    def setCancelButton(self, button):
        pass

    def setCancelButtonText(self, text):
        pass

    def setRange(self, minimum, maximum):
        self._minimum, self._maximum = int(minimum), int(maximum)

    def setMinimum(self, value):
        self._minimum = int(value)

    def setMaximum(self, value):
        self._maximum = int(value)

    def minimum(self):
        return self._minimum

    def maximum(self):
        return self._maximum

    def setValue(self, value):
        self._value = int(value)

    def value(self):
        return self._value

    def wasCanceled(self):
        return False

    def reset(self):
        self._value = -1

    def cancel(self):
        self.canceled.emit()

    def setMinimumDuration(self, ms):
        self.minimumDuration = ms

    def setWindowModality(self, modality):
        self.windowModality = modality

    def setAutoClose(self, value):
        self.autoClose = value

    def setAutoReset(self, value):
        self.autoReset = value


class QTableWidget(QWidget, QAbstractItemView):
    """Minimal table (read-only display). Qt's item view enums are its own (qt.QTableWidget.SelectRows)."""

    def __init__(self, *args):
        parent = next((a for a in args if isinstance(a, QWidget)), None)
        super().__init__(parent)
        self._rows, self._cols = 0, 0
        self._data = {}
        self._cellWidgets = {}  # (row, column) -> widget shown in the cell
        self._headers = []

    def setRowCount(self, n):
        self._rows = int(n)
        self._render()

    def setColumnCount(self, n):
        self._cols = int(n)
        self._render()

    # properties in PythonQt: modules set them (table.rowCount = n) as well as read them
    rowCount = count_property(lambda self: self._rows, lambda self, n: self.setRowCount(n))
    columnCount = count_property(lambda self: self._cols, lambda self, n: self.setColumnCount(n))

    def setHorizontalHeaderLabels(self, labels):
        self._headers = list(labels)
        self._render()

    def setItem(self, row, col, item):
        self._data[(row, col)] = item.text() if hasattr(item, "text") and callable(item.text) else str(item)
        self._render()

    def item(self, row, col):
        from .types import QTableWidgetItem

        return QTableWidgetItem(self._data.get((row, col), ""))

    def setCellWidget(self, row, column, widget):
        """A widget shown in a cell instead of its text (a label, a button)."""
        self._cellWidgets[(int(row), int(column))] = widget
        if widget is not None:
            widget._parent = self
        self._render()

    def cellWidget(self, row, column):
        return self._cellWidgets.get((int(row), int(column)))

    def removeCellWidget(self, row, column):
        self._cellWidgets.pop((int(row), int(column)), None)
        self._render()

    def setRowHeight(self, row, height):
        pass  # rows are as high as what is in them

    def _render(self):
        el = self._el
        if el is None:
            return
        while el.firstChild:
            el.removeChild(el.firstChild)
        table = dom.create("table", "w-full text-[12px]")
        if self._headers:
            tr = dom.create("tr")
            for header in self._headers:
                th = dom.create("th", "text-left text-muted-foreground")
                th.textContent = str(header)
                tr.appendChild(th)
            table.appendChild(tr)
        for r in range(self._rows):
            tr = dom.create("tr")
            for c in range(self._cols):
                td = dom.create("td")
                widget = self._cellWidgets.get((r, c))
                if widget is not None and widget._el is not None:
                    td.appendChild(widget._el)
                else:
                    td.textContent = str(self._data.get((r, c), ""))
                tr.appendChild(td)
            table.appendChild(tr)
        el.appendChild(table)

    def horizontalHeader(self):
        return QHeaderView()

    def verticalHeader(self):
        return QHeaderView()

    def setEditTriggers(self, t):
        pass

    # Selection and layout options (display only: the table is read-only)
    cellChanged = Signal("cellChanged(int,int)")
    cellClicked = Signal("cellClicked(int,int)")
    itemSelectionChanged = Signal("itemSelectionChanged()")
    customContextMenuRequested = Signal("customContextMenuRequested(QPoint)")

    def setColumnHidden(self, column, hidden):
        pass

    def hideColumn(self, column):
        pass

    def showColumn(self, column):
        pass

    def setColumnWidth(self, column, width):
        pass

    def setSelectionMode(self, mode):
        pass

    def setSelectionBehavior(self, behavior):
        pass

    def setContextMenuPolicy(self, policy):
        pass

    def resizeColumnsToContents(self):
        pass

    def resizeRowsToContents(self):
        pass

    def setSortingEnabled(self, enabled):
        pass

    def selectedItems(self):
        return []

    def currentRow(self):
        return -1

    def clearContents(self):
        self._data = {}
        self._render()

    def clear(self):
        self._data = {}
        self._cellWidgets = {}
        self._headers = []
        self._render()

    def setSelectionBehavior(self, b):
        pass

    def resizeColumnsToContents(self):
        pass


class QTableView(QTableWidget):
    """A table of a model in Qt; here the same read-only table as QTableWidget. Modules mostly use it
    for Qt's item view enums (qt.QTableView.SelectRows)."""


class QTreeWidgetItem:
    """An item of a QTreeWidget: a text, data and tool tip per column, a check state, children."""

    DisplayRole, ToolTipRole, CheckStateRole, UserRole = 0, 3, 10, 256
    ShowIndicator, DontShowIndicator, DontShowIndicatorWhenChildless = 0, 1, 2

    def __init__(self, *args):
        self._texts, self._data, self._toolTips, self._checks = {}, {}, {}, {}
        self._flags = None
        self._children = []
        self._parent = None
        self._tree = None
        self._expanded = False
        for arg in args:
            if isinstance(arg, QTreeWidget):
                arg.addTopLevelItem(self)
            elif isinstance(arg, QTreeWidgetItem):
                arg.addChild(self)
            elif isinstance(arg, (list, tuple)):
                self._texts = {i: str(t) for i, t in enumerate(arg)}

    def _changed(self, column=0):
        tree = self.treeWidget()
        if tree is not None:
            tree._render()
            tree.itemChanged.emit(self, column)

    def text(self, column=0):
        return self._texts.get(int(column), "")

    def setText(self, column, text):
        self._texts[int(column)] = str(text)
        self._changed(column)

    def data(self, column, role):
        if role == self.DisplayRole:
            return self.text(column)
        if role == self.CheckStateRole:
            return self.checkState(column)
        if role == self.ToolTipRole:
            return self.toolTip(column)
        return self._data.get((int(column), int(role)))

    def setData(self, column, role, value):
        if role == self.DisplayRole:
            self.setText(column, value)
        elif role == self.CheckStateRole:
            self.setCheckState(column, value)
        elif role == self.ToolTipRole:
            self.setToolTip(column, value)
        else:
            self._data[(int(column), int(role))] = value

    def toolTip(self, column=0):
        return self._toolTips.get(int(column), "")

    def setToolTip(self, column, text):
        self._toolTips[int(column)] = str(text)
        self._changed(column)

    def checkState(self, column=0):
        return self._checks.get(int(column), 0)

    def setCheckState(self, column, state):
        self._checks[int(column)] = int(state)
        self._changed(column)

    def flags(self):
        return self._flags

    def setFlags(self, flags):
        self._flags = flags

    def columnCount(self):
        return max(self._texts, default=-1) + 1

    def addChild(self, item):
        if item._parent is not None:
            item._parent._children.remove(item)
        item._parent = self
        self._children.append(item)
        tree = self.treeWidget()
        if tree is not None:
            tree._render()

    def addChildren(self, items):
        for item in items:
            self.addChild(item)

    def insertChild(self, index, item):
        self.addChild(item)
        self._children.insert(int(index), self._children.pop())
        if self.treeWidget() is not None:
            self.treeWidget()._render()

    def takeChild(self, index):
        item = self._children.pop(int(index))
        item._parent = None
        if self.treeWidget() is not None:
            self.treeWidget()._render()
        return item

    def removeChild(self, item):
        if item in self._children:
            self.takeChild(self._children.index(item))

    def child(self, index):
        index = int(index)
        return self._children[index] if 0 <= index < len(self._children) else None

    def childCount(self):
        return len(self._children)

    def indexOfChild(self, item):
        return self._children.index(item) if item in self._children else -1

    def parent(self):
        # the tree's invisible root is no one's parent, as in Qt
        return None if self._parent is None or self._parent._tree is not None else self._parent

    def treeWidget(self):
        item = self
        while item._parent is not None:
            item = item._parent
        return item._tree

    def setExpanded(self, expanded):
        self._expanded = bool(expanded)

    def isExpanded(self):
        return self._expanded

    def setChildIndicatorPolicy(self, policy):
        pass

    def setTextAlignment(self, column, alignment):
        pass

    def setIcon(self, column, icon):
        pass

    def setForeground(self, column, brush):
        pass

    def setBackground(self, column, brush):
        pass

    def setFont(self, column, font):
        pass


class QTreeWidget(QWidget, QAbstractItemView):
    """A tree of items in columns, drawn as an indented table; clicking an item makes it current."""

    currentItemChanged = Signal("currentItemChanged(QTreeWidgetItem*,QTreeWidgetItem*)")
    itemClicked = Signal("itemClicked(QTreeWidgetItem*,int)")
    itemDoubleClicked = Signal("itemDoubleClicked(QTreeWidgetItem*,int)")
    itemChanged = Signal("itemChanged(QTreeWidgetItem*,int)")
    itemSelectionChanged = Signal("itemSelectionChanged()")
    itemExpanded = Signal("itemExpanded(QTreeWidgetItem*)")
    itemCollapsed = Signal("itemCollapsed(QTreeWidgetItem*)")

    def __init__(self, *args):
        parent = next((a for a in args if isinstance(a, QWidget)), None)
        super().__init__(parent)
        self._root = QTreeWidgetItem()
        self._root._tree = self
        self._columns = 1
        self._headers = []
        self._current = None
        self._headerHidden = False

    columnCount = count_property(lambda self: self._columns, lambda self, n: self.setColumnCount(n))
    topLevelItemCount = count_property(lambda self: self._root.childCount())

    def setColumnCount(self, n):
        self._columns = int(n)
        self._render()

    def setHeaderLabels(self, labels):
        self._headers = [str(label) for label in labels]
        self._columns = max(self._columns, len(self._headers))
        self._render()

    def setHeaderLabel(self, label):
        self.setHeaderLabels([label])

    def headerItem(self):
        return QTreeWidgetItem(list(self._headers))

    def header(self):
        return QHeaderView()

    def setHeaderHidden(self, hidden):
        self._headerHidden = bool(hidden)
        self._render()

    def invisibleRootItem(self):
        return self._root

    def addTopLevelItem(self, item):
        self._root.addChild(item)

    def addTopLevelItems(self, items):
        for item in items:
            self._root.addChild(item)

    def insertTopLevelItem(self, index, item):
        self._root.insertChild(index, item)

    def topLevelItem(self, index):
        return self._root.child(index)

    def indexOfTopLevelItem(self, item):
        return self._root.indexOfChild(item)

    def takeTopLevelItem(self, index):
        item = self._root.takeChild(index)
        if item is self._current:
            self.setCurrentItem(None)
        return item

    def clear(self):
        self._root._children = []
        self._current = None
        self._render()

    def currentItem(self):
        return self._current

    def setCurrentItem(self, item, *args):
        previous, self._current = self._current, item
        if previous is not item:
            self._render()
            self.currentItemChanged.emit(item, previous)
            self.itemSelectionChanged.emit()

    def selectedItems(self):
        return [self._current] if self._current is not None else []

    def _onRowClicked(self, item):
        self.setCurrentItem(item)
        self.itemClicked.emit(item, 0)

    def _render(self):
        el = self._el
        if el is None:
            return
        while el.firstChild:
            el.removeChild(el.firstChild)
        table = dom.create("table", "w-full text-[12px]")
        if self._headers and not self._headerHidden:
            row = dom.create("tr", "")
            for text in self._headers:
                cell = dom.create("th", "text-left text-muted-foreground font-normal")
                cell.textContent = text
                row.appendChild(cell)
            table.appendChild(row)

        def add(item, depth):
            row = dom.create("tr", "cursor-pointer" + (" bg-accent" if item is self._current else ""))
            for column in range(self._columns):
                cell = dom.create("td", "")
                text = item.text(column)
                if column == 0:
                    try:
                        cell.style.paddingLeft = f"{depth * 14}px"
                    except Exception:
                        pass
                    if 0 in item._checks:
                        text = ("\u2611 " if item.checkState(0) else "\u2610 ") + text
                cell.textContent = text
                if item.toolTip(column):
                    cell.title = item.toolTip(column)
                row.appendChild(cell)
            dom.listen(row, "click", lambda *a, i=item: self._onRowClicked(i))
            table.appendChild(row)
            for child in item._children:
                add(child, depth + 1)

        for item in self._root._children:
            add(item, 0)
        el.appendChild(table)

    # How the tree is shown: a read-only indented table here
    def expandAll(self):
        pass

    def collapseAll(self):
        pass

    def expandItem(self, item):
        pass

    def collapseItem(self, item):
        pass

    def resizeColumnToContents(self, column):
        pass

    def setColumnWidth(self, column, width):
        pass

    def setRootIsDecorated(self, show):
        pass

    def setAlternatingRowColors(self, enabled):
        pass

    def setSelectionMode(self, mode):
        pass

    def setSelectionBehavior(self, behavior):
        pass

    def setSortingEnabled(self, enabled):
        pass

    def sortItems(self, column, order=0):
        pass

    def setUniformRowHeights(self, uniform):
        pass

    def setIndentation(self, indentation):
        pass

    def setEditTriggers(self, triggers):
        pass

    def setContextMenuPolicy(self, policy):
        pass


class QHeaderView:
    """A table's header. Modules pass its resize modes to setSectionResizeMode; the web table sizes
    its columns itself, so what the header is asked to do has no effect."""

    Interactive, Stretch, Fixed, ResizeToContents = 0, 1, 2, 3
    Custom = Fixed

    def __getattr__(self, name):
        return lambda *a, **k: None


class QButtonGroup(QObject):
    """Groups checkable buttons; exclusive by default (only one checked button)."""

    buttonClicked = Signal("buttonClicked(QAbstractButton*)")
    buttonToggled = Signal("buttonToggled(QAbstractButton*,bool)")
    idClicked = Signal("idClicked(int)")
    idToggled = Signal("idToggled(int,bool)")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._buttons = []  # [(button, id)]
        self._exclusive = True
        self._updating = False

    def addButton(self, button, id=-1):
        if any(b is button for b, _ in self._buttons):
            return
        if id == -1:
            id = -2 - len(self._buttons)
        # a button is in one group at a time, as in Qt
        previous = getattr(button, "_group", None)
        if previous is not None and previous is not self:
            previous.removeButton(button)
        self._buttons.append((button, id))
        button._group = self
        button.clicked.connect(lambda checked=False, b=button: self._onClicked(b))
        button.toggled.connect(lambda checked, b=button: self._onToggled(b, checked))

    def removeButton(self, button):
        self._buttons = [(b, i) for b, i in self._buttons if b is not button]
        if getattr(button, "_group", None) is self:
            button._group = None

    def buttons(self):
        return [b for b, _ in self._buttons]

    def button(self, id):
        return next((b for b, i in self._buttons if i == id), None)

    def id(self, button):
        return next((i for b, i in self._buttons if b is button), -1)

    def setId(self, button, id):
        self._buttons = [(b, id if b is button else i) for b, i in self._buttons]

    def checkedButton(self):
        return next((b for b, _ in self._buttons if b.isChecked()), None)

    def checkedId(self):
        b = self.checkedButton()
        return self.id(b) if b is not None else -1

    def setExclusive(self, exclusive):
        self._exclusive = bool(exclusive)

    # a property, as PythonQt has it: group.exclusive = False
    @property
    def exclusive(self):
        return self._exclusive

    @exclusive.setter
    def exclusive(self, exclusive):
        self._exclusive = bool(exclusive)

    def _onClicked(self, button):
        self.buttonClicked.emit(button)
        self.idClicked.emit(self.id(button))

    def _onToggled(self, button, checked):
        if self._updating:
            return
        if checked and self._exclusive:
            self._updating = True
            try:
                for b, _ in self._buttons:
                    if b is not button and b.isChecked():
                        b.setChecked(False)
                        self.buttonToggled.emit(b, False)
                        self.idToggled.emit(self.id(b), False)
            finally:
                self._updating = False
        self.buttonToggled.emit(button, bool(checked))
        self.idToggled.emit(self.id(button), bool(checked))

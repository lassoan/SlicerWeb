"""CTK widgets used by Slicer module GUIs."""

from . import dom
from .core import QProp, Signal
from .types import QColor
from .widgets import (
    QAbstractButton,
    QAbstractSlider,
    QAbstractSpinBox,
    QCheckBox,
    QComboBox,
    QGroupBox,
    QLabel,
    QLineEdit,
    QPushButton,
    QTextBrowser,
    QWidget,
    _ElementWidget,
    _float,
)


class ctkCollapsibleButton(QWidget):
    """Collapsible section. Children are added through its layout (usually a QFormLayout)."""

    _tag = "section"
    _classes = "sw-collapsible mb-1 rounded-md bg-card/60"

    contentsCollapsed = Signal("contentsCollapsed(bool)")
    toggled = Signal("toggled(bool)")
    clicked = Signal("clicked(bool)")

    def __init__(self, text="", parent=None):
        if isinstance(text, QWidget):
            parent, text = text, ""
        self._text = ""
        self._collapsed = False
        super().__init__(parent)
        self.setText(text)

    def _init_element(self):
        self._header = dom.create("button", "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium text-foreground hover:bg-accent/60")
        self._header.type = "button"
        self._content = dom.create("div", "flex flex-col gap-1.5 px-2 pt-0.5 pb-2 min-w-0")
        self._el.appendChild(self._header)
        self._el.appendChild(self._content)
        dom.listen(self._header, "click", lambda *a: self.setCollapsed(not self._collapsed))

    def _contentElement(self):
        return self._content

    def _renderHeader(self):
        self._header.textContent = ("▸ " if self._collapsed else "▾ ") + self._text

    def setText(self, text):
        self._text = str(text)
        self._renderHeader()

    text = property(lambda self: self._text, lambda self, v: self.setText(v))

    def setCollapsed(self, collapsed):
        collapsed = bool(collapsed)
        changed = collapsed != self._collapsed
        self._collapsed = collapsed
        try:
            self._content.style.display = "none" if collapsed else ""
        except Exception:
            pass
        self._renderHeader()
        if changed:
            self.contentsCollapsed.emit(collapsed)
            self.toggled.emit(not collapsed)

    collapsed = property(lambda self: self._collapsed, lambda self, v: self.setCollapsed(v))
    checked = property(lambda self: not self._collapsed, lambda self, v: self.setCollapsed(not v))

    def setChecked(self, v):
        self.setCollapsed(not v)

    def isChecked(self):
        return not self._collapsed

    def setCollapsedHeight(self, h):
        pass

    def setContentsFrameShape(self, s):
        pass

    def setButtonTextAlignment(self, a):
        pass


class ctkCollapsibleGroupBox(QGroupBox):
    collapsed = QProp(False)

    def setCollapsed(self, v):
        self.collapsed = v


class ctkSliderWidget(QAbstractSlider):
    pass


class ctkDoubleSlider(QAbstractSlider):
    pass


class ctkDoubleSpinBox(QAbstractSpinBox):
    def setQuantity(self, q):
        pass

    def setMRMLScene(self, scene):
        pass


class ctkRangeWidget(_ElementWidget):
    _tag = "sw-range-slider"
    _classes = ""
    _events = {"valuesChanged": "_onValuesChanged"}

    valuesChanged = Signal("valuesChanged(double,double)")
    minimumValueChanged = Signal("minimumValueChanged(double)")
    maximumValueChanged = Signal("maximumValueChanged(double)")

    minimumValue = QProp(0.0, el="minimumValue", convert=_float)
    maximumValue = QProp(100.0, el="maximumValue", convert=_float)
    minimum = QProp(0.0, el="minimum", convert=_float)
    maximum = QProp(100.0, el="maximum", convert=_float)
    singleStep = QProp(1.0, el="singleStep", convert=_float)
    decimals = QProp(1, el="decimals", convert=int)

    def __init__(self, parent=None):
        super().__init__(parent)
        for name in ("minimum", "maximum", "minimumValue", "maximumValue"):
            dom.set_prop(self._el, name, getattr(self, name))

    def _onValuesChanged(self, lo, hi):
        type(self).minimumValue.set_silently(self, lo)
        type(self).maximumValue.set_silently(self, hi)
        self.valuesChanged.emit(self.minimumValue, self.maximumValue)
        self.minimumValueChanged.emit(self.minimumValue)
        self.maximumValueChanged.emit(self.maximumValue)

    def setValues(self, lo, hi):
        self.minimumValue, self.maximumValue = lo, hi
        self.valuesChanged.emit(self.minimumValue, self.maximumValue)

    def setMinimumValue(self, v):
        self.setValues(v, self.maximumValue)

    def setMaximumValue(self, v):
        self.setValues(self.minimumValue, v)

    def setRange(self, lo, hi):
        self.minimum, self.maximum = lo, hi

    def setMinimum(self, v):
        self.minimum = v

    def setMaximum(self, v):
        self.maximum = v

    def setSingleStep(self, v):
        self.singleStep = v

    def setDecimals(self, v):
        self.decimals = v


class ctkDoubleRangeSlider(ctkRangeWidget):
    positionsChanged = Signal("positionsChanged(double,double)")


class ctkPathLineEdit(QLineEdit):
    currentPathChanged = Signal("currentPathChanged(QString)")
    Files, Dirs, Drives, NoDot = 1, 2, 4, 0x2000

    def __init__(self, parent=None):
        super().__init__("", parent)
        self.textChanged.connect(self.currentPathChanged.emit)

    currentPath = property(lambda self: self.text, lambda self, v: self.setCurrentPath(v))

    def setCurrentPath(self, path):
        self.text = path

    def addCurrentPathToHistory(self):
        pass

    def setNameFilters(self, filters):
        pass

    def setFilters(self, filters):
        pass

    def setSettingKey(self, key):
        pass

    def setShowHistoryButton(self, v):
        pass


class ctkDirectoryButton(ctkPathLineEdit):
    directoryChanged = Signal("directoryChanged(QString)")

    directory = property(lambda self: self.text, lambda self, v: self.setCurrentPath(v))


class ctkComboBox(QComboBox):
    def setDefaultText(self, text):
        pass

    def setDefaultIcon(self, icon):
        pass


class ctkCheckableComboBox(QComboBox):
    checkedIndexesChanged = Signal("checkedIndexesChanged()")

    def checkedIndexes(self):
        return [self._currentIndex] if self._currentIndex >= 0 else []


class ctkColorPickerButton(_ElementWidget):
    _tag = "sw-colorpicker"
    _classes = ""
    _events = {"colorChanged": "_onColorChanged"}

    colorChanged = Signal("colorChanged(QColor)")
    ShowColorName, UseCTKColorDialog = 1, 2

    def __init__(self, *args):
        parent = next((a for a in args if isinstance(a, QWidget)), None)
        super().__init__(parent)
        self._color = QColor(255, 255, 255)
        text = next((a for a in args if isinstance(a, str)), "")
        if text:
            dom.set_prop(self._el, "text", text)

    def _onColorChanged(self, value):
        self._color = QColor(value)
        self.colorChanged.emit(self._color)

    def setColor(self, color):
        self._color = color if isinstance(color, QColor) else QColor(color)
        dom.set_prop(self._el, "color", self._color.name())
        self.colorChanged.emit(self._color)

    color = property(lambda self: self._color, lambda self, v: self.setColor(v))

    def setDisplayColorName(self, v):
        pass

    def setDialogOptions(self, o):
        pass


class ctkPushButton(QPushButton):
    """ctkPushButton: QPushButton with icon/text alignment options (alignment is not used here)."""

    def setButtonTextAlignment(self, alignment):
        pass

    def setIconAlignment(self, alignment):
        pass


class ctkMenuButton(QPushButton):
    pass


class ctkSearchBox(QLineEdit):
    pass


class ctkFittedTextBrowser(QTextBrowser):
    pass


class ctkExpandableWidget(QWidget):
    pass


class ctkCoordinatesWidget(QWidget):
    coordinatesChanged = Signal("coordinatesChanged(double*)")

    def __init__(self, parent=None):
        super().__init__(parent)
        from .widgets import QDoubleSpinBox, QHBoxLayout

        layout = QHBoxLayout(self)
        self._boxes = []
        for i in range(3):
            box = QDoubleSpinBox()
            box.setRange(-1e6, 1e6)
            box.valueChanged.connect(lambda *a: self.coordinatesChanged.emit(self.coordinates))
            layout.addWidget(box)
            self._boxes.append(box)

    coordinates = property(lambda self: ",".join(str(b.value) for b in self._boxes),
                           lambda self, v: self.setCoordinates(v))

    def setCoordinates(self, *values):
        if len(values) == 1 and isinstance(values[0], str):
            values = [float(v) for v in values[0].split(",")]
        elif len(values) == 1:
            values = list(values[0])
        for b, v in zip(self._boxes, values):
            b.setValue(v)

    def setDecimals(self, d):
        for b in self._boxes:
            b.setDecimals(d)

    def setMinimum(self, v):
        for b in self._boxes:
            b.setMinimum(v)

    def setMaximum(self, v):
        for b in self._boxes:
            b.setMaximum(v)

    def setSingleStep(self, s):
        for b in self._boxes:
            b.setSingleStep(s)


class ctkVTKSliceView(QWidget):
    pass


class ctkMessageBox(QWidget):
    def exec_(self):
        return 0

    exec = exec_

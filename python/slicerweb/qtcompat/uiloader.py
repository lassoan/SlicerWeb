"""QUiLoader: builds widget trees from Qt Designer .ui files (used by slicer.util.loadUI)."""

import logging
import xml.etree.ElementTree as ET

logger = logging.getLogger("slicerweb.qt")


def _resolve_class(name):
    from .. import qtcompat

    import slicer

    for namespace in (qtcompat.QT_NAMESPACE, qtcompat.CTK_NAMESPACE):
        if name in namespace:
            return namespace[name]
    cls = getattr(slicer, name, None)
    if isinstance(cls, type):
        return cls
    return None


def _parse_value(element):
    """Convert a Qt Designer <property> value element to a Python value."""
    tag = element.tag
    if tag == "string":
        return element.text or ""
    if tag == "bool":
        return (element.text or "").strip().lower() == "true"
    if tag == "number":
        text = (element.text or "0").strip()
        return int(text) if text.lstrip("-").isdigit() else float(text)
    if tag == "double":
        return float(element.text or 0)
    if tag == "stringlist":
        return [s.text or "" for s in element.findall("string")]
    if tag in ("enum", "set", "cstring"):
        return (element.text or "").strip()
    if tag == "color":
        from .types import QColor

        return QColor(*(int(element.findtext(c, "0")) for c in ("red", "green", "blue")))
    return None


# Property names whose value must be applied with a setter or is irrelevant in the browser
_IGNORED = {"geometry", "sizePolicy", "minimumSize", "maximumSize", "baseSize", "font", "palette", "icon", "iconSize",
            "frameShape", "frameShadow", "alignment", "orientation", "sizeHint", "styleSheet", "layoutDirection",
            "cursor", "focusPolicy", "contextMenuPolicy", "textFormat", "tabPosition", "selectionMode",
            "editTriggers", "horizontalScrollBarPolicy", "verticalScrollBarPolicy", "autoFillBackground"}


def _apply_property(widget, name, value, dynamic=False):
    """Apply one <property> of a .ui file.

    A property marked stdset="0" is a dynamic property of the object, not a Qt property with a
    setter: Slicer uses one of those ("SlicerParameterName") to say which parameter a widget shows,
    and parameterNodeWrapper looks it up with widget.property(). Setting it as a plain attribute
    instead would leave the widget unconnected from the parameter node.
    """
    if name in _IGNORED or value is None:
        return
    if name == "objectName":
        widget.setObjectName(value)
        return
    if dynamic:
        widget.setProperty(name, value)
        return
    setter = getattr(widget, "set" + name[0].upper() + name[1:], None)
    try:
        if callable(setter):
            setter(value)
        else:
            setattr(widget, name, value)
    except Exception as e:
        logger.debug("Cannot set property %s=%r on %s: %s", name, value, type(widget).__name__, e)


class QUiLoader:
    def __init__(self, parent=None):
        pass

    def load(self, qfile, parentWidget=None):
        path = qfile.fileName() if hasattr(qfile, "fileName") else str(qfile)
        root = ET.parse(path).getroot()
        widget_el = root.find("widget")
        if widget_el is None:
            return None
        widget = self._create_widget(widget_el, parentWidget)
        return widget

    def _create_widget(self, element, parent):
        from .widgets import QLabel, QWidget

        class_name = element.get("class", "QWidget")
        cls = _resolve_class(class_name)
        if cls is None:
            logger.warning("Widget class %s is not available in the browser; showing a placeholder", class_name)
            widget = QWidget(parent)
            from .widgets import QVBoxLayout

            QVBoxLayout(widget).addWidget(QLabel(f"[{class_name}]"))
        else:
            widget = cls(parent) if parent is not None else cls()
        name = element.get("name")
        if name:
            widget.setObjectName(name)
        for prop in element.findall("property"):
            children = list(prop)
            if children:
                _apply_property(widget, prop.get("name"), _parse_value(children[0]),
                               dynamic=prop.get("stdset") == "0")
        layout_el = element.find("layout")
        if layout_el is not None:
            layout = self._create_layout(layout_el)
            widget.setLayout(layout)
            self._fill_layout(layout, layout_el, widget)
        # Tab widgets and stacked widgets contain child <widget> elements directly
        for child in element.findall("widget"):
            child_widget = self._create_widget(child, widget)
            if hasattr(widget, "addTab"):
                title = next((p.findtext("string", "") for p in child.findall("attribute") if p.get("name") == "title"), "")
                widget.addTab(child_widget, title)
            elif hasattr(widget, "addWidget"):
                widget.addWidget(child_widget)
            elif hasattr(widget, "setWidget"):
                widget.setWidget(child_widget)
        return widget

    def _create_layout(self, element):
        from .. import qtcompat

        cls = qtcompat.QT_NAMESPACE.get(element.get("class", "QVBoxLayout"), qtcompat.QT_NAMESPACE["QVBoxLayout"])
        layout = cls()
        if element.get("name"):
            layout.setObjectName(element.get("name"))
        return layout

    def _fill_layout(self, layout, element, owner):
        from .widgets import QFormLayout, QGridLayout

        rows = {}
        for item in element.findall("item"):
            content = self._item_content(item, owner)
            if content is None:
                continue
            row = int(item.get("row", "-1"))
            column = int(item.get("column", "0"))
            if isinstance(layout, QFormLayout):
                if row < 0:
                    layout.addRow(content)
                else:
                    rows.setdefault(row, {})[column] = (content, int(item.get("colspan", "1")))
            elif isinstance(layout, QGridLayout):
                layout._place(content, max(0, row), column, int(item.get("rowspan", "1")), int(item.get("colspan", "1")))
            else:
                if content == "stretch":
                    layout.addStretch()
                elif hasattr(content, "_items"):
                    layout.addLayout(content)
                else:
                    layout.addWidget(content)
        for row in sorted(rows):
            cells = rows[row]
            if 0 in cells and 1 in cells:
                layout.addRow(cells[0][0], cells[1][0])
            else:
                only = next(iter(cells.values()))[0]
                if only != "stretch":
                    layout.addRow(only)

    def _item_content(self, item, owner):
        widget_el = item.find("widget")
        if widget_el is not None:
            return self._create_widget(widget_el, owner)
        layout_el = item.find("layout")
        if layout_el is not None:
            layout = self._create_layout(layout_el)
            self._fill_layout(layout, layout_el, owner)
            return layout
        if item.find("spacer") is not None:
            return "stretch"
        return None

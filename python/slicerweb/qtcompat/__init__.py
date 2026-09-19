"""Qt/CTK compatibility layer for Python scripted modules in the browser.

Provides the ``qt`` and ``ctk`` Python modules (as used through PythonQt in desktop Slicer) and the
qMRML/qSlicer widgets in the ``slicer`` namespace. Widgets are rendered with the Slicer web widgets
(custom elements), so module GUIs written for desktop Slicer (Python code or Qt Designer .ui files)
work in the browser.
"""

from . import core, ctkwidgets, mrmlwidgets, types, uiloader, widgets

QT_NAMESPACE = {}
CTK_NAMESPACE = {}

for _module in (core, types, widgets):
    for _name, _obj in vars(_module).items():
        if _name.startswith("Q") or _name in ("Qt", "Signal", "Slot"):
            QT_NAMESPACE[_name] = _obj
QT_NAMESPACE["QUiLoader"] = uiloader.QUiLoader
QT_NAMESPACE["Signal"] = core.Signal
QT_NAMESPACE["Slot"] = lambda *a, **k: (lambda f: f)
QT_NAMESPACE["QT_VERSION"] = 0x060000
QT_NAMESPACE["QT_VERSION_STR"] = "6.0.0 (SlicerWeb)"

for _name, _obj in vars(ctkwidgets).items():
    if _name.startswith("ctk"):
        CTK_NAMESPACE[_name] = _obj


def install_slicer_widgets():
    """Add qMRML*/qSlicer* widget classes to the slicer namespace (desktop: PythonQt wrappers)."""
    import slicer

    for name, cls in mrmlwidgets.WIDGETS.items():
        if not hasattr(slicer, name):
            setattr(slicer, name, cls)

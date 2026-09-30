"""Which Qt, CTK and Slicer widget names the Python code of extensions uses that SlicerWeb lacks.

SlicerWeb's qt and ctk modules (python/slicerweb/qtcompat) stand in for PythonQt's, and have only
what has been written so far. A module that uses something else - qt.QHeaderView, say - fails when
its panel is built, which is only found by opening the panel. This finds those names without a
browser: it reads the names SlicerWeb defines, and looks for qt.<Name>, ctk.<Name> and
slicer.qMRML*/qSlicer* in the extensions' Python files, and for the widget classes of their Qt
Designer (.ui) files, where a class SlicerWeb lacks becomes an empty placeholder.

    python3 scripts/check_qt_names.py [extension install dir ...]   (default /build/install/ext)

Prints each missing name with where it is used, and exits with 1 if any is missing. It reads source
text, so a name in a comment or a string counts too; what it reports is to be looked at, not trusted
blindly.

It also lists the Qt properties that the code reads or sets but SlicerWeb has as methods
(self.ui.button.checkState == qt.Qt.Checked, label.styleSheet = "..."): the code then gets a bound
method instead of the value, or replaces the method, and nothing says so.
"""
import ast
import glob
import os
import re
import sys

QTCOMPAT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python", "slicerweb", "qtcompat")


def top_level_names(path):
    names = set()
    tree = ast.parse(open(path, encoding="utf8").read(), path)
    for node in tree.body:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
    return names


def provided():
    """The names of the qt and ctk modules and the slicer widget classes, as qtcompat/__init__.py
    assembles them: Q* of core, types and widgets (and a few set there), ctk* of ctkwidgets, and
    qMRML*/qSlicer* of mrmlwidgets."""
    # (Line: Qt Designer's line, which the .ui loader makes a QFrame)
    qt = {"Qt", "Signal", "Slot", "QUiLoader", "QT_VERSION", "QT_VERSION_STR", "Line"}
    for module in ("core", "types", "widgets"):
        qt |= {n for n in top_level_names(os.path.join(QTCOMPAT, module + ".py")) if n.startswith("Q")}
    ctk = {n for n in top_level_names(os.path.join(QTCOMPAT, "ctkwidgets.py")) if n.startswith("ctk")}
    widgets = {n for n in top_level_names(os.path.join(QTCOMPAT, "mrmlwidgets.py"))
               if n.startswith(("qMRML", "qSlicer"))}
    # and those the rest of SlicerWeb's Python puts into slicer (slicer.qSlicer... = ...)
    for file in os.listdir(os.path.join(QTCOMPAT, "..")):
        if file.endswith(".py"):
            text = open(os.path.join(QTCOMPAT, "..", file), encoding="utf8").read()
            widgets |= set(re.findall(r"^\s*slicer\.(q(?:MRML|Slicer)\w*)\s*=", text, re.M))
    return {"qt": qt, "ctk": ctk, "slicer": widgets}


# <widget class="..."> of a .ui file (layouts and spacers are elements of other names)
UI_WIDGET = re.compile(r'<widget\s+class="(\w+)"')

PATTERNS = {
    "qt": re.compile(r"\bqt\.([A-Za-z_]\w*)"),
    "ctk": re.compile(r"\bctk\.(ctk\w*)"),
    "slicer": re.compile(r"\bslicer\.(q(?:MRML|Slicer)\w*)"),
}


def methods_used_as_properties(roots):
    """self.ui.<widget>.<name> neither called nor passed on (as a slot, say), where the class the
    .ui file gives the widget has <name> as a method: {"Class.name": [(extension, file:line)]}."""
    import inspect
    import xml.etree.ElementTree as ET

    sys.path.insert(0, os.path.join(QTCOMPAT, "..", ".."))
    from slicerweb.qtcompat import core, ctkwidgets, mrmlwidgets, types, widgets

    modules = [widgets, ctkwidgets, mrmlwidgets, types, core]
    found = {}
    for root in roots:
        for extension in sorted(os.listdir(root)):
            for directory, _, files in os.walk(os.path.join(root, extension)):
                classes = {}
                for ui in glob.glob(os.path.join(directory, "Resources", "UI", "*.ui")):
                    try:
                        classes.update({w.get("name"): w.get("class") for w in ET.parse(ui).iter("widget")})
                    except ET.ParseError:
                        pass
                for file in (f for f in files if f.endswith(".py")):
                    text = open(os.path.join(directory, file), encoding="utf8", errors="replace").read()
                    for match in re.finditer(r"self\.ui\.(\w+)\.(\w+)\b(?!\s*[(),])", text):
                        widget, name = match.groups()
                        cls = next((getattr(m, classes[widget]) for m in modules if hasattr(m, classes.get(widget) or "")), None)
                        if cls is not None and inspect.isfunction(inspect.getattr_static(cls, name, None)):
                            line = text[:match.start()].count("\n") + 1
                            found.setdefault(f"{cls.__name__}.{name}", []).append((extension, f"{file}:{line}"))
    return found


def main(roots):
    have = provided()
    missing = {}  # (module, name) -> [(extension, file)]
    for root in roots:
        for extension in sorted(os.listdir(root)):
            for directory, _, files in os.walk(os.path.join(root, extension)):
                for file in files:
                    path = os.path.join(directory, file)
                    if file.endswith(".ui"):
                        text = open(path, encoding="utf8", errors="replace").read()
                        for name in set(UI_WIDGET.findall(text)):
                            if not any(name in names for names in have.values()):
                                missing.setdefault(("ui", name), []).append((extension, file))
                        continue
                    if not file.endswith(".py"):
                        continue
                    # without comment lines: a name mentioned there is not used
                    text = "".join(line for line in open(path, encoding="utf8", errors="replace")
                                   if not line.lstrip().startswith("#"))
                    for module, pattern in PATTERNS.items():
                        for name in set(pattern.findall(text)):
                            if name not in have[module]:
                                missing.setdefault((module, name), []).append((extension, file))
    for (module, name), uses in sorted(missing.items()):
        extensions = sorted({e for e, _ in uses})
        files = sorted({f for _, f in uses})
        print(f"{module}.{name}: {', '.join(extensions)} ({', '.join(files[:4])}{', ...' if len(files) > 4 else ''})")
    print(f"{len(missing)} missing name(s)")
    properties = methods_used_as_properties(roots)
    for name, uses in sorted(properties.items()):
        print(f"property {name}: {', '.join(sorted({e for e, _ in uses}))} ({', '.join(u for _, u in uses[:4])})")
    print(f"{len(properties)} method(s) used as properties")
    return 1 if missing or properties else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["/build/install/ext"]))

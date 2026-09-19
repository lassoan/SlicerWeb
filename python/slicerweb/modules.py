"""Qt-free equivalent of qSlicerModuleManager / qSlicerModuleFactoryManager.

Three kinds of modules are supported, mirroring desktop Slicer:

- **Loadable (C++) modules**: their MRML, Logic, VTKWidgets and MRMLDM libraries are the same C++
  code as in desktop Slicer. The Qt part (``qSlicer<Name>Module``) is replaced by a small descriptor
  (:class:`LoadableModuleDescriptor`) that creates the logic and performs the non-GUI setup that the
  Qt module class does in desktop Slicer. The GUI is provided by a web widget.
- **Scripted (Python) modules**: ``ScriptedLoadableModule`` subclasses defined in ``.py`` files,
  loaded unchanged. Their widgets use the ``qt``/``ctk`` compatibility layer or a web widget.
- **Extension modules**: loadable or scripted modules shipped in extension wheels, registered through
  the ``slicerweb.modules`` entry point group or by adding a module path.

Each module is available as ``slicer.modules.<lowercasename>`` with the familiar API
(``logic()``, ``name``, ``title``, ``categories``, ``path``, ``widgetRepresentation()``).
"""

import builtins
import glob
import importlib
import importlib.util
import logging
import os
import sys

from . import host

logger = logging.getLogger("slicerweb.modules")


class ModuleBase:
    """Common API of loadable and scripted modules (subset of qSlicerAbstractCoreModule)."""

    def __init__(self, name, title=None, categories=None, dependencies=None, path="", hidden=False,
                 helpText="", acknowledgementText="", contributors=None, webWidget=None, icon=None):
        self.name = name
        self.title = title or name
        self.categories = list(categories or [])
        self.dependencies = list(dependencies or [])
        self.path = path
        self.hidden = hidden
        self.helpText = helpText
        self.acknowledgementText = acknowledgementText
        self.contributors = list(contributors or [])
        self.webWidget = webWidget
        self.icon = icon
        self._logic = None
        self._widget = None
        self._app = None

    # qSlicerAbstractCoreModule API
    def logic(self):
        return self._logic

    def isHidden(self):
        return self.hidden

    def widgetRepresentation(self):
        return self._widget

    def createNewWidgetRepresentation(self):
        return None

    def summary(self):
        return {
            "name": self.name,
            "title": self.title,
            "categories": self.categories,
            "dependencies": self.dependencies,
            "hidden": self.hidden,
            "kind": self.kind,
            "helpText": self.helpText,
            "acknowledgementText": self.acknowledgementText,
            "contributors": self.contributors,
            "webWidget": self.webWidget,
            "icon": self.icon,
        }

    def __repr__(self):
        return f"<{type(self).__name__} {self.name}>"


class LoadableModuleDescriptor(ModuleBase):
    """A C++ loadable module (Qt module class replaced by this descriptor)."""

    kind = "loadable"

    def __init__(self, name, logicClass=None, setup=None, **kwargs):
        super().__init__(name, **kwargs)
        self.logicClass = logicClass
        self._setup = setup

    def initialize(self, app):
        """Same as qSlicerAbstractCoreModule::initialize: create logic, then setup()."""
        import slicer

        self._app = app
        if self.logicClass:
            cls = getattr(slicer, self.logicClass, None)
            if cls is None:
                raise RuntimeError(f"Logic class {self.logicClass} of module {self.name} is not available")
            logic = cls()
            if isinstance(logic, slicer.vtkSlicerModuleLogic):
                logic.SetModuleShareDirectory(module_share_directory(app, self.name))
            logic.SetMRMLApplicationLogic(app.applicationLogic())
            if self._setup is not None and getattr(self._setup, "before_scene", False):
                self._setup(self, app, logic)
            logic.SetMRMLScene(app.mrmlScene())
            app.applicationLogic().SetModuleLogic(self.name, logic)
            self._logic = logic
        if self._setup is not None and not getattr(self._setup, "before_scene", False):
            self._setup(self, app, self._logic)


class ScriptedModule(ModuleBase):
    """A Python scripted module (qSlicerScriptedLoadableModule equivalent)."""

    kind = "scripted"

    def __init__(self, name, path, pythonModule, instance, **kwargs):
        parent_info = _parent_info(instance)
        kwargs.setdefault("title", parent_info.get("title"))
        kwargs.setdefault("categories", parent_info.get("categories"))
        kwargs.setdefault("dependencies", parent_info.get("dependencies"))
        kwargs.setdefault("hidden", parent_info.get("hidden", False))
        kwargs.setdefault("helpText", parent_info.get("helpText", ""))
        kwargs.setdefault("acknowledgementText", parent_info.get("acknowledgementText", ""))
        kwargs.setdefault("contributors", parent_info.get("contributors"))
        kwargs.setdefault("webWidget", getattr(instance, "webWidget", None))
        super().__init__(name, path=path, **kwargs)
        self.pythonModule = pythonModule
        self.instance = instance

    def initialize(self, app):
        self._app = app
        # ScriptedLoadableModule does not create a logic automatically (qSlicerScriptedLoadableModule
        # creates an empty vtkSlicerScriptedLoadableModuleLogic); logic() returns the widget's logic.
        if hasattr(self.instance, "setup"):
            pass

    def logic(self):
        widget = self._widget
        if widget is not None and hasattr(widget, "logic"):
            return widget.logic
        logic_cls = getattr(self.pythonModule, self.name + "Logic", None)
        if self._logic is None and logic_cls is not None:
            try:
                self._logic = logic_cls()
            except TypeError:
                self._logic = None
        return self._logic


class _ModuleParent:
    """Stand-in for the ``parent`` (qSlicerScriptedLoadableModule) of ScriptedLoadableModule."""

    def __init__(self, name, path):
        self._name = name
        self.path = path
        self.title = name
        self.categories = []
        self.dependencies = []
        self.contributors = []
        self.helpText = ""
        self.acknowledgementText = ""
        self.hidden = False
        self.icon = None
        self.index = 0

    def name(self):
        return self._name

    def setProperty(self, name, value):
        setattr(self, name, value)

    def property(self, name):
        return getattr(self, name, None)

    @builtins.property  # (this class defines a property() method, like QObject)
    def defaultDocumentationLink(self):
        """qSlicerAbstractCoreModule::defaultDocumentationLink"""
        import slicer

        url = slicer.app.moduleDocumentationUrl(self._name)
        return f'<p>For more information see the <a href="{url}">online documentation</a>.</p>'

    def setObjectName(self, name):
        pass

    def objectName(self):
        return self._name


def _parent_info(instance):
    parent = getattr(instance, "parent", None)
    if parent is None:
        return {}
    return {
        "title": getattr(parent, "title", None),
        "categories": list(getattr(parent, "categories", []) or []),
        "dependencies": list(getattr(parent, "dependencies", []) or []),
        "hidden": bool(getattr(parent, "hidden", False)),
        "helpText": getattr(parent, "helpText", "") or "",
        "acknowledgementText": getattr(parent, "acknowledgementText", "") or "",
        "contributors": list(getattr(parent, "contributors", []) or []),
    }


def module_share_directory(app, name):
    """vtkSlicerApplicationLogic::GetModuleShareDirectory equivalent for built-in modules."""
    return os.path.join(app.slicerSharePath, "qt-loadable-modules", name)


class ModuleManager:
    """Module registry (qSlicerModuleManager). Qt-style signals: moduleLoaded(QString),
    moduleAboutToBeUnloaded(QString), modulesLoaded(QStringList)."""

    def __init__(self, app):
        self._app = app
        self._slots = {}
        self._modules = {}  # name -> module
        self._descriptors = {}  # name -> descriptor, not yet loaded
        self._modulePaths = []
        self._scripted_sources = {}  # name -> (path)
        # Python modules (packages) missing when a scripted module was imported: {package: [module names]}.
        # The web page loads them (Pyodide packages or PyPI wheels) and loads the modules again.
        self.missingPythonModules = {}
        self._register_builtin_descriptors()

    # ------------------------------------------------------------------ Qt-style signals
    def connect(self, signal, slot):
        self._slots.setdefault(signal.split("(")[0], []).append(slot)
        return True

    def disconnect(self, signal, slot=None):
        name = signal.split("(")[0]
        if slot is None:
            self._slots.pop(name, None)
        elif slot in self._slots.get(name, []):
            self._slots[name].remove(slot)

    def _emit(self, name, *args):
        for slot in list(self._slots.get(name, [])):
            try:
                slot(*args)
            except Exception:
                logger.exception("Error in %s handler", name)

    # ------------------------------------------------------------------ registration
    def _register_builtin_descriptors(self):
        from .core_modules import CORE_MODULES

        for descriptor in CORE_MODULES():
            self._descriptors[descriptor.name] = descriptor

    def registerLoadableModule(self, descriptor):
        """Register a loadable module descriptor (used by extensions)."""
        self._descriptors[descriptor.name] = descriptor

    def addModulePath(self, path):
        """Add a directory (or .py file) containing scripted modules (like Slicer's additional module paths)."""
        if path not in self._modulePaths:
            self._modulePaths.append(path)
        # Packages next to scripted modules (e.g. SegmentEditorEffects, SubjectHierarchyPlugins) are
        # importable, as in desktop Slicer
        directory = path if os.path.isdir(path) else os.path.dirname(path)
        if directory not in sys.path:
            sys.path.insert(0, directory)
        for name, filename in _discover_scripted_modules(path).items():
            self._scripted_sources.setdefault(name, filename)

    def _discover_extension_entry_points(self):
        try:
            from importlib.metadata import entry_points
        except ImportError:  # pragma: no cover
            return
        for ep in entry_points(group="slicerweb.modules"):
            try:
                provider = ep.load()
                result = provider() if callable(provider) else provider
            except Exception:
                logger.exception("Failed to load module provider %s", ep.name)
                continue
            for item in result or []:
                if isinstance(item, LoadableModuleDescriptor):
                    self.registerLoadableModule(item)
                elif isinstance(item, str):
                    self.addModulePath(item)

    # ------------------------------------------------------------------ loading
    def loadModules(self, names=None):
        """Load modules (all registered modules if names is None), dependencies first."""
        import slicer

        self._discover_extension_entry_points()
        from . import libs

        loadable_dir = libs.loadable_modules_lib_dir()
        if loadable_dir and os.path.isdir(loadable_dir):
            _import_module_python_extensions(loadable_dir)
            if loadable_dir not in sys.path:
                sys.path.append(loadable_dir)  # e.g. vtkvmtk*Python modules of extensions
            self._register_described_loadable_modules(loadable_dir)
        # Python scripted modules of the application and of installed extensions (same folder as the
        # desktop application's lib/Slicer-X.Y/qt-scripted-modules)
        scripted_dir = libs.scripted_modules_lib_dir()
        if scripted_dir and os.path.isdir(scripted_dir):
            self.addModulePath(scripted_dir)
            # Python plugin packages imported at startup by desktop Slicer's Subject Hierarchy and
            # Segmentations modules (their base classes are then importable by name)
            for package in ("SubjectHierarchyPlugins", "SegmentEditorEffects"):
                if package not in sys.modules and os.path.isdir(os.path.join(scripted_dir, package)):
                    try:
                        importlib.import_module(package)
                    except Exception:
                        logger.warning("Python package %s could not be imported", package, exc_info=True)
        self._initializeCoreDisplayableManagers()

        requested = list(names) if names else list(self._descriptors) + list(self._scripted_sources)
        loaded = [name for name in requested if name not in self._modules and self.loadModule(name) is not None]
        host.emit("modules-changed", self.moduleSummaries())
        self._emit("modulesLoaded", loaded)

    def _register_described_loadable_modules(self, directory):
        """Loadable modules of extensions: <Name>.slicerweb-module.json files, written by the SlicerWeb
        extension build instead of the Qt module class (see cmake/UseSlicerWeb.cmake)."""
        import json

        for filename in sorted(glob.glob(os.path.join(directory, "*.slicerweb-module.json"))):
            try:
                with open(filename, encoding="utf8") as f:
                    info = json.load(f)
            except (OSError, ValueError):
                logger.exception("Invalid module description %s", filename)
                continue
            name = info.get("name")
            if not name or name in self._descriptors or name in self._modules:
                continue
            self.registerLoadableModule(LoadableModuleDescriptor(
                name, logicClass=info.get("logicClass") or None, title=info.get("title") or name,
                dependencies=info.get("dependencies") or [], path=filename,
                categories=info.get("categories") or [info.get("extension") or "Extensions"]))

    def _initializeCoreDisplayableManagers(self):
        import slicer

        initializer = getattr(slicer, "vtkSlicerWebCoreModulesInitializer", None)
        if initializer is not None:
            initializer.Initialize()
        else:
            logger.warning("vtkSlicerWebCoreModulesInitializer is not available: module displayable managers are not registered")

    def loadModule(self, name, _stack=()):
        if name in self._modules:
            return self._modules[name]
        if name in _stack:
            raise RuntimeError(f"Circular module dependency: {' -> '.join(_stack + (name,))}")
        descriptor = self._descriptors.get(name)
        if descriptor is None and name in self._scripted_sources:
            try:
                descriptor = self._createScriptedModule(name, self._scripted_sources[name])
            except ModuleNotFoundError as e:
                missing = (e.name or "").split(".")[0]
                if missing and missing not in self._scripted_sources and missing not in self._descriptors:
                    self.missingPythonModules.setdefault(missing, [])
                    if name not in self.missingPythonModules[missing]:
                        self.missingPythonModules[missing].append(name)
                    logger.info("Module %s needs Python package %s, which is not installed yet", name, missing)
                else:
                    logger.exception("Failed to load module %s", name)
                sys.modules.pop(name, None)
                return None
            except Exception:
                logger.exception("Failed to load module %s", name)
                sys.modules.pop(name, None)
                return None
        if descriptor is None:
            logger.warning("Module %s is not available", name)
            return None
        for dep in descriptor.dependencies:
            if dep not in self._modules and (dep in self._descriptors or dep in self._scripted_sources):
                self.loadModule(dep, _stack + (name,))
        try:
            descriptor.initialize(self._app)
        except Exception:
            logger.exception("Failed to initialize module %s", name)
            return None
        self._modules[name] = descriptor
        self._exposeModule(descriptor)
        self._emit("moduleLoaded", name)
        return descriptor

    def _createScriptedModule(self, name, filename):
        import slicer

        directory = os.path.dirname(filename)
        if directory not in sys.path:
            sys.path.insert(0, directory)
        # Libraries next to the module (e.g. <Name>Lib packages) are importable like in desktop Slicer
        _import_module_python_extensions(directory)
        spec = importlib.util.spec_from_file_location(name, filename)
        pythonModule = importlib.util.module_from_spec(spec)
        sys.modules[name] = pythonModule
        spec.loader.exec_module(pythonModule)
        cls = getattr(pythonModule, name, None)
        if cls is None:
            logger.warning("%s does not define class %s", filename, name)
            return None
        import slicer

        if not hasattr(slicer, "selfTests"):
            slicer.selfTests = {}
        parent = _ModuleParent(name, filename)
        instance = cls(parent)
        module = ScriptedModule(name, filename, pythonModule, instance)
        setattr(slicer.modules, name + "Instance", instance)
        return module

    def _exposeModule(self, module):
        import slicer

        setattr(slicer.modules, module.name.lower(), module)
        setattr(slicer.moduleNames, module.name, module.name)

    # ------------------------------------------------------------------ queries
    def module(self, name):
        return self._modules.get(name)

    def modulesNames(self):
        return list(self._modules)

    def moduleSummaries(self):
        return [m.summary() for m in self._modules.values()]

    def factoryManager(self):
        return self

    def loadedModulesNames(self):
        return list(self._modules)

    def registeredModuleNames(self):
        return list(set(self._descriptors) | set(self._scripted_sources))

    def isRegistered(self, name):
        return name in self._descriptors or name in self._scripted_sources

    def isLoaded(self, name):
        return name in self._modules

    # ------------------------------------------------------------------ widgets
    def setWidget(self, name, widget):
        module = self._modules.get(name)
        if module is not None:
            module._widget = widget


def show_scripted_module_widget(moduleName, containerSelector):
    """Create (once) and show the GUI of a scripted module inside a container element of the page.

    ScriptedLoadableModuleWidget.setup() runs unchanged; the qt/ctk compatibility layer creates the
    widgets as Slicer web widgets.
    """
    import slicer

    from .qtcompat import dom, mrmlwidgets, widgets

    manager = slicer.app.moduleManager()
    module = manager.module(moduleName)
    if module is None or module.kind != "scripted":
        raise KeyError(f"Scripted module {moduleName} is not loaded")
    parent = getattr(module, "_hostWidget", None)
    if parent is None:
        parent = mrmlwidgets.qMRMLWidget()
        parent.setLayout(widgets.QVBoxLayout())
        parent.setMRMLScene(slicer.mrmlScene)
        parent.setObjectName(moduleName + "WidgetParent")
        widget_cls = getattr(module.pythonModule, moduleName + "Widget", None)
        if widget_cls is None:
            raise RuntimeError(f"{moduleName} does not define a {moduleName}Widget class")
        instance = widget_cls(parent)
        instance.setup()
        module._widget = instance
        module._hostWidget = parent
        setattr(slicer.modules, moduleName + "Widget", instance)
    container = dom.query(containerSelector)
    if container is not None:
        container.appendChild(parent.element())
    if hasattr(module._widget, "enter"):
        module._widget.enter()
    return True


def hide_scripted_module_widget(moduleName):
    import slicer

    module = slicer.app.moduleManager().module(moduleName)
    parent = getattr(module, "_hostWidget", None) if module else None
    if parent is None:
        return False
    if hasattr(module._widget, "exit"):
        module._widget.exit()
    try:
        parent.element().remove()
    except Exception:
        pass
    return True


def _discover_scripted_modules(path):
    """Return {moduleName: filename} of scripted modules in a directory (or a single .py file)."""
    result = {}
    files = [path] if path.endswith(".py") else glob.glob(os.path.join(path, "*.py"))
    for filename in files:
        name = os.path.splitext(os.path.basename(filename))[0]
        if name.startswith("_"):
            continue
        try:
            with open(filename, encoding="utf8") as f:
                text = f.read()
        except OSError:
            continue
        if f"class {name}(ScriptedLoadableModule)" in text or f"class {name}(slicer.ScriptedLoadableModule" in text \
                or f"class {name}(ScriptedLoadableModule.ScriptedLoadableModule)" in text:
            result[name] = filename
    return result


def _import_module_python_extensions(directory):
    """Same as qSlicerScriptedUtils::importModulePythonExtensions (C++ module classes into slicer)."""
    from slicer.util import importVTKClassesFromDirectory

    for pattern in ("vtkSlicer*ModuleLogicPython.*", "vtkSlicer*ModuleMRMLPython.*",
                    "vtkSlicer*ModuleMRMLDisplayableManagerPython.*", "vtkSlicer*ModuleVTKWidgetsPython.*",
                    "vtkSlicerWeb*InitializerPython.*"):
        try:
            importVTKClassesFromDirectory(directory, "slicer", filematch=pattern)
        except Exception:
            logger.exception("Failed to import %s from %s", pattern, directory)

"""Qt-free equivalent of qSlicerCoreApplication / qSlicerApplication for the browser."""

import logging
import os
import sys
import tempfile

from . import host
from .settings import Settings

logger = logging.getLogger("slicerweb")

from .qtcompat.core import property_value  # noqa: E402


_APP_SIGNALS = ("startupCompleted", "mrmlSceneChanged", "aboutToQuit", "lastWindowClosed")


class _BoundAppSignal:
    def __init__(self, app, name):
        self._app, self._name = app, name

    def connect(self, slot):
        return self._app.connect(self._name + "()", slot)

    def disconnect(self, slot=None):
        return self._app.disconnect(self._name + "()", slot)

    def emit(self, *args):
        for slot in list(self._app._slots.get(self._name, [])):
            slot(*args)


class SlicerWebApplication:
    """Application singleton, available as ``slicer.app``.

    Provides the subset of the ``qSlicerApplication`` API that Python scripted modules and
    ``slicer.util`` use, implemented on top of the same MRML and logic classes as desktop Slicer.

    Configuration keys (all optional):

    - ``home``: Slicer home directory in the virtual file system (default: package directory)
    - ``share``: share directory with Slicer resources (default: ``<home>/share/Slicer-X.Y``)
    - ``temp``: temporary directory (default: ``/tmp/Slicer``)
    - ``layout``: initial layout name, e.g. ``"FourUp"`` (default) or a vtkMRMLLayoutNode constant
    - ``modules``: list of module names to load (default: all discovered modules)
    """

    def __init__(self, config):
        self._config = dict(config)
        self._scene = None
        self._appLogic = None
        self._layoutManager = None
        self._moduleManager = None
        self._ioManager = None
        self._settings = Settings()
        self._pauseRenderCount = 0
        self._batchProcessing = False
        self._slots = {}  # Qt-style signal name -> [slots] (connect/disconnect)
        self._startupCompleted = False
        self._pendingStartupSlots = []

    # ------------------------------------------------------------------ startup
    def startup(self):
        """Create scene and application logic, then load modules (like qSlicerApplication startup)."""
        from . import libs

        libs.ensure_library_path()

        import vtk  # Slicer's lazy vtk module
        import slicer

        from . import rendering

        rendering.register_render_window_factories()

        self._setupPaths()

        scene = slicer.vtkMRMLScene()
        self._scene = scene
        self._setMRMLScene(scene)

        from .layout import LayoutManager
        from .modules import ModuleManager
        from .io import IOManager

        self._ioManager = IOManager(self)
        self._moduleManager = ModuleManager(self)
        self._layoutManager = LayoutManager(self)

        # Expose application objects in the slicer namespace, same as slicerqt.py does on desktop.
        slicer.app = self
        slicer.mrmlScene = scene
        self._installLogging()

        from . import bridge, panels, panels_markupstomodel, sample_data, segment_editor, views_data  # noqa: F401  (register module GUI bridge methods)
        from . import qtcompat

        qtcompat.install_slicer_widgets()

        from . import cli_modules, downloads, packages

        cli_modules.install()
        downloads.install()
        packages.install()

        # Python console namespace, as in the desktop Python interactor
        import __main__

        import ctk
        import numpy
        import qt

        __main__.__dict__.update(slicer=slicer, vtk=vtk, qt=qt, ctk=ctk, numpy=numpy, np=numpy)

        bridge.install_scene_observers()

        from .subject_hierarchy import SubjectHierarchyPluginLogic, install as install_subject_hierarchy

        install_subject_hierarchy()

        self._subjectHierarchyPluginLogic = SubjectHierarchyPluginLogic(scene)

        self._moduleManager.loadModules(self._config.get("modules"))
        self._layoutManager.setLayout(self._config.get("layout", "FourUp"))
        self._startupCompleted = True
        self._moduleManager.connect("modulesLoaded(QStringList)", lambda *args: self._flushStartupSlots())
        self._flushStartupSlots()
        host.emit("app-ready", {"version": self.applicationVersion, "modules": self._moduleManager.moduleSummaries()})
        return self

    def _setupPaths(self):
        from . import libs

        self._home = self._config.get("home") or libs.slicer_home()
        version = libs.slicer_version()
        self._share = self._config.get("share") or os.path.join(self._home, "share", f"Slicer-{version}")
        self._temp = self._config.get("temp") or os.path.join(tempfile.gettempdir(), "Slicer")
        os.makedirs(self._temp, exist_ok=True)
        os.makedirs(self.defaultScenePath, exist_ok=True)

    def screenScaleFactor(self):
        """vtkMRMLAbstractViewNode ScreenScaleFactor for this display.

        Markups control point glyphs, their labels and the picking tolerance are sized as
        screen diagonal * ScreenScaleFactor * glyph scale (see vtkSlicerMarkupsWidgetRepresentation).
        The screen size reported by the browser is in CSS pixels while the views render in device
        pixels, and screens are much smaller than a desktop monitor on phones and tablets: the factor
        is scaled accordingly, so that markups have about the same size as in desktop Slicer.
        """
        default = 0.2                      # vtkMRMLAbstractViewNode default
        referenceDiagonal = 2200.0         # desktop monitor (1920x1080), for which the default is set
        ratio = float(self._config.get("devicePixelRatio") or 1.0)
        width = float(self._config.get("screenWidth") or 0.0)
        height = float(self._config.get("screenHeight") or 0.0)
        diagonal = (width ** 2 + height ** 2) ** 0.5
        if diagonal <= 0:
            return default * ratio
        factor = default * ratio * referenceDiagonal / diagonal
        return min(max(factor, default), 5.0)

    def markupsTextScale(self, defaultTextScale=3.0):
        """Default markups TextScale for this display.

        Label size is font size * TextScale * ScreenScaleFactor * 5 (vtkSlicerMarkupsWidgetRepresentation),
        so it grows with the screen scale factor while the glyphs are sized relative to the screen:
        the text scale compensates, keeping labels in proportion with the control points.
        """
        factor = self.screenScaleFactor()
        ratio = float(self._config.get("devicePixelRatio") or 1.0)
        if factor <= 0:
            return defaultTextScale
        return max(0.5, defaultTextScale * 0.2 * ratio / factor)

    def applyScreenScaleFactor(self, viewNode):
        """Set the screen scale factor of a view node (called for every view of the layout)."""
        if viewNode is not None:
            viewNode.SetScreenScaleFactor(self.screenScaleFactor())

    def _setMRMLScene(self, scene):
        """Same as qSlicerCoreApplication::setMRMLScene + qSlicerCoreApplicationPrivate::init."""
        import vtk
        import slicer

        scene.SetRootDirectory(self.defaultScenePath)
        # Register the node type for command line modules
        scene.RegisterNodeClass(slicer.vtkMRMLCommandLineModuleNode())
        # Default view nodes: markups and other widgets are sized for this display (see
        # screenScaleFactor); new view nodes of the layout inherit these defaults.
        for className in ("vtkMRMLViewNode", "vtkMRMLSliceNode"):
            defaultNode = scene.GetDefaultNodeByClass(className)
            if defaultNode is None:
                defaultNode = scene.CreateNodeByClass(className)
                scene.AddDefaultNode(defaultNode)
            defaultNode.SetScreenScaleFactor(self.screenScaleFactor())

        # Markups: keep labels in proportion with the control point glyphs on this display
        markupsDisplay = scene.GetDefaultNodeByClass("vtkMRMLMarkupsDisplayNode")
        if markupsDisplay is None:
            markupsDisplay = scene.CreateNodeByClass("vtkMRMLMarkupsDisplayNode")
            scene.AddDefaultNode(markupsDisplay)
        markupsDisplay.SetTextScale(self.markupsTextScale(markupsDisplay.GetTextScale()))

        # First scene needs a crosshair to be added manually
        crosshair = slicer.vtkMRMLCrosshairNode()
        crosshair.SetCrosshairName("default")
        scene.AddNode(crosshair)

        appLogic = slicer.vtkSlicerApplicationLogic()
        appLogic.SetHomeDirectory(self._home)
        appLogic.SetShareDirectory(os.path.relpath(self._share, self._home))
        appLogic.SetTemporaryPath(self._temp)
        # Slice and view logics are registered by the views (qMRMLLayoutManager does this on desktop)
        appLogic.SetSliceLogics(vtk.vtkCollection())
        appLogic.SetViewLogics(vtk.vtkCollection())
        appLogic.SetMRMLScene(scene)
        # No processing/networking threads in the browser: CreateProcessingThread() is not called.
        # Data IO manager and cache directory (vtkMRMLScene::ReadFromMRB extracts bundles there);
        # remote downloads are not handled by the RemoteIO stub (the browser fetches URLs instead).
        remoteIOLogic = slicer.vtkMRMLRemoteIOLogic()
        os.makedirs(self.cachePath, exist_ok=True)
        remoteIOLogic.GetCacheManager().SetRemoteCacheDirectory(self.cachePath)
        dataIOManagerLogic = slicer.vtkDataIOManagerLogic()
        dataIOManagerLogic.SetMRMLApplicationLogic(appLogic)
        dataIOManagerLogic.SetAndObserveDataIOManager(remoteIOLogic.GetDataIOManager())
        appLogic.SetMRMLSceneDataIO(scene, remoteIOLogic, dataIOManagerLogic)
        self._remoteIOLogic = remoteIOLogic
        self._dataIOManagerLogic = dataIOManagerLogic
        slicer.vtkMRMLSliceViewDisplayableManagerFactory.GetInstance().SetMRMLApplicationLogic(appLogic)
        slicer.vtkMRMLThreeDViewDisplayableManagerFactory.GetInstance().SetMRMLApplicationLogic(appLogic)
        self._appLogic = appLogic

        scene.AddObserver(slicer.vtkMRMLScene.StartBatchProcessEvent, self._onStartBatchProcess)
        scene.AddObserver(slicer.vtkMRMLScene.EndBatchProcessEvent, self._onEndBatchProcess)

    def _installLogging(self):
        from .logging_handler import install

        install()

    # ------------------------------------------------------------------ qSlicerApplication API
    def mrmlScene(self):
        return self._scene

    def applicationLogic(self):
        return self._appLogic

    def layoutManager(self):
        return self._layoutManager

    def moduleManager(self):
        return self._moduleManager

    def ioManager(self):
        return self._ioManager

    def coreIOManager(self):
        return self._ioManager

    def userSettings(self):
        return self._settings

    def revisionUserSettings(self):
        return self._settings

    def settings(self):
        return self._settings

    def mainWindow(self):
        return None

    def commandOptions(self):
        return _CommandOptions()

    def processEvents(self, *args):
        """Nothing to do: the browser processes events when Python returns control."""

    def pauseRender(self):
        self._pauseRenderCount += 1
        if self._appLogic:
            self._appLogic.PauseRender()

    def resumeRender(self):
        if self._pauseRenderCount > 0:
            self._pauseRenderCount -= 1
            if self._appLogic:
                self._appLogic.ResumeRender()

    def setRenderPaused(self, paused):
        if paused:
            self.pauseRender()
        else:
            self.resumeRender()

    def isRenderPaused(self):
        return self._pauseRenderCount > 0

    def openNodeModule(self, node, role="", context=""):
        from . import host

        host.emit("select-module-for-node", {"nodeID": node.GetID() if node else None})

    @property
    def applicationName(self):
        return property_value("3D Slicer")

    @property
    def applicationVersion(self):
        from . import libs

        return property_value(libs.slicer_version_full())

    # Qt properties of qSlicerCoreApplication (attributes in PythonQt; also callable, see property_value)
    @property
    def majorVersion(self):
        return property_value(int(self.applicationVersion.split(".")[0]))

    @property
    def minorVersion(self):
        return property_value(int(self.applicationVersion.split(".")[1]))

    @property
    def patchVersion(self):
        return property_value(int(self.applicationVersion.split(".")[2]))

    @property
    def releaseType(self):
        return property_value("Preview")

    @property
    def revision(self):
        return property_value(self._config.get("revision", ""))

    @property
    def repositoryRevision(self):
        return self.revision

    @property
    def slicerHome(self):
        return property_value(self._home)

    @property
    def slicerSharePath(self):
        return property_value(self._share)

    # ------------------------------------------------------------------ Qt-style signals
    def __getattr__(self, name):
        # New-style signal access, e.g. slicer.app.startupCompleted.connect(slot)
        if name in _APP_SIGNALS:
            return _BoundAppSignal(self, name)
        raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'")

    def connect(self, signal, slot):
        """qSlicerApplication signals (e.g. startupCompleted(), used by scripted modules to finish
        their setup after all modules are loaded)."""
        name = signal.split("(")[0]
        self._slots.setdefault(name, []).append(slot)
        if name == "startupCompleted":
            self._pendingStartupSlots.append(slot)
        return True

    def disconnect(self, signal, slot=None):
        name = signal.split("(")[0]
        if slot is None:
            self._slots.pop(name, None)
        elif slot in self._slots.get(name, []):
            self._slots[name].remove(slot)
        return True

    def disconnectReceiver(self, receiver):
        """Disconnect the application signals of a receiver being destroyed (e.g. a module widget)."""
        from .qtcompat.core import disconnect_receiver, slot_belongs_to

        self._pendingStartupSlots = [s for s in self._pendingStartupSlots if not slot_belongs_to(s, receiver)]
        return disconnect_receiver(self._slots, receiver)

    def _flushStartupSlots(self):
        """Call startupCompleted() slots: at the end of startup, and for modules loaded later
        (installed extensions) after they are loaded."""
        if not self._startupCompleted:
            return
        pending, self._pendingStartupSlots = self._pendingStartupSlots, []
        for slot in pending:
            try:
                slot()
            except RuntimeError as e:
                if "Failed to obtain reference to" in str(e):
                    # desktop main window elements (menus, toolbars) do not exist in the web page
                    logger.info("%s: %s (no desktop main window)", getattr(slot, "__qualname__", slot), e)
                else:
                    logger.exception("Error in startupCompleted() handler %s", getattr(slot, "__qualname__", slot))
            except Exception:
                logger.exception("Error in startupCompleted() handler %s", getattr(slot, "__qualname__", slot))

    def topLevelWidgets(self):
        """No Qt main window in the browser (slicer.util.mainWindow() returns None)."""
        return []

    # Mouse cursor of long operations (qSlicerApplication): the page shows its own busy indicator
    def setOverrideCursor(self, cursor=None):
        from . import host

        host.emit("busy", {"busy": True})

    def restoreOverrideCursor(self):
        from . import host

        host.emit("busy", {"busy": False})

    def overrideCursor(self):
        return None

    def documentationBaseUrl(self):
        return "https://slicer.readthedocs.io/en/latest"

    def moduleDocumentationUrl(self, moduleName):
        """qSlicerCoreApplication::moduleDocumentationUrl"""
        return f"{self.documentationBaseUrl()}/user_guide/modules/{moduleName.lower()}.html"

    def translate(self, context, text, disambiguation=None, n=-1):
        """QCoreApplication::translate (slicer.i18n): no translations are installed; English text."""
        return text

    @property
    def temporaryPath(self):
        return property_value(self._temp)

    @property
    def cachePath(self):
        path = os.path.join(self._temp, "Cache")
        os.makedirs(path, exist_ok=True)
        return property_value(path)

    @property
    def defaultScenePath(self):
        return property_value(os.path.join(self._temp, "Scenes"))

    @property
    def extensionsInstallPath(self):
        return os.path.join(self._home, "Extensions")

    @property
    def platform(self):
        return "emscripten-wasm32"

    @property
    @property
    def os(self):
        return property_value("emscripten")

    @property
    def arch(self):
        return property_value("wasm32")

    @property
    def testingEnabled(self):
        return property_value(bool(self._config.get("testing", False)))

    @property
    def isInstalled(self):
        return property_value(True)

    def pythonManager(self):
        return None

    def errorLogModel(self):
        from .logging_handler import error_log

        return error_log()

    # ------------------------------------------------------------------ helpers
    def _onStartBatchProcess(self, caller, event):
        self._batchProcessing = True

    def _onEndBatchProcess(self, caller, event):
        self._batchProcessing = False


class _CommandOptions:
    """Subset of qSlicerCommandOptions."""

    noMainWindow = False
    disableMessageHandlers = False
    runPythonAndExit = False
    testingEnabled = False
    isTestingEnabled = False
    applicationInformation = False
    verboseModuleDiscovery = False
    ignoreSlicerRC = True
    displayMessageAndExit = False

    def __getattr__(self, name):  # unknown options default to False/empty
        return False

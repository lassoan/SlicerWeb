"""Qt-free equivalent of qSlicerCoreApplication / qSlicerApplication for the browser."""

import logging
import os
import sys
import tempfile

from . import host
from .settings import Settings

logger = logging.getLogger("slicerweb")


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

        from . import bridge, panels, segment_editor  # noqa: F401  (register module GUI bridge methods)
        from . import qtcompat

        qtcompat.install_slicer_widgets()

        # Python console namespace, as in the desktop Python interactor
        import __main__

        import ctk
        import numpy
        import qt

        __main__.__dict__.update(slicer=slicer, vtk=vtk, qt=qt, ctk=ctk, numpy=numpy, np=numpy)

        bridge.install_scene_observers()

        from .subject_hierarchy import SubjectHierarchyPluginLogic

        self._subjectHierarchyPluginLogic = SubjectHierarchyPluginLogic(scene)

        self._moduleManager.loadModules(self._config.get("modules"))
        self._layoutManager.setLayout(self._config.get("layout", "FourUp"))
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

    def _setMRMLScene(self, scene):
        """Same as qSlicerCoreApplication::setMRMLScene + qSlicerCoreApplicationPrivate::init."""
        import vtk
        import slicer

        scene.SetRootDirectory(self.defaultScenePath)
        # Register the node type for command line modules
        scene.RegisterNodeClass(slicer.vtkMRMLCommandLineModuleNode())
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

    def applicationName(self):
        return "3D Slicer"

    @property
    def applicationVersion(self):
        from . import libs

        return libs.slicer_version_full()

    def majorVersion(self):
        return int(self.applicationVersion.split(".")[0])

    def minorVersion(self):
        return int(self.applicationVersion.split(".")[1])

    @property
    def slicerHome(self):
        return self._home

    @property
    def slicerSharePath(self):
        return self._share

    @property
    def temporaryPath(self):
        return self._temp

    @property
    def cachePath(self):
        path = os.path.join(self._temp, "Cache")
        os.makedirs(path, exist_ok=True)
        return path

    @property
    def defaultScenePath(self):
        return os.path.join(self._temp, "Scenes")

    @property
    def extensionsInstallPath(self):
        return os.path.join(self._home, "Extensions")

    @property
    def platform(self):
        return "emscripten-wasm32"

    @property
    def os(self):
        return "emscripten"

    @property
    def arch(self):
        return "wasm32"

    @property
    def testingEnabled(self):
        return bool(self._config.get("testing", False))

    def isInstalled(self):
        return True

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

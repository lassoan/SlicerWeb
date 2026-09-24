"""Qt-free equivalent of qSlicerLayoutManager / qMRMLLayoutManager.

The layout itself (which views exist and how they are arranged) is managed by Slicer's
``vtkMRMLLayoutLogic`` and ``vtkMRMLLayoutNode``, exactly as in desktop Slicer. This class:

- converts the current layout description (Slicer layout XML) into a JSON tree that the web
  page renders as a grid of ``<canvas>`` elements (event ``layout-changed``),
- creates a :class:`vtkSlicerWebSliceView` or :class:`vtkSlicerWebThreeDView` when the web page
  reports that the canvas of a view is available (:meth:`attachView`), and destroys it when the
  canvas is removed (:meth:`detachView`),
- provides the ``slicer.app.layoutManager()`` API used by scripted modules
  (``sliceWidget("Red").sliceLogic()``, ``threeDWidget(0).threeDView().resetFocalPoint()``, ...).
"""

import logging
import xml.etree.ElementTree as ET

import vtk

from . import host
from .qtcompat.core import QObject, Signal, property_value

logger = logging.getLogger("slicerweb.layout")

SLICE_VIEW_CLASSES = ("vtkMRMLSliceNode",)
THREED_VIEW_CLASSES = ("vtkMRMLViewNode",)


def _find_view_element(description, nodeID):
    """The element of a view node in a layout description tree."""
    if description.get("type") == "view":
        return description if description.get("nodeID") == nodeID else None
    for child in description.get("children", []):
        found = _find_view_element(child, nodeID)
        if found is not None:
            return found
    return None


def _rgb_to_hex(rgb):
    return "#%02x%02x%02x" % tuple(int(max(0.0, min(1.0, c)) * 255 + 0.5) for c in rgb[:3])


class LayoutManager(QObject):
    """Announces its layout like qSlicerLayoutManager: connect('layoutChanged(int)', slot)."""
    layoutChanged = Signal("layoutChanged(int)")

    def __init__(self, app):
        import slicer

        super().__init__()
        self._app = app
        self._scene = app.mrmlScene()
        self._layoutLogic = slicer.vtkMRMLLayoutLogic()
        self._layoutLogic.SetMRMLScene(self._scene)
        self._layoutNode = self._layoutLogic.GetLayoutNode()
        self._layoutNode.AddObserver(vtk.vtkCommand.ModifiedEvent, self._onLayoutNodeModified)
        # While the scene is closed, imported or updated in a batch, the layout node is reset too:
        # the layout is published again when that finishes (see _publishLayout).
        for event in (slicer.vtkMRMLScene.EndCloseEvent, slicer.vtkMRMLScene.EndImportEvent,
                      slicer.vtkMRMLScene.EndBatchProcessEvent, slicer.vtkMRMLScene.EndRestoreEvent):
            self._scene.AddObserver(event, self._onSceneUpdated)
        self._views = {}           # layout name -> vtkSlicerWebView
        self._sharedCanvas = None  # vtkSlicerWebCanvas, when the views share one WebGL context
        self._volumeQuality = {}   # layout name -> AdaptiveVolumeQuality, for the 3D views
        self._widgets = {}  # layout name -> SliceWidget / ThreeDWidget proxy
        self._lastLayoutJson = None
        self._viewsToDetach = set()
        self._detachTimer = None
        self._pendingLayoutChanged = None   # (layout, names of views still to be attached)
        self._layoutChangedTimer = None

    # ------------------------------------------------------------------ layout selection
    def setLayout(self, layout):
        """Set layout by vtkMRMLLayoutNode constant or by name (e.g. "FourUp", "OneUpRedSlice")."""
        import slicer

        if isinstance(layout, str):
            name = layout
            candidates = [name, f"SlicerLayout{name}", f"SlicerLayout{name}View"]
            value = None
            for c in candidates:
                if hasattr(slicer.vtkMRMLLayoutNode, c):
                    value = getattr(slicer.vtkMRMLLayoutNode, c)
                    break
            if value is None:
                raise ValueError(f"Unknown layout name: {name}")
            layout = value
        self._layoutNode.SetViewArrangement(int(layout))
        # The layout node may not be modified if the arrangement did not change: always publish
        self._publishLayout(force=True)

    # Qt properties of qMRMLLayoutManager (attributes in PythonQt, also callable: see property_value)
    @property
    def layout(self):
        return property_value(self._layoutNode.GetViewArrangement())

    @layout.setter
    def layout(self, value):
        self.setLayout(value)

    def layoutLogic(self):
        return self._layoutLogic

    def layoutNode(self):
        return self._layoutNode

    @staticmethod
    def availableLayouts():
        """Return {name: id} of the standard layouts defined by vtkMRMLLayoutNode."""
        import slicer

        result = {}
        for attr in dir(slicer.vtkMRMLLayoutNode):
            if attr.startswith("SlicerLayout") and attr.endswith("View") and attr != "SlicerLayoutUserView":
                value = getattr(slicer.vtkMRMLLayoutNode, attr)
                if isinstance(value, int) and value > 0:
                    result[attr[len("SlicerLayout"):-len("View")]] = value
        return dict(sorted(result.items(), key=lambda kv: kv[1]))

    def addLayout(self, layoutId, layoutXml):
        """Register a custom layout (same as layoutNode.AddLayoutDescription)."""
        self._layoutNode.AddLayoutDescription(int(layoutId), layoutXml)

    # ------------------------------------------------------------------ layout description
    def _onLayoutNodeModified(self, caller=None, event=None):
        self._publishLayout()

    def _onSceneUpdated(self, caller=None, event=None):
        self._publishLayout(force=True)

    def layoutDescription(self):
        """Current layout as a JSON-serializable tree (see module documentation)."""
        xml = self._layoutNode.GetCurrentLayoutDescription() or ""
        viewNodes = self._viewNodesByTag()
        if not xml.strip():
            return {"type": "empty", "children": []}
        try:
            root = ET.fromstring(xml)
        except ET.ParseError:
            logger.error("Invalid layout description: %s", xml)
            return {"type": "empty", "children": []}
        description = self._convertLayoutElement(root, viewNodes)
        # A maximized view (view controller "maximize" button) is shown alone, as in desktop Slicer
        maximized = self.maximizedViewNode()
        if maximized is not None:
            view = _find_view_element(description, maximized.GetID())
            if view is not None:
                return view
        return description

    def _viewNodesByTag(self):
        import slicer

        result = {}
        views = self._layoutLogic.GetViewNodes()
        for i in range(views.GetNumberOfItems()):
            node = views.GetItemAsObject(i)
            if isinstance(node, slicer.vtkMRMLAbstractViewNode):
                result[(node.GetClassName(), node.GetLayoutName())] = node
        return result

    def _convertLayoutElement(self, element, viewNodes):
        tag = element.tag
        if tag == "layout":
            node = {
                "type": element.get("type", "horizontal"),
                "split": element.get("split", "false") == "true",
                "children": [],
            }
            for item in element.findall("item"):
                children = list(item)
                if not children:
                    continue
                child = self._convertLayoutElement(children[0], viewNodes)
                # A size of 0 is a collapsed pane (a QSplitter pane of that size), which a layout
                # uses for a view it renders off-screen; no size means an equal share.
                if item.get("splitSize") is not None:
                    child["size"] = float(item.get("splitSize") or 0)
                if item.get("row") is not None:
                    child["row"] = int(item.get("row"))
                    child["column"] = int(item.get("column", "0"))
                    child["rowSpan"] = int(item.get("rowspan", "1"))
                    child["columnSpan"] = int(item.get("colspan", "1"))
                node["children"].append(child)
            return node
        if tag == "view":
            className = element.get("class", "")
            layoutName = element.get("singletontag", "")
            viewNode = viewNodes.get((className, layoutName))
            info = {
                "type": "view",
                "className": className,
                "layoutName": layoutName,
                "kind": self._viewKind(className),
            }
            if viewNode is not None:
                info.update(self._viewInfo(viewNode))
            else:
                label = element.find("./property[@name='viewlabel']")
                info["label"] = label.text if label is not None else layoutName
            return info
        return {"type": "empty", "children": []}

    @staticmethod
    def _viewKind(className):
        if className in SLICE_VIEW_CLASSES:
            return "slice"
        if className in THREED_VIEW_CLASSES:
            return "threeD"
        if className == "vtkMRMLTableViewNode":
            return "table"
        if className == "vtkMRMLPlotViewNode":
            return "plot"
        return "other"

    def _viewInfo(self, viewNode):
        info = {
            "nodeID": viewNode.GetID(),
            "label": viewNode.GetLayoutLabel() or viewNode.GetLayoutName(),
            "color": _rgb_to_hex(viewNode.GetLayoutColor()),
            "viewGroup": viewNode.GetViewGroup(),
        }
        if viewNode.IsA("vtkMRMLSliceNode"):
            info["orientation"] = viewNode.GetOrientation()
        return info

    def viewNode(self, layoutName):
        """View node with this layout name (Red, Green, Yellow, 1, ...)."""
        for (_cls, name), node in self._viewNodesByTag().items():
            if name == layoutName:
                return node
        return None

    def maximizedViewNode(self):
        """View node shown alone (vtkMRMLLayoutNode maximized view nodes), or None."""
        if self._layoutNode.GetNumberOfMaximizedViewNodes() < 1:
            return None
        return self._layoutNode.GetMaximizedViewNode(0)

    def maximizeView(self, viewNode):
        """Show this view alone; called again for the same view, restore the layout (toggle)."""
        if viewNode is None:
            self._layoutNode.RemoveAllMaximizedViewNodes()
            return
        if self._layoutNode.IsMaximizedViewNode(viewNode):
            self._layoutNode.RemoveMaximizedViewNode(viewNode)
        else:
            self._layoutNode.RemoveAllMaximizedViewNodes()
            self._layoutNode.AddMaximizedViewNode(viewNode)
        self._publishLayout(force=True)

    def _publishLayout(self, force=False):
        import json

        desc = self.layoutDescription()
        maximized = self.maximizedViewNode()
        payload = {"layout": self.layout(), "description": desc,
                   "maximized": maximized.GetLayoutName() if maximized is not None else None}
        encoded = json.dumps(payload, sort_keys=True)
        if not force and encoded == self._lastLayoutJson:
            return
        self._lastLayoutJson = encoded
        # Views that are no longer part of the layout are destroyed to free their WebGL contexts.
        # Not while the scene is being closed, imported or updated in a batch: the layout node is
        # reset during that (the view nodes are singletons and are kept, as in desktop Slicer), so
        # the views would be destroyed and created again for the same view nodes.
        # (the layout node is reset while the scene is closed or imported, and the layout is empty
        # for a moment, so destroying is delayed and cancelled if the view is shown again)
        visible = set(self._visibleLayoutNames(desc))
        self._markMappedViewNodes(visible)
        self._viewsToDetach = {name for name in self._views if name not in visible}
        if self._viewsToDetach:
            self._scheduleDetach()
        host.emit("layout-changed", payload)
        # qMRMLLayoutManager's layoutChanged is emitted once the views of the layout exist (a
        # script's slot may well ask for a slice widget of the new layout). Here the page makes
        # the canvases first, and the views follow (attachView), so the signal waits for the views
        # that are still to come - or, should the page never make them, a moment.
        pending = {v["layoutName"] for v in self._visibleViews(desc) if v.get("kind") in ("slice", "threeD")} - set(self._views)
        self._pendingLayoutChanged = (int(self.layout()), pending) if pending else None
        if pending:
            self._scheduleLayoutChanged()
        else:
            self.layoutChanged.emit(int(self.layout()))

    def _scheduleLayoutChanged(self, delayMs=2000):
        from .qtcompat.types import QTimer

        if self._layoutChangedTimer is None:
            self._layoutChangedTimer = QTimer()
            self._layoutChangedTimer.setSingleShot(True)
            self._layoutChangedTimer.timeout.connect(self._emitPendingLayoutChanged)
        self._layoutChangedTimer.start(delayMs)

    def _emitPendingLayoutChanged(self):
        pending = self._pendingLayoutChanged
        self._pendingLayoutChanged = None
        if self._layoutChangedTimer is not None:
            self._layoutChangedTimer.stop()
        if pending is not None:
            self.layoutChanged.emit(pending[0])

    def _viewAttached(self, layoutName):
        pending = self._pendingLayoutChanged
        if pending is None:
            return
        pending[1].discard(layoutName)
        if not pending[1]:
            self._emitPendingLayoutChanged()

    def _markMappedViewNodes(self, visible):
        """Tell the view nodes whether they are in the layout, and give the 3D ones a camera.

        qMRMLLayoutViewFactory marks the view nodes as mapped in the layout (what
        IsViewVisibleInLayout() reports), and its views are made at once, so a script finds a 3D
        view's camera node right after setting the layout. Here the views are made once the page
        has their canvases, so the camera node of a 3D view in the layout is made here as the camera
        displayable manager would (and does, for one that already exists).
        """
        import slicer

        if self._scene.IsClosing() or self._scene.IsImporting() or self._scene.IsBatchProcessing():
            return
        for (_cls, name), node in self._viewNodesByTag().items():
            mapped = name in visible
            if bool(node.IsMappedInLayout()) != mapped:
                node.SetMappedInLayout(mapped)
            if mapped and node.IsA("vtkMRMLViewNode") and slicer.vtkMRMLViewLogic.GetCameraNode(self._scene, name) is None:
                camera = self._scene.CreateNodeByClass("vtkMRMLCameraNode")
                camera.UnRegister(None)
                camera.SetName(self._scene.GetUniqueNameByString(camera.GetNodeTagName()))
                camera.SetDescription("Default Scene Camera")
                camera.SetLayoutName(name)
                self._scene.AddNode(camera)

    def _scheduleDetach(self, delayMs=1000):
        from .qtcompat.types import QTimer

        if self._detachTimer is None:
            self._detachTimer = QTimer()
            self._detachTimer.setSingleShot(True)
            self._detachTimer.timeout.connect(self._detachHiddenViews)
        self._detachTimer.start(delayMs)

    def _detachHiddenViews(self):
        if self._scene.IsClosing() or self._scene.IsImporting() or self._scene.IsBatchProcessing():
            self._scheduleDetach()
            return
        visible = set(self._visibleLayoutNames(self.layoutDescription()))
        for name in list(self._views):
            if name not in visible:
                self.detachView(name)

    def _visibleLayoutNames(self, desc):
        return (v["layoutName"] for v in self._visibleViews(desc))

    def _visibleViews(self, desc):
        if desc.get("type") == "view":
            yield desc
            return
        children = desc.get("children", [])
        if desc.get("type") == "tab":
            children = children[:1]  # only the first tab is visible initially
        for child in children:
            yield from self._visibleViews(child)

    # ------------------------------------------------------------------ views
    # ------------------------------------------------------------------ shared canvas
    def attachSharedCanvas(self, canvasSelector, width, height):
        """The canvas the views share, with one WebGL context for all of them.

        A browser allows only so many contexts at a time - about eight on a phone - so a layout of
        nine views cannot give each of them one. Views of a shared canvas are renderers of one
        render window, each with its own rectangle of it (see vtkSlicerWebCanvas).
        """
        import slicer

        if self._sharedCanvas is not None:
            if self._sharedCanvas.GetCanvasSelector() == canvasSelector:
                self._sharedCanvas.SetSize(int(width), int(height))
                return True
            self.detachSharedCanvas()
        canvas = slicer.vtkSlicerWebCanvas()
        canvas.SetCanvasSelector(canvasSelector)
        if not canvas.Initialize():
            logger.error("attachSharedCanvas: failed to initialize %s", canvasSelector)
            return False
        canvas.SetSize(int(width), int(height))
        canvas.Start()
        self._sharedCanvas = canvas
        return True

    def detachSharedCanvas(self):
        """Let the shared canvas go, once the views of it have gone."""
        if self._sharedCanvas is None:
            return False
        for name in [name for name, view in self._views.items() if view.GetCanvas() is not None]:
            self.detachView(name)
        self._sharedCanvas.Finalize()
        self._sharedCanvas = None
        return True

    def sharedCanvas(self):
        return self._sharedCanvas

    def setViewRect(self, layoutName, x, y, width, height):
        """Where a view of the shared canvas sits on it, in device pixels from the top left."""
        view = self._views.get(layoutName)
        if view is None or self._sharedCanvas is None or view.GetCanvas() is None:
            return False
        self._sharedCanvas.SetViewRect(view, int(x), int(y), int(width), int(height))
        return True

    def attachView(self, layoutName, canvasSelector, width=0, height=0, className=None, rect=None):
        """Create the browser view for a view node when its <canvas> exists in the page.

        Called by the web page (``#slicer-view-<layoutName>`` canvases). With *rect* (x, y, width,
        height in device pixels) the view draws in that rectangle of the shared canvas instead of
        a canvas of its own. Returns True on success.
        """
        import slicer

        if rect is not None and self._sharedCanvas is None:
            return False   # the page has not made the shared canvas yet: it will ask again
        if layoutName in self._views:
            view = self._views[layoutName]
            if view.GetCanvasSelector() == canvasSelector:
                if width and height:
                    view.SetSize(int(width), int(height))
                return True
            self.detachView(layoutName)

        viewNodes = self._viewNodesByTag()
        viewNode = None
        for (cls, name), node in viewNodes.items():
            if name == layoutName and (className is None or cls == className):
                viewNode = node
                break
        if viewNode is None:
            logger.error("attachView: no view node with layout name %s", layoutName)
            return False
        self._app.applyScreenScaleFactor(viewNode)

        makeAdaptive = False   # only the 3D views coarsen a volume while the camera moves
        if viewNode.IsA("vtkMRMLSliceNode"):
            view = slicer.vtkSlicerWebSliceView()
            widget_cls = SliceWidget
        elif viewNode.IsA("vtkMRMLViewNode"):
            view = slicer.vtkSlicerWebThreeDView()
            widget_cls = ThreeDWidget
            self._renderVolumesAdaptively(viewNode)
            makeAdaptive = True
        else:
            logger.warning("attachView: views of type %s are displayed by the web page", viewNode.GetClassName())
            return False

        if rect is not None:
            view.SetCanvas(self._sharedCanvas)
        else:
            view.SetCanvasSelector(canvasSelector)
        if not view.Initialize(self._app.applicationLogic(), self._scene, layoutName):
            logger.error("attachView: failed to initialize view %s", layoutName)
            return False
        if rect is not None:
            self._sharedCanvas.SetViewRect(view, *(int(v) for v in rect))
        elif width and height:
            view.SetSize(int(width), int(height))
        view.Start()
        self._views[layoutName] = view
        self._widgets[layoutName] = widget_cls(self, layoutName, view)
        if makeAdaptive:
            from .volume_quality import AdaptiveVolumeQuality

            self._volumeQuality[layoutName] = AdaptiveVolumeQuality(view)
        host.emit("view-attached", {"layoutName": layoutName, "nodeID": viewNode.GetID()})
        self._viewAttached(layoutName)
        if viewNode.IsA("vtkMRMLViewNode") and len([v for v in self._views.values() if v.IsA("vtkSlicerWebThreeDView")]) == 1:
            view.ResetCamera(-1)
        return True

    @staticmethod
    def _renderVolumesAdaptively(viewNode):
        """Let a volume rendering give up detail while the camera is moving.

        Slicer's default is to render a volume at the same quality whatever is happening, which a
        desktop graphics card can do. A browser cannot, and the whole view waits for it: every
        turn of the camera costs a full-quality pass over the volume. Adaptive quality is what
        Slicer offers for this - the mapper is told what frame rate to aim for and takes coarser
        steps through the volume while the camera moves, going back to full detail when it stops.
        """
        import slicer

        if viewNode.GetVolumeRenderingQuality() == slicer.vtkMRMLViewNode.Normal:
            viewNode.SetVolumeRenderingQuality(slicer.vtkMRMLViewNode.Adaptive)
            # Slicer aims for 8 frames a second, which on a desktop graphics card it reaches
            # without giving up much. A browser has less to work with, so it is asked for more and
            # gives up more while the camera is moving (slicerweb.volume_quality).
            viewNode.SetExpectedFPS(15.0)

    def detachView(self, layoutName):
        quality = self._volumeQuality.pop(layoutName, None)
        if quality is not None:
            quality.remove()
        view = self._views.pop(layoutName, None)
        self._widgets.pop(layoutName, None)
        if view is not None:
            view.Finalize()
            host.emit("view-detached", {"layoutName": layoutName})

    def resizeView(self, layoutName, width, height):
        view = self._views.get(layoutName)
        if view is not None:
            view.SetSize(int(width), int(height))

    def view(self, layoutName):
        return self._views.get(layoutName)

    def views(self):
        return dict(self._views)

    # ------------------------------------------------------------------ qSlicerLayoutManager API
    def sliceViewNames(self):
        return [name for name, view in self._views.items() if view.IsA("vtkSlicerWebSliceView")]

    def sliceWidget(self, name):
        widget = self._widgets.get(name)
        return widget if isinstance(widget, SliceWidget) else None

    @property
    def threeDViewCount(self):
        return property_value(len(self._threeDWidgets()))

    @property
    def tableViewCount(self):
        return property_value(0)

    @property
    def plotViewCount(self):
        return property_value(0)

    def threeDWidget(self, index):
        widgets = self._threeDWidgets()
        return widgets[index] if 0 <= index < len(widgets) else None

    def _threeDWidgets(self):
        return [w for _, w in sorted(self._widgets.items()) if isinstance(w, ThreeDWidget)]

    def activeMRMLThreeDViewNode(self):
        w = self.threeDWidget(0)
        return w.mrmlViewNode() if w else None

    def resetSliceViews(self):
        for name in self.sliceViewNames():
            self.sliceWidget(name).sliceLogic().FitSliceToAll()

    def resetThreeDViews(self):
        for w in self._threeDWidgets():
            w.threeDView().resetCamera()

    def pauseRender(self):
        self._app.pauseRender()

    def resumeRender(self):
        self._app.resumeRender()

    def setRenderPaused(self, pause):
        self._app.setRenderPaused(pause)

    def mrmlSliceLogics(self):
        return self._app.applicationLogic().GetSliceLogics()

    def mrmlViewLogics(self):
        return self._app.applicationLogic().GetViewLogics()



class _ViewAdapter:
    """Subset of qMRMLSliceView / qMRMLThreeDView API used by scripts."""

    def __init__(self, view):
        self._view = view

    def renderWindow(self):
        return self._view.GetRenderWindow()

    def interactor(self):
        return self._view.GetInteractor()

    def interactorStyle(self):
        return self._view.GetInteractor().GetInteractorStyle()

    def interactorObserver(self):
        return self._view.GetInteractorObserver()

    def displayableManagerByClassName(self, className):
        return self._view.GetDisplayableManagerGroup().GetDisplayableManagerByClassName(className)

    def forceRender(self):
        self._view.Render()

    def scheduleRender(self):
        self._view.ScheduleRender()

    def setRenderPaused(self, paused):
        self._view.SetRenderEnabled(not paused)

    def mrmlViewNode(self):
        return self._view.GetViewNode()

    def cornerAnnotation(self):
        return None

    def size(self):
        return tuple(self._view.GetRenderWindow().GetSize())


class SliceView(_ViewAdapter):
    def sliceViewInteractorStyle(self):
        return self._view.GetSliceViewInteractorStyle()

    def mrmlSliceNode(self):
        return self._view.GetSliceNode()


class ThreeDView(_ViewAdapter):
    def resetFocalPoint(self):
        self._view.ResetFocalPoint()

    def resetCamera(self):
        self._view.ResetCamera(-1)

    def rotateToViewAxis(self, axisIndex):
        import slicer

        directions = [slicer.vtkMRMLCameraNode.Left, slicer.vtkMRMLCameraNode.Right,
                      slicer.vtkMRMLCameraNode.Posterior, slicer.vtkMRMLCameraNode.Anterior,
                      slicer.vtkMRMLCameraNode.Inferior, slicer.vtkMRMLCameraNode.Superior]
        cameraNode = self._view.GetCameraNode()
        if cameraNode:
            cameraNode.RotateTo(directions[axisIndex])

    def lookFromViewAxis(self, axisIndex):
        self.rotateToViewAxis(axisIndex)
        self.resetFocalPoint()

    def cameraNode(self):
        return self._view.GetCameraNode()

    def mrmlViewNode(self):
        return self._view.GetMRMLViewNode()


class SliceWidget:
    """Subset of qMRMLSliceWidget API: sliceLogic(), sliceView(), sliceController()."""

    def __init__(self, manager, layoutName, view):
        self._manager = manager
        self._name = layoutName
        self._view = view
        self._sliceView = SliceView(view)
        self._controller = SliceController(view)

    def sliceLogic(self):
        return self._view.GetSliceLogic()

    def sliceView(self):
        return self._sliceView

    def sliceController(self):
        return self._controller

    def mrmlSliceNode(self):
        return self._view.GetSliceNode()

    def mrmlSliceCompositeNode(self):
        return self._view.GetSliceLogic().GetSliceCompositeNode()

    def sliceOrientation(self):
        return self.mrmlSliceNode().GetOrientation()

    def setSliceOrientation(self, orientation):
        self.mrmlSliceNode().SetOrientation(orientation)

    def fitSliceToBackground(self):
        self.sliceLogic().FitSliceToAll()

    def resize(self, width, height=None):
        self._manager.resizeView(self._name, *((width.width(), width.height()) if height is None else (width, height)))

    def objectName(self):
        return f"qMRMLSliceWidget{self._name}"

    def name(self):
        return self._name


class SliceController:
    """Subset of qMRMLSliceControllerWidget API."""

    def __init__(self, view):
        self._view = view

    def fitSliceToBackground(self):
        self._view.GetSliceLogic().FitSliceToAll()

    def setSliceVisible(self, visible):
        self._view.GetSliceLogic().GetSliceModelDisplayNode().SetVisibility(bool(visible))
        self._view.GetSliceNode().SetSliceVisible(bool(visible))

    def setSliceOffsetValue(self, offset):
        self._view.GetSliceLogic().SetSliceOffset(offset)

    def sliceOffsetSlider(self):
        return None

    def mrmlSliceNode(self):
        return self._view.GetSliceNode()


class ThreeDWidget:
    """Subset of qMRMLThreeDWidget API: threeDView(), mrmlViewNode(), viewLogic()."""

    def __init__(self, manager, layoutName, view):
        self._manager = manager
        self._name = layoutName
        self._view = view
        self._threeDView = ThreeDView(view)

    def threeDView(self):
        return self._threeDView

    def mrmlViewNode(self):
        return self._view.GetMRMLViewNode()

    def viewLogic(self):
        return self._view.GetViewLogic()

    def threeDController(self):
        return None

    def resize(self, width, height=None):
        self._manager.resizeView(self._name, *((width.width(), width.height()) if height is None else (width, height)))

    def objectName(self):
        return f"ThreeDWidget{self._name}"

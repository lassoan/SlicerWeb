"""Slicer's 3D view in a WebXR session: the Python half of slicer-xr.js.

Runs in SlicerWeb's Python (Pyodide), in the page. The page computes the eye poses and the
projections from the XR frame, and for each eye this renders the first 3D view of the layout with
them and has the frame copied into the eye's rectangle of the headset's framebuffer (slicer-xr.js
points framebuffer 0 at it while an XR frame is being drawn).

The view keeps everything that makes it Slicer's: its renderers, its displayable managers, its
volume rendering, its lights. While the session lasts, its renderers look through a camera of
their own (the camera node's is left as it was, and nothing about the scene is modified 72 times
a second), the window is the size of an eye, the orientation marker is not drawn, and the view
does not render for the page.

What the session adds to the view - the controllers, their rays, the panel - are actors of its
own, built in metres and placed by user matrices that carry the room-to-scene transform (and so
its scale). The panel's picture is drawn by the page (a 2D canvas) and handed over as a texture.
Markups placed with a controller are ordinary markups nodes of the scene.
"""

import math

import slicer
import vtk

# The layer of the orientation marker's renderer (vtkMRMLOrientationMarkerDisplayableManager)
ORIENTATION_MARKER_LAYER = 2
GL_DRAW_FRAMEBUFFER = 0x8CA9
GL_READ_FRAMEBUFFER = 0x8CA8

# The markups the panel places: how many points make one (0: as many as are placed, until Done)
MARKUPS = {
    "vtkMRMLMarkupsFiducialNode": ("Point list", 0),
    "vtkMRMLMarkupsLineNode": ("Line", 2),
    "vtkMRMLMarkupsAngleNode": ("Angle", 3),
    "vtkMRMLMarkupsCurveNode": ("Curve", 0),
    "vtkMRMLMarkupsClosedCurveNode": ("Closed curve", 0),
    "vtkMRMLMarkupsPlaneNode": ("Plane", 3),
}
# The size of a placed markup's points, in metres of the room
GLYPH_SIZE_M = 0.008
# How near a controller's tip has to be to a control point to be in it (or the point's own size)
HOVER_RADIUS_M = 0.015


class SlicerXR:
    def __init__(self):
        self.view = None
        self.placing = None  # class name of the markup being placed
        self.placingNode = None
        self.activePoints = {}  # nodeID -> (componentType, index) highlighted
        self.savedGlyphs = {}  # nodeID -> (useGlyphScale, glyphSize) before the session
        self.handleDrag = None
        self.handlesWanted = None  # None: as each markup has it
        self.savedDepthPeeling = None
        self.savedMappers = {}  # volume mapper -> its settings before the session
        self.volumeQuality = (1.0, 1.0)
        self.savedVolumeOpacity = {}  # volume node ID -> its opacity transfer function before it was halved
        self.clipCenter = None  # where the clipping plane was put through (world, mm)
        self.clipRange = 100.0  # how far the slider moves it either way (mm)

    # ------------------------------------------------------------------ session

    def viewCanvasSelector(self):
        """The canvas the 3D view that start() would take draws on (None while there is no such
        view, as while SlicerWeb makes a view anew after its WebGL context was lost)."""
        view = self._threeDView()
        if view is None:
            return None
        canvas = view.GetCanvas()
        return canvas.GetCanvasSelector() if canvas is not None else view.GetCanvasSelector()

    def viewSize(self):
        """The size the view renders at, for the log."""
        return "x".join(str(v) for v in self.window.GetSize()) if self.view is not None else ""

    def alive(self):
        """Whether the view taken by start() is still there (SlicerWeb finalizes a view whose WebGL
        context was lost, and makes a new one)."""
        return self.view is not None and self.view.GetInitialized()

    def start(self, ar=False):
        """Take over the first 3D view. Returns the scene's bounds (world, mm) and how the view is
        drawn, or raises if there is no 3D view."""
        view = self._threeDView()
        if view is None:
            raise RuntimeError("There is no 3D view in the layout")
        self.view = view
        self.ar = bool(ar)
        self.window = view.GetRenderWindow()
        self.renderer = view.GetRenderer()
        # On a shared canvas the window renders into framebuffers of its own and the frame is copied
        # out by the canvas; on a canvas of its own, VTK copies it to framebuffer 0 itself.
        self.shared = view.GetCanvas() is not None
        canvas = view.GetCanvas()
        self.canvasSelector = canvas.GetCanvasSelector() if canvas is not None else view.GetCanvasSelector()

        self.savedSize = tuple(self.window.GetSize())
        self.savedBackground = (
            self.renderer.GetGradientBackground(),
            self.renderer.GetBackgroundAlpha(),
            self.renderer.GetBackground(),
        )

        self.camera = vtk.vtkCamera()
        self.camera.UseExplicitProjectionTransformMatrixOn()
        self.projection = vtk.vtkMatrix4x4()
        self.camera.SetExplicitProjectionTransformMatrix(self.projection)

        self.hiddenRenderers = []
        for renderer in self._renderers():
            if renderer.GetLayer() == ORIENTATION_MARKER_LAYER and renderer.GetDraw():
                renderer.DrawOff()
                self.hiddenRenderers.append(renderer)

        self.controllers = [self._makeControllerActor(color) for color in ((0.35, 0.75, 1.0), (1.0, 0.65, 0.3))]
        self.rays = [self._makeRayActor() for _ in range(2)]
        self._makePanel()
        self.highlights = [self._makeHighlightActor() for _ in range(2)]
        self.hole = self._makeHoleActor()
        self.ring = self._makeRingActor()
        self.sky = self._makeSkyActor()
        # (the clear plane is kept the first thing drawn, see beginFrame: its depth keeps the sky,
        # and whatever else is behind the panel, out of the panel's place)
        # (the rays after the sky: their soft edges are blended with what is drawn before them)
        self.ownActors = self.controllers + self.highlights + [self.hole, self.ring, self.panel, self.sky] + self.rays
        for actor in self.ownActors:
            self.renderer.AddActor(actor)

        # Translucent surfaces blended plainly rather than with depth peeling: on the Quest's GPU a
        # session with depth peeling showed nothing (and the fill of a plane was missing); the view
        # node gets its setting back when the session ends
        self.setDepthPeeling(False)

        return {"bounds": self.sceneBounds(), "shared": self.shared, "canvasSelector": self.canvasSelector}

    def stop(self):
        """Give the view back to the page as it was."""
        view = self.view
        if view is None:
            return
        self.view = None
        self.placeStop()
        for nodeID in list(self.activePoints):
            self._setActive(nodeID, None)
        self.activePoints = {}
        self.handleDrag = None
        self._restoreSizes()
        self._restoreVolumeQuality()
        if self.savedDepthPeeling is not None:
            viewNode, on = self.savedDepthPeeling
            viewNode.SetUseDepthPeeling(on)
            self.savedDepthPeeling = None
        for actor in self.ownActors:
            self.renderer.RemoveActor(actor)
        self.ownActors = []
        # The camera node's camera: the scene may have been closed and loaded again in the session,
        # which brings a camera node (and a camera) of its own
        cameraNode = view.GetCameraNode() if view.GetInitialized() else None
        camera = cameraNode.GetCamera() if cameraNode is not None else None
        for renderer in self._renderers():
            if renderer.GetLayer() != ORIENTATION_MARKER_LAYER and renderer.GetActiveCamera() is self.camera and camera is not None:
                renderer.SetActiveCamera(camera)
        for renderer in self.hiddenRenderers:
            renderer.DrawOn()
        gradient, alpha, background = self.savedBackground
        self.renderer.SetGradientBackground(gradient)
        self.renderer.SetBackgroundAlpha(alpha)
        self.renderer.SetBackground(background)
        if view.GetInitialized():
            if tuple(self.window.GetSize()) != self.savedSize and min(self.savedSize) > 0:
                view.SetSize(*self.savedSize)
            view.SetRenderEnabled(True)
            view.ScheduleRender()

    # ------------------------------------------------------------------ frames

    def beginFrame(self, width, height, controllers, rays, panel, hole=None, sky=None, holeSize=None, ringT=None):
        """Before the eyes of a frame: the window is an eye's size, the renderers look through the
        XR camera, and the page does not get the view rendered in between.

        controllers: up to two row-major 4x4 matrices (world, mm), empty for one that is not shown.
        rays: for each controller, the 8 corner points of its ray's ribbon (24 numbers, world, mm;
        see _makeRayActor), empty for a ray that is not shown.
        panel: the panel's matrix, empty when it is hidden (or a layer of its own).
        hole: where the panel's layer is (its matrix; holeSize: its width and height and the width
        of its soft edge, metres): drawn clear there, so that the layer, under the 3D view, shows.
        sky: in VR, the sphere around the viewer that the background is drawn on (a background drawn
        first would fill the hole: VTK blends what it draws over it); ringT: where on the sky's
        gradient the corners of the hole are (see _makeRingActor), none in AR."""
        view = self.view
        if view is None or not view.GetInitialized():
            raise RuntimeError("The 3D view was closed")
        # Turned on again by the scene (the end of a batch) whenever it likes: turned off each frame
        view.SetRenderEnabled(False)
        width, height = int(width), int(height)
        if tuple(self.window.GetSize()) != (width, height):
            view.SetSize(width, height)
        # Framebuffer 0 - the headset's while the frame is drawn - is what VTK copies its frame to
        # when it takes it to be bound: told so, whatever it had bound before (the page may have
        # left a framebuffer of its own bound, and the frames of the first session went there)
        self.window.MakeCurrent()
        state = self.window.GetState()
        state.vtkglBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0)
        state.vtkglBindFramebuffer(GL_READ_FRAMEBUFFER, 0)
        # Every renderer but the orientation marker's; set again each frame, since a scene that is
        # loaded brings its camera node, whose camera the displayable managers give the renderers
        for renderer in self._renderers():
            if renderer.GetLayer() != ORIENTATION_MARKER_LAYER and renderer.GetActiveCamera() is not self.camera:
                renderer.SetActiveCamera(self.camera)
        sky = self._toPython(sky) if sky is not None else []
        if self.ar or sky:
            # Clear (and black: the headset adds what is drawn clear to what is under it): the room
            # shows through in AR; in VR the sky is drawn instead, but where the panel's layer is
            self.renderer.SetGradientBackground(False)
            self.renderer.SetBackground(0.0, 0.0, 0.0)
            self.renderer.SetBackgroundAlpha(0.0)
        else:
            gradient, alpha, background = self.savedBackground
            self.renderer.SetGradientBackground(gradient)
            self.renderer.SetBackground(background)
            self.renderer.SetBackgroundAlpha(1.0)
        for actor in self.ownActors:
            if not self.renderer.HasViewProp(actor):
                self.renderer.AddActor(actor)  # a closed scene may have taken it out
        if self.volumeQuality != (1.0, 1.0) or self.savedMappers:
            self._applyVolumeQuality()

        self._place(self.controllers, self._toPython(controllers))
        self._shapeRays(self._toPython(rays))
        self._place([self.panel], [self._toPython(panel)])
        hole = self._toPython(hole) if hole is not None else []
        holeSize = self._toPython(holeSize) if holeSize is not None else []
        ringT = self._toPython(ringT) if ringT is not None else []
        if sky:
            self._colorSky()
        if hole and len(holeSize) == 3:
            self._shapeHole(*holeSize)
            # The first thing drawn: what is behind the panel is then not drawn there, whatever
            # the order of the rest (a prop put in front of it since is put behind it again)
            props = self.renderer.GetViewProps()
            if props.GetItemAsObject(0) is not self.hole:
                props.RemoveItem(self.hole)
                props.InsertItem(-1, self.hole)
        ringShown = bool(hole and sky and len(ringT) == 8)
        if ringShown:
            self._colorRing(ringT)
        self._place([self.hole], [hole])
        self._place([self.ring], [hole if ringShown else []])
        self._place([self.sky], [sky])

    def renderEye(self, values):
        """Render one eye: position, focal point, view up (3 each), near, far, vertical view angle,
        then the row-major projection matrix (16)."""
        v = self._toPython(values)
        camera = self.camera
        camera.SetPosition(v[0], v[1], v[2])
        camera.SetFocalPoint(v[3], v[4], v[5])
        camera.SetViewUp(v[6], v[7], v[8])
        camera.SetClippingRange(v[9], v[10])
        camera.SetViewAngle(v[11])
        self.projection.DeepCopy([float(x) for x in v[12:28]])
        camera.Modified()
        self.view.Render()
        if self.shared:
            # What vtkSlicerWebSharedRenderWindow::BlitToCanvas does (the class is not wrapped):
            # into framebuffer 0, which is the headset's while the XR frame is drawn
            self.window.MakeCurrent()
            self.window.GetState().vtkglBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0)
            self.window.BlitDisplayFramebuffer()

    # ------------------------------------------------------------------ the panel

    def setPanelImage(self, pixels, width, height, widthM, heightM):
        """The panel's picture: RGBA, rows from the bottom up, and its size in metres."""
        import numpy as np
        from vtk.util import numpy_support

        width, height = int(width), int(height)
        data = pixels.to_bytes() if hasattr(pixels, "to_bytes") else bytes(pixels)
        array = numpy_support.numpy_to_vtk(np.frombuffer(data, dtype=np.uint8).reshape(-1, 4), deep=1,
                                           array_type=vtk.VTK_UNSIGNED_CHAR)
        image = self.panelImage
        image.SetDimensions(width, height, 1)
        image.GetPointData().SetScalars(array)
        image.Modified()
        w, h = float(widthM) / 2, float(heightM) / 2
        self.panelPlane.SetOrigin(-w, -h, 0.0)
        self.panelPlane.SetPoint1(w, -h, 0.0)
        self.panelPlane.SetPoint2(-w, h, 0.0)

    # ------------------------------------------------------------------ the scene

    def sceneBounds(self):
        """The bounds (world, mm) of what the view shows, without what the session added; None for
        an empty scene."""
        shown = [actor for actor in getattr(self, "ownActors", []) if actor.GetVisibility()]
        for actor in shown:
            actor.VisibilityOff()
        bounds = [0.0] * 6
        self.renderer.ComputeVisiblePropBounds(bounds)
        for actor in shown:
            actor.VisibilityOn()
        if bounds[0] > bounds[1] or any(math.isnan(b) or abs(b) > 1e29 for b in bounds):
            return None
        return bounds

    # ------------------------------------------------------------------ volume rendering

    @staticmethod
    def _shownIn3D(node):
        display = node.GetDisplayNode()
        return bool(display is not None and display.GetVisibility() and display.GetVisibility3D())

    def _volumes(self):
        """The volumes that volume rendering can show (scalar volumes, not labelmaps), latest last."""
        return [node for node in slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")
                if not node.IsA("vtkMRMLLabelMapVolumeNode")]

    def volumeRenderingShown(self):
        return any(node.GetVisibility() for node in slicer.util.getNodesByClass("vtkMRMLVolumeRenderingDisplayNode"))

    def volumeToRender(self):
        """The volume to show volume rendered when the 3D view would otherwise show nothing of the
        scene - a volume loaded as a file or by the page's Samples button is not volume rendered -
        or None when something is shown already (volume rendering, a model, a segmentation)."""
        if self.volumeRenderingShown():
            return None
        for className in ("vtkMRMLModelNode", "vtkMRMLSegmentationNode"):
            for node in slicer.util.getNodesByClass(className):
                if not node.GetHideFromEditors() and self._shownIn3D(node):
                    return None
        volumes = self._volumes()
        return volumes[-1].GetID() if volumes else None

    # ------------------------------------------------------------------ the data tree

    # What an item is, by the class of its data node (the first that fits)
    DATA_KINDS = (
        ("vtkMRMLLabelMapVolumeNode", "Labelmap"),
        ("vtkMRMLScalarVolumeNode", "Volume"),
        ("vtkMRMLSegmentationNode", "Segmentation"),
        ("vtkMRMLModelNode", "Model"),
        ("vtkMRMLMarkupsNode", "Markup"),
        ("vtkMRMLTransformNode", "Transform"),
    )
    TRANSPARENT_OPACITY = 0.5

    def _kind(self, node):
        for className, kind in self.DATA_KINDS:
            if node.IsA(className):
                return kind
        return node.GetClassName().replace("vtkMRML", "").replace("Node", "")

    def dataItems(self):
        """The scene's data tree (the subject hierarchy), depth first: [{id, nodeID (its data
        node's, "" for a folder), name, depth, kind, visible, transparent, opacity, clippable,
        clipped}] - opacity: whether it has one the panel can set. id is the item's, or for a
        segment "<the segmentation's item>/<segment ID>" (see _segmentOf). A volume is shown when
        it is volume rendered.

        The segments of a segmentation are listed under it, read from the segmentation, as the
        page's data tree lists them (bridge.py getSubjectHierarchy): the items desktop Slicer keeps
        for them (virtual branch items, which a scene saved there brings along) are left out."""
        sh = slicer.mrmlScene.GetSubjectHierarchyNode()
        if sh is None:
            return []
        clip, _ = self._clipNodes()
        segmentIDAttribute = slicer.vtkMRMLSegmentationNode.GetSegmentIDAttributeName()
        items = []

        def addSegments(item, segmentationNode, depth):
            segmentation = segmentationNode.GetSegmentation()
            display = segmentationNode.GetDisplayNode()
            # (clipping is the segmentation's: a segment's clipping icon clips all of it)
            clippable, clipped = bool(self._clipDisplays(segmentationNode)), self._clipped(segmentationNode, clip)
            for index in range(segmentation.GetNumberOfSegments() if segmentation else 0):
                segmentID = segmentation.GetNthSegmentID(index)
                opacity = display.GetSegmentOpacity3D(segmentID) if display is not None else 1.0
                items.append({
                    "id": f"{int(item)}/{segmentID}", "nodeID": segmentationNode.GetID(),
                    "name": segmentation.GetNthSegment(index).GetName(), "depth": depth, "kind": "Segment",
                    "visible": bool(display is not None and display.GetVisibility() and display.GetSegmentVisibility(segmentID)),
                    "transparent": opacity < 0.999, "opacity": display is not None,
                    "clippable": clippable, "clipped": clipped,
                })

        def add(parent, depth):
            children = vtk.vtkIdList()
            sh.GetItemChildren(parent, children)
            parentNode = sh.GetItemDataNode(parent) if parent != sh.GetSceneItemID() else None
            for index in range(children.GetNumberOfIds()):
                item = children.GetId(index)
                node = sh.GetItemDataNode(item)
                if node is not None and (node.GetHideFromEditors() or self._isOwn(node)):
                    continue
                if (node is None and parentNode is not None and parentNode.IsA("vtkMRMLSegmentationNode")
                        and sh.GetItemAttribute(item, segmentIDAttribute)):
                    continue  # a segment's item kept by desktop Slicer: the segments are listed below
                entry = {"id": int(item), "nodeID": node.GetID() if node is not None else "", "name": sh.GetItemName(item), "depth": depth}
                if node is None:
                    # (a patient, a study, a folder; a virtual branch item is shown without a kind)
                    level = sh.GetItemLevel(item) or "Folder"
                    entry.update(kind="" if level == "VirtualBranch" else level, visible=self._branchVisible(sh, item),
                                 transparent=False, opacity=False, clippable=False, clipped=False)
                else:
                    kind = self._kind(node)
                    if kind == "Volume":
                        visible = any(d.GetVisibility() for d in self._volumeRenderingDisplays(node))
                    else:
                        visible = bool(sh.GetItemDisplayVisibility(item))
                    opacity = self._opacity(node)
                    entry.update(kind=kind, visible=visible, transparent=opacity is not None and opacity < 0.999,
                                 opacity=opacity is not None, clippable=bool(self._clipDisplays(node)),
                                 clipped=self._clipped(node, clip))
                items.append(entry)
                add(item, depth + 1)
                if node is not None and node.IsA("vtkMRMLSegmentationNode"):
                    addSegments(item, node, depth + 1)

        add(sh.GetSceneItemID(), 0)
        return items

    @staticmethod
    def _segmentOf(itemID):
        """(segmentation node, segment ID) of the id of a segment in the data tree ("<item>/<segment
        ID>"), else (None, None)."""
        text = str(itemID)
        if "/" not in text:
            return None, None
        item, segmentID = text.split("/", 1)
        node = slicer.mrmlScene.GetSubjectHierarchyNode().GetItemDataNode(int(item))
        if node is None or not node.IsA("vtkMRMLSegmentationNode") or node.GetSegmentation().GetSegment(segmentID) is None:
            return None, None
        return node, segmentID

    @staticmethod
    def _volumeRenderingDisplays(volume):
        displays = []
        for index in range(volume.GetNumberOfDisplayNodes()):
            display = volume.GetNthDisplayNode(index)
            if display is not None and display.IsA("vtkMRMLVolumeRenderingDisplayNode"):
                displays.append(display)
        return displays

    def _opacity(self, node):
        """How opaque it is in the 3D view (0..1), or None where the panel sets no opacity."""
        if node.IsA("vtkMRMLScalarVolumeNode") and not node.IsA("vtkMRMLLabelMapVolumeNode"):
            displays = self._volumeRenderingDisplays(node)
            if not displays:
                return None
            return self.TRANSPARENT_OPACITY if node.GetID() in self.savedVolumeOpacity else 1.0
        display = node.GetDisplayNode()
        if display is None or not hasattr(display, "GetOpacity"):
            return None
        if display.IsA("vtkMRMLSegmentationDisplayNode"):
            return display.GetOpacity3D()
        return display.GetOpacity()

    def setDataItemVisible(self, itemID, visible):
        """Shows or hides an item of the data tree in the 3D view - a folder: what is in it. A
        volume's volume rendering is hidden here; it is shown by the page's setVolumeRendering,
        which chooses its preset."""
        segmentationNode, segmentID = self._segmentOf(itemID)
        if segmentationNode is not None:
            display = segmentationNode.GetDisplayNode()
            if display is None:
                return ""
            display.SetSegmentVisibility(segmentID, bool(visible))
            if visible:
                # (a segment shown is seen: its segmentation too)
                display.SetVisibility(True)
                display.SetVisibility3D(True)
            name = segmentationNode.GetSegmentation().GetSegment(segmentID).GetName()
            return f"{name} {'shown' if visible else 'hidden'}"
        sh = slicer.mrmlScene.GetSubjectHierarchyNode()
        item = int(itemID)
        if sh.GetItemDataNode(item) is None:
            # A folder (a patient, a study): what is in it (desktop Slicer's folder plugin does
            # that; there is none here)
            for child in self._branch(sh, item):
                self._setNodeVisible(sh.GetItemDataNode(child), visible)
        else:
            self._setNodeVisible(sh.GetItemDataNode(item), visible)
        return f"{sh.GetItemName(item)} {'shown' if visible else 'hidden'}"

    def _setNodeVisible(self, node, visible):
        if node is None or node.GetHideFromEditors():
            return
        kind = self._kind(node)
        if kind == "Volume":
            # Hidden here; shown by the page's setVolumeRendering, which chooses the preset (a
            # volume in a folder that is shown again keeps the volume rendering it had)
            for display in self._volumeRenderingDisplays(node):
                display.SetVisibility(bool(visible))
            return
        display = node.GetDisplayNode()
        if display is None:
            return
        display.SetVisibility(bool(visible))
        if visible and hasattr(display, "SetVisibility3D"):
            display.SetVisibility3D(True)

    @staticmethod
    def _branch(sh, item):
        """The items under an item, all levels down."""
        children = vtk.vtkIdList()
        sh.GetItemChildren(item, children, True)
        return [children.GetId(i) for i in range(children.GetNumberOfIds())]

    def _branchVisible(self, sh, item):
        """A folder is shown while something in it is."""
        for child in self._branch(sh, item):
            node = sh.GetItemDataNode(child)
            if node is None or node.GetHideFromEditors():
                continue
            if self._kind(node) == "Volume":
                if any(d.GetVisibility() for d in self._volumeRenderingDisplays(node)):
                    return True
            elif node.GetDisplayNode() is not None and node.GetDisplayNode().GetVisibility():
                return True
        return False

    def toggleDataItemOpacity(self, itemID):
        """Half transparent, or opaque again. A volume rendering: its opacity transfer function at
        half (and what it was, after). A segment: its opacity in 3D."""
        segmentationNode, segmentID = self._segmentOf(itemID)
        if segmentationNode is not None:
            display = segmentationNode.GetDisplayNode()
            if display is None:
                return ""
            transparent = display.GetSegmentOpacity3D(segmentID) >= 0.999
            display.SetSegmentOpacity3D(segmentID, self.TRANSPARENT_OPACITY if transparent else 1.0)
            name = segmentationNode.GetSegmentation().GetSegment(segmentID).GetName()
            return f"{name} {'half transparent' if transparent else 'opaque'}"
        sh = slicer.mrmlScene.GetSubjectHierarchyNode()
        item = int(itemID)
        node = sh.GetItemDataNode(item)
        opacity = self._opacity(node) if node is not None else None
        if opacity is None:
            return ""
        transparent = opacity >= 0.999
        target = self.TRANSPARENT_OPACITY if transparent else 1.0
        if self._kind(node) == "Volume":
            for display in self._volumeRenderingDisplays(node):
                function = display.GetVolumePropertyNode().GetVolumeProperty().GetScalarOpacity()
                if transparent:
                    saved = [[0.0] * 4 for _ in range(function.GetSize())]
                    for index, point in enumerate(saved):
                        function.GetNodeValue(index, point)
                    self.savedVolumeOpacity[node.GetID()] = saved
                    for index, point in enumerate(saved):
                        function.SetNodeValue(index, [point[0], point[1] * target, point[2], point[3]])
                else:
                    for index, point in enumerate(self.savedVolumeOpacity.pop(node.GetID(), [])):
                        if index < function.GetSize():
                            function.SetNodeValue(index, point)
        else:
            display = node.GetDisplayNode()
            if display.IsA("vtkMRMLSegmentationDisplayNode"):
                display.SetOpacity3D(target)
            else:
                display.SetOpacity(target)
        return f"{sh.GetItemName(item)} {'half transparent' if transparent else 'opaque'}"

    # ------------------------------------------------------------------ clipping

    SINGLETON_TAG = "WebXR"

    @classmethod
    def _isOwn(cls, node):
        """The session's own nodes (the clip node and its plane), which the panel does not list or
        let the Markups category's buttons change."""
        return node is not None and node.GetSingletonTag() == cls.SINGLETON_TAG

    def _clipNodes(self, create=False):
        """The clip node and its plane: singletons (tag "WebXR"), made when first asked for."""
        scene = slicer.mrmlScene
        clip = scene.GetSingletonNode(self.SINGLETON_TAG, "vtkMRMLClipNode")
        plane = scene.GetSingletonNode(self.SINGLETON_TAG, "vtkMRMLMarkupsPlaneNode")
        if not create:
            return clip, plane
        if plane is None:
            plane = slicer.vtkMRMLMarkupsPlaneNode()
            plane.SetSingletonTag(self.SINGLETON_TAG)
            plane.SetName("WebXR clipping plane")
            plane.SetHideFromEditors(True)
            scene.AddNode(plane)
            plane.CreateDefaultDisplayNodes()
            plane.SetPlaneType(slicer.vtkMRMLMarkupsPlaneNode.PlaneTypePointNormal)
            plane.SetSizeMode(slicer.vtkMRMLMarkupsPlaneNode.SizeModeAbsolute)
            display = plane.GetDisplayNode()
            display.SetPropertiesLabelVisibility(False)
            display.SetSelectedColor(0.95, 0.75, 0.2)
            display.SetColor(0.95, 0.75, 0.2)
            display.SetOpacity(1.0)
            display.SetFillOpacity(0.15)
            display.SetHandlesInteractive(False)
            # The handles move it along its normal and turn it about its two other axes
            display.SetTranslationHandleComponentVisibility(False, False, True, False)
            display.SetRotationHandleComponentVisibility(True, True, False, False)
            display.SetScaleHandleVisibility(False)
        if clip is None:
            clip = slicer.vtkMRMLClipNode()
            clip.SetSingletonTag(self.SINGLETON_TAG)
            clip.SetName("WebXR clipping")
            clip.SetHideFromEditors(True)
            scene.AddNode(clip)
        if not clip.HasClippingNodeID(plane.GetID()):
            clip.RemoveAllClippingNodeIDs()
            clip.AddAndObserveClippingNodeID(plane.GetID())
            clip.SetClippingNodeState(plane.GetID(), slicer.vtkMRMLClipNode.ClipOff)
        return clip, plane

    def _clipDisplays(self, node):
        """The display nodes of a node that clipping applies to in the 3D view (a volume: its
        volume renderings)."""
        if node is None:
            return []
        if node.IsA("vtkMRMLScalarVolumeNode") and not node.IsA("vtkMRMLLabelMapVolumeNode"):
            return self._volumeRenderingDisplays(node)
        display = node.GetDisplayNode()
        return [display] if display is not None and hasattr(display, "SetClipping") else []

    def _clipped(self, node, clip):
        return clip is not None and any(
            d.GetClipping() and d.GetClipNode() is clip for d in self._clipDisplays(node))

    def clippingEnabled(self):
        clip, plane = self._clipNodes()
        return bool(clip is not None and plane is not None
                    and clip.GetClippingNodeState(plane.GetID()) != slicer.vtkMRMLClipNode.ClipOff)

    def clippingState(self):
        """What the Clipping category shows: whether it is on, the plane and its handles shown, and
        where the plane is along its normal (offset, mm) in the range the slider covers."""
        clip, plane = self._clipNodes()
        if plane is None:
            return {"enabled": False, "planeShown": False, "handlesShown": False, "offset": 0.0, "range": 1.0}
        display = plane.GetDisplayNode()
        origin, normal = [0.0] * 3, [0.0] * 3
        plane.GetOriginWorld(origin)
        plane.GetNormalWorld(normal)
        center = self.clipCenter or origin
        return {
            "enabled": self.clippingEnabled(),
            "planeShown": bool(display.GetVisibility()),
            "handlesShown": bool(display.GetHandlesInteractive()),
            "offset": sum((origin[i] - center[i]) * normal[i] for i in range(3)),
            "range": self.clipRange,
        }

    def setClippingEnabled(self, enabled, itemID, dx, dy, dz):
        """Clipping on or off. Turned on the first time, the plane is put through the middle of the
        item (the one selected in the Data category, else the first of the tree), its normal where
        the viewer looks (dx, dy, dz, world), and the item is clipped: what is on the viewer's side
        of the plane is left out (ClipPositiveSpace keeps the side the normal points to)."""
        clip, plane = self._clipNodes(create=True)
        if not enabled:
            clip.SetClippingNodeState(plane.GetID(), slicer.vtkMRMLClipNode.ClipOff)
            return "Clipping off"
        sh = slicer.mrmlScene.GetSubjectHierarchyNode()
        target = None
        if itemID:
            # (a segment: its segmentation)
            target = self._segmentOf(itemID)[0] or sh.GetItemDataNode(int(str(itemID).split("/")[0]))
        if target is None or not self._clipDisplays(target):
            for item in self.dataItems():
                node = slicer.mrmlScene.GetNodeByID(item["nodeID"]) if item["nodeID"] else None
                if node is not None and self._clipDisplays(node):
                    target = node
                    break
        if target is None:
            return "There is nothing to clip"
        anyClipped = any(self._clipped(slicer.mrmlScene.GetNodeByID(i["nodeID"]), clip)
                         for i in self.dataItems() if i["nodeID"])
        if self.clipCenter is None or not anyClipped:
            self._placePlane(target, [float(dx), float(dy), float(dz)])
        self._setNodeClipping(target, True, clip)
        clip.SetClippingNodeState(plane.GetID(), slicer.vtkMRMLClipNode.ClipPositiveSpace)
        return f"Clipping {target.GetName()}"

    def _placePlane(self, node, normal):
        """Through the middle of the node, as large as it is, its normal this one."""
        _, plane = self._clipNodes(create=True)
        bounds = [0.0] * 6
        node.GetRASBounds(bounds)
        if bounds[0] > bounds[1]:
            bounds = [-50.0, 50.0, -50.0, 50.0, -50.0, 50.0]
        self.clipCenter = [(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2, (bounds[4] + bounds[5]) / 2]
        size = max(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4], 1.0)
        self.clipRange = size / 2
        length = math.sqrt(sum(v * v for v in normal)) or 1.0
        normal = [v / length for v in normal]
        plane.SetOriginWorld(self.clipCenter)
        plane.SetNormalWorld(normal)
        plane.SetSize(size * 1.2, size * 1.2)

    def setNodeClipping(self, itemID, clipped):
        """Clipping for one item of the data tree (the Data category's clipping column)."""
        clip, _ = self._clipNodes(create=True)
        sh = slicer.mrmlScene.GetSubjectHierarchyNode()
        node = sh.GetItemDataNode(int(str(itemID).split("/")[0]))  # (a segment: its segmentation)
        if node is None:
            return ""
        self._setNodeClipping(node, bool(clipped), clip)
        return f"{node.GetName()} {'clipped' if clipped else 'not clipped'}"

    def _setNodeClipping(self, node, clipped, clip):
        for display in self._clipDisplays(node):
            display.SetAndObserveClipNodeID(clip.GetID())
            display.SetClipping(bool(clipped))

    def setClipOffset(self, offset):
        """The plane shifted along its normal: offset (mm) from the middle of what it was put
        through."""
        _, plane = self._clipNodes()
        if plane is None or self.clipCenter is None:
            return
        normal = [0.0] * 3
        plane.GetNormalWorld(normal)
        plane.SetOriginWorld([self.clipCenter[i] + normal[i] * float(offset) for i in range(3)])

    def followClipView(self, dx, dy, dz):
        """The plane turned to be across the view (dx, dy, dz: where the viewer looks, world), at the
        same offset along its normal. Only when it turned more than a degree: each change of the
        plane clips again."""
        _, plane = self._clipNodes()
        if plane is None or self.clipCenter is None:
            return
        normal = [float(dx), float(dy), float(dz)]
        length = math.sqrt(sum(v * v for v in normal)) or 1.0
        normal = [v / length for v in normal]
        current, origin = [0.0] * 3, [0.0] * 3
        plane.GetNormalWorld(current)
        if sum(normal[i] * current[i] for i in range(3)) > math.cos(math.radians(1.0)):
            return
        plane.GetOriginWorld(origin)
        offset = sum((origin[i] - self.clipCenter[i]) * current[i] for i in range(3))
        plane.SetNormalWorld(normal)
        plane.SetOriginWorld([self.clipCenter[i] + normal[i] * offset for i in range(3)])

    def clipGrabStart(self, hand):
        """The plane held by a hand (hand: the hand's pose in the scene, a 4x4 matrix, row by row):
        it moves and turns with the hand until let go."""
        _, plane = self._clipNodes()
        if plane is None or self.clipCenter is None:
            return ""
        origin, normal = [0.0] * 3, [0.0] * 3
        plane.GetOriginWorld(origin)
        plane.GetNormalWorld(normal)
        handFromWorld = vtk.vtkMatrix4x4()
        handFromWorld.DeepCopy([float(v) for v in hand])
        handFromWorld.Invert()
        self.clipGrab = {"origin": origin, "normal": normal, "center": list(self.clipCenter), "handFromWorld": handFromWorld}
        return "Moving the clipping plane"

    def clipGrabMove(self, hand):
        grab = getattr(self, "clipGrab", None)
        _, plane = self._clipNodes()
        if grab is None or plane is None:
            return
        motion = vtk.vtkMatrix4x4()
        now = vtk.vtkMatrix4x4()
        now.DeepCopy([float(v) for v in hand])
        vtk.vtkMatrix4x4.Multiply4x4(now, grab["handFromWorld"], motion)  # where the hand took what it held
        point = lambda p: list(motion.MultiplyPoint([*p, 1.0])[:3])
        vector = lambda v: list(motion.MultiplyPoint([*v, 0.0])[:3])
        normal = vector(grab["normal"])
        length = math.sqrt(sum(v * v for v in normal)) or 1.0
        # (the center moves with it: the slider's offset stays where it was)
        self.clipCenter = point(grab["center"])
        plane.SetNormalWorld([v / length for v in normal])
        plane.SetOriginWorld(point(grab["origin"]))

    def clipGrabEnd(self):
        self.clipGrab = None
        return "Clipping plane moved"

    def shiftClip(self, millimetres):
        """The plane moved along its normal by this much (within the slider's range)."""
        state = self.clippingState()
        offset = max(-self.clipRange, min(self.clipRange, state["offset"] + float(millimetres)))
        self.setClipOffset(offset)
        return offset

    def setClipPlaneShown(self, shown):
        _, plane = self._clipNodes(create=True)
        plane.GetDisplayNode().SetVisibility(bool(shown))
        return f"Clipping plane {'shown' if shown else 'hidden'}"

    def setClipHandlesShown(self, shown):
        _, plane = self._clipNodes(create=True)
        display = plane.GetDisplayNode()
        if shown:
            display.SetVisibility(True)  # (a hidden plane shows no handles)
            display.SetTranslationHandleVisibility(True)
            display.SetRotationHandleVisibility(True)
            display.SetTranslationHandleComponentVisibility(False, False, True, False)
            display.SetRotationHandleComponentVisibility(True, True, False, False)
            display.SetScaleHandleVisibility(False)
        display.SetHandlesInteractive(bool(shown))
        return f"Clipping plane handles {'shown' if shown else 'hidden'}"

    def latestVolume(self):
        volumes = self._volumes()
        return volumes[-1].GetID() if volumes else None

    def hideVolumeRendering(self):
        for node in slicer.util.getNodesByClass("vtkMRMLVolumeRenderingDisplayNode"):
            node.SetVisibility(False)

    def volumeName(self, nodeID):
        node = slicer.mrmlScene.GetNodeByID(nodeID)
        return node.GetName() if node is not None else ""

    # ------------------------------------------------------------------ markups

    def placeStart(self, className):
        """Each placePoint() from now on adds a point to a markup of this class."""
        if className not in MARKUPS:
            raise ValueError(f"Not a markup the panel places: {className}")
        self.placeStop()
        self.placing = className
        name, count = MARKUPS[className]
        return f"{name}: aim the controller's tip and pull the trigger" + (f" ({count} points)" if count else "")

    def placePoint(self, x, y, z, mmPerMetre):
        """A point at this position (world, mm) for the markup being placed; a new markup is begun
        when the last one has all its points. Returns what the panel says about it."""
        className = self.placing
        if className is None:
            return ""
        name, count = MARKUPS[className]
        node = self.placingNode
        if node is None or node.GetScene() is None or (count and node.GetNumberOfControlPoints() >= count):
            node = self._newMarkup(className, float(mmPerMetre))
            self.placingNode = node
        node.AddControlPoint([float(x), float(y), float(z)])
        placed = node.GetNumberOfControlPoints()
        if count and placed >= count:
            text = f"{node.GetName()} done"
            if className == "vtkMRMLMarkupsAngleNode":
                text += f": {node.GetAngleDegrees():.1f}°"
            elif className == "vtkMRMLMarkupsLineNode":
                text += f": {node.GetLineLengthWorld():.1f} mm"
            return text + " - pull the trigger to begin another"
        return f"{node.GetName()}: point {placed}" + (f" of {count}" if count else " - Done to finish")

    def placeStop(self):
        """No more points; a curve or point list being placed is finished as it is."""
        self.placing = None
        node, self.placingNode = self.placingNode, None
        if node is not None and node.GetScene() is not None:
            _, count = MARKUPS.get(node.GetClassName(), ("", 0))
            if node.GetNumberOfControlPoints() == 0 or (count and node.GetNumberOfControlPoints() < count):
                slicer.mrmlScene.RemoveNode(node)  # half a line is no line
        return ""

    def undoPoint(self):
        """Take back the last point placed (and the markup, when it was its first)."""
        node = self.placingNode
        if node is None or node.GetScene() is None:
            node = self._lastMarkup()
        if node is None:
            return "No markups to undo"
        if node.GetNumberOfControlPoints() > 0:
            node.RemoveNthControlPoint(node.GetNumberOfControlPoints() - 1)
        if node.GetNumberOfControlPoints() == 0:
            name = node.GetName()
            if node is self.placingNode:
                self.placingNode = None
            slicer.mrmlScene.RemoveNode(node)
            return f"{name} removed"
        self.placingNode = node
        return f"{node.GetName()}: {node.GetNumberOfControlPoints()} points"

    def deleteMarkups(self):
        """Every markup of the scene."""
        nodes = self._markups()
        count = len(nodes)
        for node in nodes:
            slicer.mrmlScene.RemoveNode(node)
        self.placingNode = None
        return f"{count} markup{'s' if count != 1 else ''} deleted"

    # ------------------------------------------------------------------ control points under the controllers

    def updateHover(self, tips, mmPerMetre):
        """What each controller's tip is in (tips: up to two [x, y, z], world, mm; empty for a
        controller that is not there): a control point or an interaction handle, highlighted as
        Slicer highlights what is under the mouse (a control point also marked by a sphere around
        it). Returns [nodeID, componentType, index] for each, or an empty list."""
        tips = self._toPython(tips) or []
        mmPerMetre = float(mmPerMetre)
        self._absoluteSizes(mmPerMetre)
        point = slicer.vtkMRMLMarkupsDisplayNode.ComponentControlPoint
        found = []
        for index in range(2):
            tip = tips[index] if index < len(tips) else None
            if not tip or len(tip) != 3:
                found.append(None)
                continue
            # Whichever the tip is more inside of: a point, or a handle
            atPoint = self._pointAt(tip, mmPerMetre)
            atHandle = self._handleAt(tip)
            if atPoint and (atHandle is None or atPoint[2] <= atHandle[3]):
                found.append((atPoint[0], point, atPoint[1]))
            elif atHandle:
                found.append(atHandle[:3])
            else:
                found.append(None)
        self._highlight(found, mmPerMetre)
        return [list(f) if f else [] for f in found]

    def pointPosition(self, nodeID, index):
        node = slicer.mrmlScene.GetNodeByID(nodeID)
        if node is None or index >= node.GetNumberOfControlPoints():
            return []
        position = [0.0, 0.0, 0.0]
        node.GetNthControlPointPositionWorld(int(index), position)
        return position

    def moveControlPoint(self, nodeID, index, x, y, z):
        """Moves a control point (world, mm). Returns what the panel says about the markup."""
        node = slicer.mrmlScene.GetNodeByID(nodeID)
        if node is None or index >= node.GetNumberOfControlPoints():
            return ""
        node.SetNthControlPointPositionWorld(int(index), float(x), float(y), float(z))
        return self._describe(node, int(index))

    @staticmethod
    def _describe(node, index):
        text = f"{node.GetName()}: point {index + 1}"
        if node.IsA("vtkMRMLMarkupsAngleNode") and node.GetNumberOfDefinedControlPoints() >= 3:
            text += f" - {node.GetAngleDegrees():.1f}°"
        elif node.IsA("vtkMRMLMarkupsLineNode") and node.GetNumberOfDefinedControlPoints() >= 2:
            text += f" - {node.GetLineLengthWorld():.1f} mm"
        return text

    def describePoint(self, nodeID, index):
        node = slicer.mrmlScene.GetNodeByID(nodeID)
        return self._describe(node, int(index)) if node is not None else ""

    # ------------------------------------------------------------------ volume rendering detail

    def _volumeMappers(self):
        """The volume mappers drawing in the view (those that cast rays)."""
        mappers = []
        for renderer in self._renderers():
            volumes = renderer.GetVolumes()
            for index in range(volumes.GetNumberOfItems()):
                volume = volumes.GetItemAsObject(index)
                mapper = volume.GetMapper()
                if volume.GetVisibility() and mapper is not None and hasattr(mapper, "SetImageSampleDistance"):
                    mappers.append(mapper)
        return mappers

    def volumesShown(self):
        return bool(self._volumeMappers())

    def setVolumeQuality(self, rays, steps):
        """Volumes drawn with a ray for every *rays*-th pixel across and down, and *steps* times the
        step along the ray that they had (1, 1: as Slicer has them). Kept up every frame - Slicer sets
        a mapper's steps again when the display changes - and put back when the session ends."""
        self.volumeQuality = (float(rays), float(steps))
        self._applyVolumeQuality()

    def _applyVolumeQuality(self):
        rays, steps = self.volumeQuality
        for mapper in self._volumeMappers():
            saved = self.savedMappers.get(mapper)
            current = mapper.GetSampleDistance()
            if saved is None:
                saved = {
                    "autoAdjust": mapper.GetAutoAdjustSampleDistances(),
                    "lockToSpacing": mapper.GetLockSampleDistanceToInputSpacing(),
                    "imageSampleDistance": mapper.GetImageSampleDistance(),
                    "sampleDistance": current,
                    "applied": None,
                }
                self.savedMappers[mapper] = saved
            elif saved["applied"] is not None and abs(current - saved["applied"]) > 1e-6:
                # Slicer has set the step again since (its display changed): that is the step it
                # wants, the one to go coarser from - the rest is still what it was before
                saved["sampleDistance"] = current
            if rays == 1.0 and steps == 1.0 and saved["applied"] is None:
                continue  # in full detail, as Slicer has it: untouched
            # The mapper does not adjust itself (it cannot time the GPU in a browser): told instead
            mapper.SetAutoAdjustSampleDistances(False)
            mapper.SetLockSampleDistanceToInputSpacing(False)
            if mapper.GetImageSampleDistance() != rays:
                mapper.SetImageSampleDistance(rays)
            step = saved["sampleDistance"] * steps
            if abs(current - step) > 1e-6:
                mapper.SetSampleDistance(step)
            saved["applied"] = step

    def _restoreVolumeQuality(self):
        for mapper, saved in self.savedMappers.items():
            try:
                mapper.SetAutoAdjustSampleDistances(saved["autoAdjust"])
                mapper.SetLockSampleDistanceToInputSpacing(saved["lockToSpacing"])
                mapper.SetImageSampleDistance(saved["imageSampleDistance"])
                mapper.SetSampleDistance(saved["sampleDistance"])
            except Exception:
                pass  # the volume went away
        self.savedMappers = {}
        self.volumeQuality = (1.0, 1.0)

    # ------------------------------------------------------------------ depth peeling

    def depthPeelingOn(self):
        viewNode = self.view.GetMRMLViewNode() if self.view is not None else None
        return bool(viewNode is not None and viewNode.GetUseDepthPeeling())

    def setDepthPeeling(self, on):
        """Translucent surfaces drawn with depth peeling or plainly blended (for the session: the
        view node gets its setting back when it ends)."""
        viewNode = self.view.GetMRMLViewNode() if self.view is not None else None
        if viewNode is None:
            return
        if self.savedDepthPeeling is None:
            self.savedDepthPeeling = (viewNode, viewNode.GetUseDepthPeeling())
        viewNode.SetUseDepthPeeling(bool(on))

    # ------------------------------------------------------------------ interaction handles

    def handlesShown(self):
        """Whether a markup shows its translation or rotation handles (a plane shows only its scale
        handles at first, which is not what the panel's Handles button shows)."""
        for node in self._markups():
            display = node.GetDisplayNode()
            if display is not None and display.GetHandlesInteractive() and (
                    display.GetTranslationHandleVisibility() or display.GetRotationHandleVisibility()):
                return True
        return False

    def setHandlesShown(self, shown):
        """Shows the interaction handles of every markup (translation, rotation and, for planes and
        ROIs, scale handles), or hides them. Markups placed afterwards follow."""
        self.handlesWanted = bool(shown)
        count = 0
        for node in self._markups():
            display = node.GetDisplayNode()
            if display is None:
                continue
            display.SetHandlesInteractive(self.handlesWanted)
            if self.handlesWanted:
                display.SetTranslationHandleVisibility(True)
                display.SetRotationHandleVisibility(True)
                display.SetScaleHandleVisibility(True)
            count += 1
        return f"Interaction handles {'shown' if shown else 'hidden'}" + ("" if count else " (there are no markups yet)")

    def _absoluteSizes(self, mmPerMetre):
        """Handles are drawn five glyphs big, a glyph a fraction of the screen - of a screen the
        headset does not have, and picking needs their size: while the session lasts, every markup's
        glyphs are given a size in the room (put back when it ends)."""
        for node in slicer.util.getNodesByClass("vtkMRMLMarkupsNode"):
            display = node.GetDisplayNode()
            if display is None or node.GetID() in self.savedGlyphs or not display.GetUseGlyphScale():
                continue
            self.savedGlyphs[node.GetID()] = (display.GetUseGlyphScale(), display.GetGlyphSize())
            display.SetUseGlyphScale(False)
            display.SetGlyphSize(GLYPH_SIZE_M * mmPerMetre)

    def _restoreSizes(self):
        for nodeID, (useGlyphScale, glyphSize) in self.savedGlyphs.items():
            node = slicer.mrmlScene.GetNodeByID(nodeID)
            display = node.GetDisplayNode() if node is not None else None
            if display is not None:
                display.SetGlyphSize(glyphSize)
                display.SetUseGlyphScale(useGlyphScale)
        self.savedGlyphs = {}

    @staticmethod
    def _vector(getter, size=3):
        """A vector from a VTK getter, whichever way the wrapping has it: returned (GetSize() of an
        ROI in this build) or written into a list it is given (GetCenterWorld(center))."""
        try:
            value = getter()
            if value is not None and len(value) >= size:
                return [float(v) for v in value[:size]]
        except TypeError:
            pass
        value = [0.0] * size
        getter(value)
        return value

    @staticmethod
    def _matrixAxes(matrix):
        origin = [matrix.GetElement(r, 3) for r in range(3)]
        axes = []
        for c in range(3):
            v = [matrix.GetElement(r, c) for r in range(3)]
            length = math.sqrt(sum(x * x for x in v)) or 1.0
            axes.append([x / length for x in v])
        return origin, axes

    def _handles(self, node, display):
        """The handles of a markup that are shown: (componentType, index, kind, where), where a
        translation arrow is a segment, a rotation handle a ring and the rest points (world, mm);
        each with the distance within which the tip is in it."""
        if not display.GetHandlesInteractive() or not display.GetVisibility() or not display.GetVisibility3D():
            return []
        D = slicer.vtkMRMLMarkupsDisplayNode
        size = display.GetGlyphSize() * 5.0  # the handles' scale (vtkSlicerMarkupsInteractionWidgetRepresentation)
        origin, axes = self._matrixAxes(node.GetInteractionHandleToWorldMatrix())
        at = lambda axis, k: [origin[i] + axis[i] * k * size for i in range(3)]
        handles = []
        if display.GetTranslationHandleVisibility():
            visible = list(display.GetTranslationHandleComponentVisibility())
            for i in range(3):
                if visible[i]:
                    handles.append((D.ComponentTranslationHandle, i, "segment", (at(axes[i], 0.25), at(axes[i], 1.0)), 0.2 * size))
            if visible[3]:
                handles.append((D.ComponentTranslationHandle, 3, "point", origin, 0.3 * size))
        if display.GetRotationHandleVisibility():
            visible = list(display.GetRotationHandleComponentVisibility())
            for i in range(3):
                if visible[i]:
                    handles.append((D.ComponentRotationHandle, i, "ring", (origin, axes[i], 1.15 * size), 0.15 * size))
        if display.GetScaleHandleVisibility() and display.GetCanDisplayScaleHandles():
            for index, position in self._scaleHandles(node):
                handles.append((D.ComponentScaleHandle, index, "point", position, max(0.15 * size, display.GetGlyphSize())))
        return handles

    # The sides a scale handle moves: (x, y, z) signs, by handle index (vtkMRMLMarkups*DisplayNode)
    PLANE_SCALE_SIDES = {0: (-1, 0), 1: (1, 0), 2: (0, -1), 3: (0, 1), 4: (-1, -1), 5: (1, -1), 6: (-1, 1), 7: (1, 1)}
    ROI_SCALE_SIDES = {
        0: (-1, 0, 0), 1: (1, 0, 0), 2: (0, -1, 0), 3: (0, 1, 0), 4: (0, 0, -1), 5: (0, 0, 1),
        6: (-1, -1, -1), 7: (1, -1, -1), 8: (-1, 1, -1), 9: (1, 1, -1),
        10: (-1, -1, 1), 11: (1, -1, 1), 12: (-1, 1, 1), 13: (1, 1, 1),
        14: (-1, -1, 0), 15: (1, -1, 0), 16: (-1, 1, 0), 17: (1, 1, 0),
        18: (-1, 0, -1), 19: (1, 0, -1), 20: (-1, 0, 1), 21: (1, 0, 1),
        22: (0, -1, -1), 23: (0, 1, -1), 24: (0, -1, 1), 25: (0, 1, 1),
    }

    def _roiFrame(self, node):
        """An ROI's center and axes (world) and its size along them."""
        center = self._vector(node.GetCenterWorld)
        size = self._vector(node.GetSize)
        axes = [self._vector(node.GetXAxisWorld), self._vector(node.GetYAxisWorld), self._vector(node.GetZAxisWorld)]
        return center, size, axes

    def _planeFrame(self, node):
        """A plane's center and in-plane axes (world), and its bounds along them."""
        x, y, z = [0.0] * 3, [0.0] * 3, [0.0] * 3
        node.GetAxesWorld(x, y, z)
        corners = vtk.vtkPoints()
        node.GetPlaneCornerPointsWorld(corners)
        points = [corners.GetPoint(i) for i in range(corners.GetNumberOfPoints())]
        center = [sum(p[i] for p in points) / len(points) for i in range(3)] if points else [0.0] * 3
        return center, (x, y), points

    def _scaleHandles(self, node):
        if node.IsA("vtkMRMLMarkupsPlaneNode"):
            _, _, corners = self._planeFrame(node)
            if len(corners) != 4:
                return []
            lp, la, ra, rp = corners
            mid = lambda a, b: [(a[i] + b[i]) / 2 for i in range(3)]
            return [(0, mid(la, lp)), (1, mid(ra, rp)), (2, mid(lp, rp)), (3, mid(la, ra)),
                    (4, list(lp)), (5, list(rp)), (6, list(la)), (7, list(ra))]
        if node.IsA("vtkMRMLMarkupsROINode"):
            center, size, axes = self._roiFrame(node)
            handles = []
            for index, sides in self.ROI_SCALE_SIDES.items():
                position = [center[i] + sum(sides[a] * size[a] / 2 * axes[a][i] for a in range(3)) for i in range(3)]
                handles.append((index, position))
            return handles
        return []

    def _warnOnce(self, message):
        logged = self.__dict__.setdefault("warned", set())
        if message not in logged:
            logged.add(message)
            import logging
            logging.getLogger("slicerweb.xr").warning(message)
            print(f"Slicer XR: {message}")

    @staticmethod
    def _distanceToHandle(tip, kind, where):
        if kind == "point":
            return math.dist(tip, where)
        if kind == "segment":
            a, b = where
            ab = [b[i] - a[i] for i in range(3)]
            t = sum((tip[i] - a[i]) * ab[i] for i in range(3)) / (sum(v * v for v in ab) or 1.0)
            t = min(1.0, max(0.0, t))
            return math.dist(tip, [a[i] + t * ab[i] for i in range(3)])
        center, axis, radius = where  # a ring: how far from the circle
        v = [tip[i] - center[i] for i in range(3)]
        along = sum(v[i] * axis[i] for i in range(3))
        across = math.sqrt(max(0.0, sum(x * x for x in v) - along * along))
        return math.hypot(along, across - radius)

    def _handleAt(self, tip):
        """The handle the tip is in, as (nodeID, componentType, index, how far in: 0 at its middle
        to 1 at its edge), or None."""
        best = None
        for node in slicer.util.getNodesByClass("vtkMRMLMarkupsNode"):
            display = node.GetDisplayNode()
            if display is None or node.GetLocked():
                continue
            try:
                handles = self._handles(node, display)
            except Exception as error:
                self._warnOnce(f"the handles of {node.GetName()} could not be read: {error}")
                continue
            for componentType, index, kind, where, tolerance in handles:
                relative = self._distanceToHandle(tip, kind, where) / tolerance
                if relative <= 1.0 and (best is None or relative < best[3]):
                    best = (node.GetID(), componentType, index, relative)
        return best

    # ------------------------------------------------------------------ dragging a handle

    def handleDragStart(self, nodeID, componentType, index, x, y, z):
        node = slicer.mrmlScene.GetNodeByID(nodeID)
        if node is None:
            return ""
        origin, axes = self._matrixAxes(node.GetInteractionHandleToWorldMatrix())
        D = slicer.vtkMRMLMarkupsDisplayNode
        self.handleDrag = {"node": node, "type": int(componentType), "index": int(index), "last": [x, y, z],
                           "origin": origin, "axes": axes}
        if int(componentType) == D.ComponentScaleHandle and node.IsA("vtkMRMLMarkupsPlaneNode"):
            node.SetSizeMode(slicer.vtkMRMLMarkupsPlaneNode.SizeModeAbsolute)
        kind = {D.ComponentTranslationHandle: "Moving", D.ComponentRotationHandle: "Turning",
                D.ComponentScaleHandle: "Resizing"}.get(int(componentType), "Moving")
        return f"{kind} {node.GetName()}"

    def handleDragMove(self, x, y, z):
        """The handle being dragged follows the tip: a translation arrow moves the markup along its
        axis (the center handle, freely), a ring turns it about its axis, a scale handle moves the
        sides of a plane or ROI it is on."""
        drag = self.handleDrag
        if drag is None or drag["node"].GetScene() is None:
            return ""
        node, index = drag["node"], drag["index"]
        tip, last = [float(x), float(y), float(z)], drag["last"]
        delta = [tip[i] - last[i] for i in range(3)]
        drag["last"] = tip
        D = slicer.vtkMRMLMarkupsDisplayNode
        if drag["type"] == D.ComponentTranslationHandle:
            if index < 3:
                axis = drag["axes"][index]
                along = sum(delta[i] * axis[i] for i in range(3))
                delta = [axis[i] * along for i in range(3)]
            transform = vtk.vtkTransform()
            transform.Translate(delta)
            node.ApplyTransform(transform)
            drag["origin"] = [drag["origin"][i] + delta[i] for i in range(3)]
        elif drag["type"] == D.ComponentRotationHandle:
            origin, axis = drag["origin"], drag["axes"][index]
            angle = self._angleAbout(axis, origin, last, tip)
            if angle:
                transform = vtk.vtkTransform()
                transform.Translate(origin)
                transform.RotateWXYZ(angle, axis)
                transform.Translate([-v for v in origin])
                node.ApplyTransform(transform)
                # The other axes turn with it (the one turned about stays)
                rotation = vtk.vtkTransform()
                rotation.RotateWXYZ(angle, axis)
                drag["axes"] = [list(rotation.TransformVector(a)) for a in drag["axes"]]
        elif drag["type"] == D.ComponentScaleHandle:
            self._scaleBy(node, index, delta)
        return f"{node.GetName()}" + self._describeSize(node)

    def handleDragEnd(self):
        drag, self.handleDrag = self.handleDrag, None
        if drag is None or drag["node"].GetScene() is None:
            return ""
        return f"{drag['node'].GetName()}" + self._describeSize(drag["node"])

    @staticmethod
    def _angleAbout(axis, origin, a, b):
        """The angle (degrees) that turns a to b about the axis through origin."""
        def flat(p):
            v = [p[i] - origin[i] for i in range(3)]
            along = sum(v[i] * axis[i] for i in range(3))
            return [v[i] - along * axis[i] for i in range(3)]
        u, w = flat(a), flat(b)
        if math.hypot(*u) < 1e-6 or math.hypot(*w) < 1e-6:
            return 0.0
        cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
        sin = sum(cross[i] * axis[i] for i in range(3))
        cos = sum(u[i] * w[i] for i in range(3))
        return math.degrees(math.atan2(sin, cos))

    def _scaleBy(self, node, index, delta):
        if node.IsA("vtkMRMLMarkupsPlaneNode"):
            sides = self.PLANE_SCALE_SIDES.get(index)
            if sides is None:
                return
            x, y, z = [0.0] * 3, [0.0] * 3, [0.0] * 3
            node.GetAxesWorld(x, y, z)
            bounds = self._vector(node.GetPlaneBounds, 4)  # xmin, xmax, ymin, ymax (in the plane)
            for axisIndex, (axis, side) in enumerate(zip((x, y), sides)):
                if not side:
                    continue
                along = sum(delta[i] * axis[i] for i in range(3))
                lo, hi = 2 * axisIndex, 2 * axisIndex + 1
                if side > 0:
                    bounds[hi] = max(bounds[lo] + 1.0, bounds[hi] + along)
                else:
                    bounds[lo] = min(bounds[hi] - 1.0, bounds[lo] + along)
            node.SetPlaneBounds(*bounds[:4])
        elif node.IsA("vtkMRMLMarkupsROINode"):
            sides = self.ROI_SCALE_SIDES.get(index)
            if sides is None:
                return
            center, size, axes = self._roiFrame(node)
            for a in range(3):
                if not sides[a]:
                    continue
                along = sum(delta[i] * axes[a][i] for i in range(3))
                grown = max(1.0, size[a] + sides[a] * along)
                moved = (grown - size[a]) * sides[a] / 2  # the opposite side stays where it is
                size[a] = grown
                center = [center[i] + axes[a][i] * moved for i in range(3)]
            node.SetSize(size)
            node.SetCenterWorld(center)

    @staticmethod
    def _describeSize(node):
        if node.IsA("vtkMRMLMarkupsROINode"):
            size = SlicerXR._vector(node.GetSize)
            return " - " + " x ".join(f"{s:.0f}" for s in size) + " mm"
        if node.IsA("vtkMRMLMarkupsPlaneNode"):
            b = SlicerXR._vector(node.GetPlaneBounds, 4)
            return f" - {b[1] - b[0]:.0f} x {b[3] - b[2]:.0f} mm"
        if node.IsA("vtkMRMLMarkupsAngleNode") and node.GetNumberOfDefinedControlPoints() >= 3:
            return f" - {node.GetAngleDegrees():.1f}°"
        if node.IsA("vtkMRMLMarkupsLineNode") and node.GetNumberOfDefinedControlPoints() >= 2:
            return f" - {node.GetLineLengthWorld():.1f} mm"
        return ""

    def _pointAt(self, tip, mmPerMetre):
        """The nearest control point the tip is in: within the point's glyph, or within 1.5 cm in the
        room, whichever is larger. Hidden and locked points are left alone."""
        best, bestDistance = None, None
        position = [0.0, 0.0, 0.0]
        for node in slicer.util.getNodesByClass("vtkMRMLMarkupsNode"):
            display = node.GetDisplayNode()
            if display is None or not display.GetVisibility() or not display.GetVisibility3D() or node.GetLocked():
                continue
            radius = HOVER_RADIUS_M * mmPerMetre
            if not display.GetUseGlyphScale():
                radius = max(radius, display.GetGlyphSize() / 2)
            for index in range(node.GetNumberOfControlPoints()):
                if not node.GetNthControlPointVisibility(index) or node.GetNthControlPointLocked(index):
                    continue
                if not node.GetNthControlPointPositionVisibility(index):
                    continue
                node.GetNthControlPointPositionWorld(index, position)
                distance = math.dist(position, tip) / radius
                if distance <= 1.0 and (bestDistance is None or distance < bestDistance):
                    best, bestDistance = (node.GetID(), index, distance), distance
        return best

    def _highlight(self, found, mmPerMetre):
        # Slicer's own highlight: what the tip is in is the display node's active component
        active = {f[0]: (f[1], f[2]) for f in found if f}
        for nodeID, component in list(self.activePoints.items()):
            if active.get(nodeID) != component:
                self._setActive(nodeID, None)
                del self.activePoints[nodeID]
        for nodeID, component in active.items():
            if self.activePoints.get(nodeID) != component:
                self._setActive(nodeID, component)
                self.activePoints[nodeID] = component
        # And a sphere around a control point, which shows whatever the markup looks like
        point = slicer.vtkMRMLMarkupsDisplayNode.ComponentControlPoint
        position = [0.0, 0.0, 0.0]
        for actor, f in zip(self.highlights, found):
            node = slicer.mrmlScene.GetNodeByID(f[0]) if f and f[1] == point else None
            if node is None:
                actor.VisibilityOff()
                continue
            node.GetNthControlPointPositionWorld(f[2], position)
            actor.SetPosition(position)
            actor.SetScale(HOVER_RADIUS_M * mmPerMetre)
            actor.VisibilityOn()

    @staticmethod
    def _setActive(nodeID, component):
        node = slicer.mrmlScene.GetNodeByID(nodeID)
        display = node.GetDisplayNode() if node is not None else None
        if display is None:
            return
        try:
            if component is None:
                display.SetActiveComponent(slicer.vtkMRMLMarkupsDisplayNode.ComponentNone, -1)
            else:
                display.SetActiveComponent(int(component[0]), int(component[1]))
        except Exception:
            pass  # a build without it: a control point's sphere still shows it

    @staticmethod
    def _makeHighlightActor():
        sphere = vtk.vtkSphereSource()
        sphere.SetRadius(1.0)  # scaled to the radius the tip is taken to be in
        sphere.SetThetaResolution(24)
        sphere.SetPhiResolution(16)
        mapper = vtk.vtkPolyDataMapper()
        mapper.SetInputConnection(sphere.GetOutputPort())
        actor = vtk.vtkActor()
        actor.SetMapper(mapper)
        actor.SetPickable(False)
        prop = actor.GetProperty()
        prop.SetColor(1.0, 0.85, 0.2)
        prop.SetOpacity(0.35)
        prop.LightingOff()
        actor.VisibilityOff()
        return actor

    def _newMarkup(self, className, mmPerMetre):
        node = slicer.mrmlScene.AddNewNodeByClass(className)
        if className == "vtkMRMLMarkupsPlaneNode":
            node.SetPlaneType(slicer.vtkMRMLMarkupsPlaneNode.PlaneType3Points)
        node.CreateDefaultDisplayNodes()
        display = node.GetDisplayNode()
        if display is not None:
            # A size in the room, not a fraction of a screen the headset does not have
            display.SetUseGlyphScale(False)
            display.SetGlyphSize(GLYPH_SIZE_M * mmPerMetre)
            if self.handlesWanted is not None:
                display.SetHandlesInteractive(self.handlesWanted)
                if self.handlesWanted:
                    display.SetTranslationHandleVisibility(True)
                    display.SetRotationHandleVisibility(True)
                    display.SetScaleHandleVisibility(True)
        return node

    def _lastMarkup(self):
        nodes = self._markups()
        return nodes[-1] if nodes else None

    def _markups(self):
        """The scene's markups, but the clipping plane."""
        return [node for node in slicer.util.getNodesByClass("vtkMRMLMarkupsNode") if not self._isOwn(node)]

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _toPython(value):
        return value.to_py() if hasattr(value, "to_py") else value

    @staticmethod
    def _place(actors, matrices):
        """Show each actor at its matrix (row-major 4x4), or hide it when it has none."""
        for index, actor in enumerate(actors):
            matrix = matrices[index] if matrices and index < len(matrices) else None
            if not matrix or len(matrix) != 16:
                actor.VisibilityOff()
                continue
            actor.GetUserMatrix().DeepCopy([float(v) for v in matrix])
            actor.GetUserMatrix().Modified()
            actor.VisibilityOn()

    def _renderers(self):
        renderers = self.window.GetRenderers()
        return [renderers.GetItemAsObject(index) for index in range(renderers.GetNumberOfItems())]

    @staticmethod
    def _threeDView():
        layoutManager = slicer.app.layoutManager()
        if layoutManager is None:
            return None
        views = [view for _, view in sorted(layoutManager.views().items())
                 if view.IsA("vtkSlicerWebThreeDView") and view.GetInitialized()]
        return views[0] if views else None

    def _makePanel(self):
        """A plane in the panel's space (metres, facing +z), textured with the page's picture."""
        self.panelImage = vtk.vtkImageData()
        self.panelImage.SetDimensions(2, 2, 1)
        self.panelImage.AllocateScalars(vtk.VTK_UNSIGNED_CHAR, 4)
        self.panelPlane = vtk.vtkPlaneSource()
        self.panelPlane.SetOrigin(-0.2, -0.15, 0.0)
        self.panelPlane.SetPoint1(0.2, -0.15, 0.0)
        self.panelPlane.SetPoint2(-0.2, 0.15, 0.0)
        texture = vtk.vtkTexture()
        texture.SetInputData(self.panelImage)
        texture.InterpolateOn()
        texture.SetColorModeToDirectScalars()
        if hasattr(texture, "MipmapOn"):
            texture.MipmapOn()  # seen from afar, its text is smoothed rather than shimmering
        mapper = vtk.vtkPolyDataMapper()
        mapper.SetInputConnection(self.panelPlane.GetOutputPort())
        actor = vtk.vtkActor()
        actor.SetMapper(mapper)
        actor.SetTexture(texture)
        actor.SetPickable(False)
        actor.SetUserMatrix(vtk.vtkMatrix4x4())
        prop = actor.GetProperty()
        prop.LightingOff()  # the picture as it was drawn, whatever the lights
        prop.SetColor(1.0, 1.0, 1.0)
        actor.VisibilityOff()
        self.panel = actor

    def _makeHoleActor(self):
        """A plane drawn clear - colour and alpha 0 - with its depth: where the panel's layer is, under
        the 3D view, the 3D view lets it show; what is in front of the panel is drawn over it, what
        is behind it is hidden. In the panel's space (metres), sized by _shapeHole."""
        self.holePlane = vtk.vtkPlaneSource()
        self.holeShape = None
        mapper = vtk.vtkPolyDataMapper()
        mapper.SetInputConnection(self.holePlane.GetOutputPort())
        actor = vtk.vtkActor()
        actor.SetMapper(mapper)
        actor.SetPickable(False)
        actor.SetUserMatrix(vtk.vtkMatrix4x4())
        prop = actor.GetProperty()
        prop.LightingOff()
        prop.SetColor(0.0, 0.0, 0.0)
        # Clear once the fragment has passed VTK's test for clear fragments (which would drop it,
        # and its depth with it)
        # (Coincident::Impl is the last tag of the fragment shader: replaced before VTK's own
        # replacements, the line stays after the code VTK puts there)
        actor.GetShaderProperty().AddFragmentShaderReplacement(
            "//VTK::Coincident::Impl", True, "//VTK::Coincident::Impl\n  gl_FragData[0] = vec4(0.0, 0.0, 0.0, 0.0);\n", False)
        actor.VisibilityOff()
        return actor

    def _makeRingActor(self):
        """The soft edge of the hole, in VR. The hole is cut out of the 3D view's picture pixel by
        pixel - a jagged edge between the sky and the panel, at the 3D view's resolution. Along the
        inside of the hole's edge the sky is drawn again, fading from opaque at the edge to clear:
        the sky's colour with less and less alpha, over the clear of the hole, which is the sky
        fading out. (In AR there is no sky, and the 3D view is clear on both sides of the edge.)
        A frame of 8 points: the panel's corners, then the corners of the frame's inside."""
        self.ringData = vtk.vtkPolyData()
        self.ringColors = None
        polys = vtk.vtkCellArray()
        for i in range(4):
            j = (i + 1) % 4
            for triangle in ((i, j, 4 + j), (i, 4 + j, 4 + i)):
                polys.InsertNextCell(3)
                for point in triangle:
                    polys.InsertCellPoint(point)
        self.ringData.SetPolys(polys)
        mapper = vtk.vtkPolyDataMapper()
        mapper.SetInputData(self.ringData)
        mapper.SetColorModeToDirectScalars()
        mapper.SetScalarModeToUsePointData()
        actor = vtk.vtkActor()
        actor.SetMapper(mapper)
        actor.SetPickable(False)
        actor.SetUserMatrix(vtk.vtkMatrix4x4())
        actor.GetProperty().LightingOff()
        actor.ForceOpaqueOn()  # drawn with the opaque things (blended as they are), not sorted with the translucent
        actor.VisibilityOff()
        return actor

    def _shapeHole(self, width, height, feather):
        shape = (round(width, 5), round(height, 5), round(feather, 5))
        if shape == self.holeShape:
            return
        self.holeShape = shape
        w, h = width / 2, height / 2
        self.holePlane.SetOrigin(-w, -h, 0.0)
        self.holePlane.SetPoint1(w, -h, 0.0)
        self.holePlane.SetPoint2(-w, h, 0.0)
        # The frame, a hair in front of the hole (which it would otherwise fight for the pixels)
        f = min(feather, w, h)
        points = vtk.vtkPoints()
        for x, y in ((-w, -h), (w, -h), (w, h), (-w, h), (-w + f, -h + f), (w - f, -h + f), (w - f, h - f), (-w + f, h - f)):
            points.InsertNextPoint(x, y, 0.0003)
        self.ringData.SetPoints(points)
        self.ringColors = None
        self.ringData.Modified()

    def _colorRing(self, ts):
        """The sky's colour at the frame's 8 points (ts: where on the sky's gradient each is, 0 at
        the bottom to 1 at the top), opaque at the panel's edge and clear at the frame's inside."""
        key = tuple(round(float(t), 3) for t in ts) + (self.skyColors,)
        if key == self.ringColors or self.skyColors is None:
            return
        self.ringColors = key
        bottom, top = self.skyColors
        colors = vtk.vtkUnsignedCharArray()
        colors.SetName("Colors")
        colors.SetNumberOfComponents(4)
        for index, t in enumerate(key[:8]):
            rgb = [255.0 * (bottom[c] * (1.0 - t) + top[c] * t) for c in range(3)]
            colors.InsertNextTuple4(rgb[0], rgb[1], rgb[2], 255.0 if index < 4 else 0.0)
        self.ringData.GetPointData().SetScalars(colors)
        self.ringData.Modified()

    def _makeSkyActor(self):
        """A sphere around the viewer (radius 1, placed and sized by its user matrix, its y up),
        coloured as the view's background: its second colour above, its first below."""
        sphere = vtk.vtkSphereSource()
        sphere.SetRadius(1.0)
        sphere.SetThetaResolution(32)
        sphere.SetPhiResolution(32)
        sphere.SetStartPhi(0.0)
        sphere.SetEndPhi(180.0)
        # vtkSphereSource's poles are on z: turned so that they are on y, the room's up
        turn = vtk.vtkTransform()
        turn.RotateX(-90.0)
        turned = vtk.vtkTransformPolyDataFilter()
        turned.SetTransform(turn)
        turned.SetInputConnection(sphere.GetOutputPort())
        turned.Update()
        self.skyPolyData = turned.GetOutput()
        self.skyColors = None
        mapper = vtk.vtkPolyDataMapper()
        mapper.SetInputData(self.skyPolyData)
        mapper.SetColorModeToDirectScalars()
        mapper.SetScalarModeToUsePointData()
        actor = vtk.vtkActor()
        actor.SetMapper(mapper)
        actor.SetPickable(False)
        actor.SetUserMatrix(vtk.vtkMatrix4x4())
        actor.GetProperty().LightingOff()
        actor.VisibilityOff()
        return actor

    def _colorSky(self):
        viewNode = self.view.GetMRMLViewNode() if self.view is not None else None
        if viewNode is None:
            return
        bottom, top = viewNode.GetBackgroundColor(), viewNode.GetBackgroundColor2()
        if self.skyColors == (bottom, top):
            return
        self.skyColors = (bottom, top)
        colors = vtk.vtkUnsignedCharArray()
        colors.SetName("Colors")
        colors.SetNumberOfComponents(3)
        points = self.skyPolyData.GetPoints()
        for i in range(points.GetNumberOfPoints()):
            t = (points.GetPoint(i)[1] + 1.0) / 2.0  # 0 below, 1 above
            colors.InsertNextTuple3(*[255.0 * (bottom[c] * (1.0 - t) + top[c] * t) for c in range(3)])
        self.skyPolyData.GetPointData().SetScalars(colors)
        self.skyPolyData.Modified()

    @staticmethod
    def _makeRayActor():
        """A controller's ray to the panel: a ribbon turned to the viewer, white along its middle
        and fading to clear at both edges - a line with soft edges, where a line drawn as a line is
        jagged at the 3D view's resolution (it is not antialiased). 8 points: across the ribbon
        (clear, white, white, clear) at its start, then at its end; set each frame by _shapeRays."""
        points = vtk.vtkPoints()
        colors = vtk.vtkUnsignedCharArray()
        colors.SetName("Colors")
        colors.SetNumberOfComponents(4)
        for index in range(8):
            points.InsertNextPoint(0.0, 0.0, 0.0)
            colors.InsertNextTuple4(255.0, 255.0, 255.0, 255.0 if index % 4 in (1, 2) else 0.0)
        polys = vtk.vtkCellArray()
        for j in range(3):
            for triangle in ((j, j + 1, 5 + j), (j, 5 + j, 4 + j)):
                polys.InsertNextCell(3)
                for point in triangle:
                    polys.InsertCellPoint(point)
        ribbon = vtk.vtkPolyData()
        ribbon.SetPoints(points)
        ribbon.SetPolys(polys)
        ribbon.GetPointData().SetScalars(colors)
        mapper = vtk.vtkPolyDataMapper()
        mapper.SetInputData(ribbon)
        mapper.SetColorModeToDirectScalars()
        mapper.SetScalarModeToUsePointData()
        actor = vtk.vtkActor()
        actor.SetMapper(mapper)
        actor.SetPickable(False)
        actor.GetProperty().LightingOff()
        actor.ForceOpaqueOn()  # drawn with the opaque things (blended as they are), as the panel's soft edge is
        actor.VisibilityOff()
        return actor

    def _shapeRays(self, rays):
        for index, actor in enumerate(self.rays):
            corners = rays[index] if rays and index < len(rays) else None
            if not corners or len(corners) != 24:
                actor.VisibilityOff()
                continue
            ribbon = actor.GetMapper().GetInput()
            points = ribbon.GetPoints()
            for i in range(8):
                points.SetPoint(i, float(corners[3 * i]), float(corners[3 * i + 1]), float(corners[3 * i + 2]))
            points.Modified()
            ribbon.Modified()
            actor.VisibilityOn()


    @staticmethod
    def _makeControllerActor(color):
        """A controller as a small sphere with a cone pointing where it points: built in metres in
        the controller's space, placed in the scene by its user matrix (which carries the scale).
        Markups points are placed at the tip of the cone."""
        sphere = vtk.vtkSphereSource()
        sphere.SetRadius(0.012)
        sphere.SetThetaResolution(20)
        sphere.SetPhiResolution(12)
        cone = vtk.vtkConeSource()
        cone.SetHeight(0.06)
        cone.SetRadius(0.008)
        cone.SetResolution(20)
        cone.SetDirection(0.0, 0.0, -1.0)
        cone.SetCenter(0.0, 0.0, -0.045)
        append = vtk.vtkAppendPolyData()
        append.AddInputConnection(sphere.GetOutputPort())
        append.AddInputConnection(cone.GetOutputPort())
        normals = vtk.vtkPolyDataNormals()
        normals.SetInputConnection(append.GetOutputPort())
        mapper = vtk.vtkPolyDataMapper()
        mapper.SetInputConnection(normals.GetOutputPort())
        actor = vtk.vtkActor()
        actor.SetMapper(mapper)
        actor.SetPickable(False)
        actor.SetUserMatrix(vtk.vtkMatrix4x4())
        actor.GetProperty().SetColor(*color)
        actor.GetProperty().SetSpecular(0.4)
        actor.VisibilityOff()
        return actor


slicerXR = SlicerXR()
slicerXR

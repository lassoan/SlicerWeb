"""Segment Editor effects of desktop Slicer, ported to work without Qt.

- Draw: an outline drawn point by point in a slice view fills the segment inside it
  (SegmentEditorDrawEffect.py)
- Scissors: a free-form, circle or rectangle outline cuts through the segments, from a slice view or
  from the viewpoint of a 3D view (qSlicerSegmentEditorScissorsEffect.cxx)
- Mask volume: fill a volume inside or outside a segment (SegmentEditorMaskVolumeEffect.py)
- The preview of the auto-complete effects, Grow from seeds and Fill between slices: the result is
  computed into a preview segmentation, kept up to date while the inputs are edited, and replaces
  the segments when it is applied (AbstractScriptedSegmentEditorAutoCompleteEffect.py)

The interaction follows the desktop effects event for event; what differs is how outlines are
drawn: WebGL draws lines one device pixel wide whatever width is asked for, which is a third of a
CSS pixel on a phone, so outlines are made of thin quads as wide as the desktop's lines look.
"""

import logging
import math
import time

from . import host

logger = logging.getLogger("slicerweb.segmenteditor")

# The names of the effects on the desktop, which their parameters are stored under in the segment
# editor node ("<effect name>.<parameter>"), so that a scene saved by either has the same settings
DESKTOP_NAMES = {
    "Paint": "Paint",
    "Erase": "Erase",
    "GrowFromSeeds": "Grow from seeds",
    "FillBetweenSlices": "Fill between slices",
    "Draw": "Draw",
    "Scissors": "Scissors",
    "MaskVolume": "Mask volume",
    "Logic": "Logical operators",
    "Islands": "Islands",
    "Smoothing": "Smoothing",
    "Margin": "Margin",
}

# Parameters of the effects and their defaults (the desktop effects' setMRMLDefaults)
PARAMETER_DEFAULTS = {
    # Click-and-drag in a 3D view paints on the surface under the mouse instead of rotating the view
    "Paint": {"EditIn3DViews": 0},
    "Erase": {"EditIn3DViews": 0},
    "GrowFromSeeds": {"AutoUpdate": 1, "SeedLocalityFactor": 0.0},
    "FillBetweenSlices": {"AutoUpdate": 1},
    "Scissors": {"Operation": "EraseInside", "Shape": "FreeForm", "ShapeDrawCentered": 0,
                 "SliceCutMode": "Unlimited", "SliceCutDepthMm": 0.0, "ApplyToAllVisibleSegments": 0},
    "MaskVolume": {"Operation": "FILL_OUTSIDE", "FillValue": 0.0, "BinaryMaskFillValueInside": 1.0,
                   "BinaryMaskFillValueOutside": 0.0, "SoftEdgeMm": 0.0},
    # Ignore the masking settings and only modify the selected segment
    "Logic": {"BypassMasking": 1},
    "Islands": {"Operation": "KEEP_LARGEST_ISLAND", "MinimumSize": 1000},
    "Smoothing": {"SmoothingMethod": "MEDIAN", "KernelSizeMm": 3.0, "GaussianStandardDeviationMm": 3.0,
                  "JointTaubinSmoothingFactor": 0.5, "ApplyToAllVisibleSegments": 0, "EditIn3DViews": 0},
    # Negative: shrink
    "Margin": {"MarginSizeMm": 3.0, "ApplyToAllVisibleSegments": 0},
}

AUTO_COMPLETE_EFFECTS = ("GrowFromSeeds", "FillBetweenSlices")


def parameter(editorNode, effect, name):
    """A parameter of an effect, of the type of its default."""
    default = PARAMETER_DEFAULTS[effect][name]
    value = editorNode.GetAttribute(f"{DESKTOP_NAMES[effect]}.{name}")
    if value is None or value == "":
        return default
    try:
        if isinstance(default, int):
            return int(float(value))
        if isinstance(default, float):
            return float(value)
    except ValueError:
        return default
    return value


def setParameter(editorNode, effect, name, value):
    if name not in PARAMETER_DEFAULTS.get(effect, {}):
        raise ValueError(f"{effect} has no parameter {name}")
    if isinstance(value, bool):
        value = int(value)
    editorNode.SetAttribute(f"{DESKTOP_NAMES[effect]}.{name}", str(value))


def parameters(editorNode, effect):
    return {name: parameter(editorNode, effect, name) for name in PARAMETER_DEFAULTS.get(effect, {})}


def nodeReference(editorNode, effect, role):
    return editorNode.GetNodeReference(f"{DESKTOP_NAMES[effect]}.{role}")


def setNodeReference(editorNode, effect, role, nodeID):
    editorNode.SetNodeReferenceID(f"{DESKTOP_NAMES[effect]}.{role}", nodeID or None)


def _devicePixelRatio():
    import slicer

    try:
        return max(1.0, float(slicer.app.devicePixelRatio()))
    except Exception:
        return 1.0


# --------------------------------------------------------------------------- outlines
class Outline2D:
    """A polyline in the display coordinates of a view, drawn as quads of a width in CSS pixels."""

    def __init__(self, view, color, widthCssPixels):
        import vtk

        self.view = view
        self.width = widthCssPixels * _devicePixelRatio()
        self.polyData = vtk.vtkPolyData()
        mapper = vtk.vtkPolyDataMapper2D()
        mapper.SetInputData(self.polyData)
        self.actor = vtk.vtkActor2D()
        self.actor.SetMapper(mapper)
        self.actor.GetProperty().SetColor(*color)
        self.actor.VisibilityOff()
        renderer = view.GetRenderer()
        if renderer is not None:
            renderer.AddViewProp(self.actor)

    def remove(self):
        renderer = self.view.GetRenderer()
        if renderer is not None:
            renderer.RemoveViewProp(self.actor)
        self.view.ScheduleRender()

    def set(self, points, closed=False, dashed=False):
        """Show the line through the points (x, y), or nothing for fewer than two."""
        import vtk

        quads = vtk.vtkPoints()
        cells = vtk.vtkCellArray()
        half = 0.5 * self.width
        segments = list(zip(points, points[1:]))
        if closed and len(points) > 2:
            segments.append((points[-1], points[0]))
        # As the desktop's stipple texture: 8 pixels on and 8 off (in device pixels there)
        dash = 8.0 * _devicePixelRatio() if dashed else None
        travelled = 0.0
        for (x0, y0), (x1, y1) in segments:
            length = math.hypot(x1 - x0, y1 - y0)
            if length == 0:
                continue
            pieces = [(0.0, length)]
            if dash:
                pieces = []
                position = 0.0
                while position < length:
                    phase = (travelled + position) % (2 * dash)
                    run = min(length - position, (dash if phase < dash else 2 * dash) - phase)
                    if phase < dash:
                        pieces.append((position, position + run))
                    position += run
            travelled += length
            ux, uy = (x1 - x0) / length, (y1 - y0) / length
            nx, ny = -uy * half, ux * half
            for start, end in pieces:
                # Extended by half the width at both ends, so that lines meet without gaps
                ax, ay = x0 + ux * (start - half), y0 + uy * (start - half)
                bx, by = x0 + ux * (end + half), y0 + uy * (end + half)
                first = quads.InsertNextPoint(ax + nx, ay + ny, 0.0)
                quads.InsertNextPoint(bx + nx, by + ny, 0.0)
                quads.InsertNextPoint(bx - nx, by - ny, 0.0)
                quads.InsertNextPoint(ax - nx, ay - ny, 0.0)
                cells.InsertNextCell(4, [first, first + 1, first + 2, first + 3])
        self.polyData.SetPoints(quads)
        self.polyData.SetPolys(cells)
        self.polyData.Modified()
        self.actor.SetVisibility(cells.GetNumberOfCells() > 0)
        self.view.ScheduleRender()


def _anyModifierKey(interactor):
    return bool(interactor.GetShiftKey() or interactor.GetControlKey() or interactor.GetAltKey())


def _isSliceView(view):
    return view.IsA("vtkSlicerWebSliceView")


# --------------------------------------------------------------------------- Draw
class DrawPipeline:
    """The outline being drawn in one slice view (DrawPipeline of SegmentEditorDrawEffect.py)."""

    def __init__(self, effect, view):
        import vtk

        self.effect = effect
        self.view = view
        self.sliceNode = view.GetSliceNode()
        self.activeSliceOffset = None
        self.lastInsertSliceNodeMTime = None
        self.actionState = None
        self.rasPoints = []
        self.dashed = False
        self.outline = Outline2D(view, (1.0, 1.0, 0.0), 1.0)
        self.sliceNodeObserver = self.sliceNode.AddObserver(vtk.vtkCommand.ModifiedEvent, self.onSliceNodeModified)

    def remove(self):
        self.sliceNode.RemoveObserver(self.sliceNodeObserver)
        self.outline.remove()

    def sliceOffset(self):
        import slicer

        sliceLogic = slicer.app.applicationLogic().GetSliceLogic(self.sliceNode)
        if sliceLogic is not None:
            return sliceLogic.GetSliceOffset()
        sliceToRas = self.sliceNode.GetSliceToRAS()
        return sum(sliceToRas.GetElement(r, 2) * sliceToRas.GetElement(r, 3) for r in range(3))

    def xyToRas(self, xy):
        ras = [0.0, 0.0, 0.0, 1.0]
        self.sliceNode.GetXYToRAS().MultiplyPoint([float(xy[0]), float(xy[1]), 0.0, 1.0], ras)
        return ras[:3]

    def xyPoints(self):
        import vtk

        rasToXy = vtk.vtkMatrix4x4()
        vtk.vtkMatrix4x4.Invert(self.sliceNode.GetXYToRAS(), rasToXy)
        points = []
        for ras in self.rasPoints:
            xy = [0.0, 0.0, 0.0, 1.0]
            rasToXy.MultiplyPoint(list(ras) + [1.0], xy)
            points.append((xy[0], xy[1]))
        return points

    def addPoint(self, ras):
        # The slice the outline is drawn on is the one of its first point
        currentSliceOffset = self.sliceOffset()
        if self.activeSliceOffset is None:
            self.activeSliceOffset = currentSliceOffset
            self.dashed = False
        if self.activeSliceOffset != currentSliceOffset:
            return
        # Keep track of node state (in case of pan/zoom)
        self.lastInsertSliceNodeMTime = self.sliceNode.GetMTime()
        self.rasPoints.append(ras)

    def deleteLastPoint(self):
        if self.rasPoints:
            self.rasPoints.pop()
        self.positionActors()

    def resetPolyData(self):
        self.rasPoints = []
        self.activeSliceOffset = None
        self.positionActors()

    def positionActors(self):
        self.outline.set(self.xyPoints(), closed=False, dashed=self.dashed)

    def onSliceNodeModified(self, caller, event):
        # On another slice than the one drawn on the outline is dashed, as on the desktop
        dashed = False
        if self.activeSliceOffset is not None and abs(self.sliceOffset() - self.activeSliceOffset) > 0.01:
            if len(self.rasPoints) == 1:
                # One placed point is not visible to the user so clear the state upon changing slice offset
                self.resetPolyData()
                return
            dashed = True
        self.dashed = dashed
        self.positionActors()

    def apply(self):
        import vtk

        points = self.xyPoints()
        if len(points) > 1:
            editor = self.effect.editor
            if editor.prepareModifierForEdit():
                # The outline, closed back to the first point, in the XY coordinates of the slice view
                polyData = vtk.vtkPolyData()
                xyPoints = vtk.vtkPoints()
                lines = vtk.vtkCellArray()
                for x, y in points:
                    xyPoints.InsertNextPoint(x, y, 0.0)
                for index in range(len(points)):
                    lines.InsertNextCell(2, [index, (index + 1) % len(points)])
                polyData.SetPoints(xyPoints)
                polyData.SetLines(lines)
                outline, extent = outlineMask(polyData, self.sliceNode, editor.logic)
                if outline is not None:
                    editor.modifySegments(outline, "Add", extent=extent)
        self.resetPolyData()


def outlineMask(polyData, sliceNode, logic):
    """The outline filled, on the voxels of the segmentation, over the region it covers only.

    vtkSlicerSegmentEditorLogic::AppendPolyMask fills the outline the same way
    (CreateMaskImageFromPolyData), but resamples it onto the whole modifier labelmap, the size of
    the volume: over a second in a web page for an outline of a few thousand voxels. Returns the
    mask and its extent, or (None, None) when the outline is outside of the segmentation.
    """
    import slicer
    import vtk

    mask = slicer.vtkOrientedImageData()
    slicer.vtkSlicerSegmentEditorLogic.CreateMaskImageFromPolyData(polyData, mask, sliceNode)
    segmentationNode = logic.GetSegmentationNode()
    parent = segmentationNode.GetParentTransformNode() if segmentationNode is not None else None
    if parent is not None:
        if not parent.IsTransformToWorldLinear():
            logger.error("Draw: the segmentation has a non-linear transform, which cannot be drawn on")
            return None, None
        worldToSegmentation = vtk.vtkMatrix4x4()
        parent.GetMatrixTransformFromWorld(worldToSegmentation)
        imageToWorld = vtk.vtkMatrix4x4()
        mask.GetImageToWorldMatrix(imageToWorld)
        imageToSegmentation = vtk.vtkMatrix4x4()
        vtk.vtkMatrix4x4.Multiply4x4(worldToSegmentation, imageToWorld, imageToSegmentation)
        mask.SetImageToWorldMatrix(imageToSegmentation)

    logic.UpdateReferenceGeometryImage()
    reference = logic.GetReferenceGeometryImage()
    # Where the mask is, in voxels of the segmentation (a voxel more on each side)
    segmentationToIjk = vtk.vtkMatrix4x4()
    reference.GetWorldToImageMatrix(segmentationToIjk)
    transform = vtk.vtkTransform()
    transform.SetMatrix(segmentationToIjk)
    bounds = [0.0, -1.0, 0.0, -1.0, 0.0, -1.0]
    slicer.vtkOrientedImageDataResample.TransformOrientedImageDataBounds(mask, transform, bounds)
    referenceExtent = reference.GetExtent()
    extent = []
    for a in range(3):
        extent += [max(referenceExtent[2 * a], int(math.floor(bounds[2 * a])) - 1),
                   min(referenceExtent[2 * a + 1], int(math.ceil(bounds[2 * a + 1])) + 1)]
    if any(extent[2 * a] > extent[2 * a + 1] for a in range(3)):
        return None, None
    region = slicer.vtkOrientedImageData()
    region.ShallowCopy(reference)
    region.SetExtent(extent)
    outline = slicer.vtkOrientedImageData()
    slicer.vtkOrientedImageDataResample.ResampleOrientedImageToReferenceOrientedImage(mask, region, outline)
    return outline, extent


class DrawEffect:
    def __init__(self, editor):
        self.editor = editor
        self.pipelines = {}

    def deactivate(self):
        for pipeline in self.pipelines.values():
            pipeline.remove()
        self.pipelines = {}

    def pipeline(self, view):
        pipeline = self.pipelines.get(view)
        if pipeline is None:
            pipeline = DrawPipeline(self, view)
            self.pipelines[view] = pipeline
        return pipeline

    def processEvent(self, view, interactor, event):
        """SegmentEditorDrawEffect.processInteractionEvents: returns whether the event is taken."""
        if not _isSliceView(view):
            return False
        pipeline = self.pipeline(view)
        abort = False
        modifier = _anyModifierKey(interactor)
        if event == "LeftButtonPressEvent" and not modifier:
            if not self.editor.canEdit():
                return False
            pipeline.actionState = "drawing"
            pipeline.addPoint(pipeline.xyToRas(interactor.GetEventPosition()))
            abort = True
        elif event == "LeftButtonReleaseEvent":
            if pipeline.actionState == "drawing":
                pipeline.actionState = "moving"
                abort = True
        elif event == "RightButtonPressEvent" and not modifier:
            pipeline.actionState = "finishing"
            pipeline.lastInsertSliceNodeMTime = pipeline.sliceNode.GetMTime()
            abort = True
        elif ((event == "RightButtonReleaseEvent" and pipeline.actionState == "finishing")
              or (event == "LeftButtonDoubleClickEvent" and not modifier)):
            abort = len(pipeline.rasPoints) > 1
            # Not when the right button dragged (zoomed) the view
            if pipeline.lastInsertSliceNodeMTime is not None and abs(pipeline.lastInsertSliceNodeMTime - pipeline.sliceNode.GetMTime()) < 2:
                pipeline.apply()
                pipeline.actionState = ""
        elif event == "MouseMoveEvent":
            if pipeline.actionState == "drawing":
                pipeline.addPoint(pipeline.xyToRas(interactor.GetEventPosition()))
                abort = True
        elif event == "KeyPressEvent":
            key = interactor.GetKeySym()
            # The browser calls the key Enter, Qt calls it Return
            if key in ("a", "Return", "Enter"):
                pipeline.apply()
                abort = True
            if key == "x":
                pipeline.deleteLastPoint()
                abort = True
        pipeline.positionActors()
        return abort


# --------------------------------------------------------------------------- Scissors
class ScissorsPipeline:
    def __init__(self, view):
        self.view = view
        self.isDragging = False
        self.points = []   # the outline, in display coordinates of the view
        self.outline = Outline2D(view, (1.0, 1.0, 0.0), 2.0)
        # The free-form outline is closed by a thinner and darker line
        self.outlineThin = Outline2D(view, (0.7, 0.7, 0.0), 1.0)

    def remove(self):
        self.outline.remove()
        self.outlineThin.remove()


class ScissorsEffect:
    CircleNumberOfPoints = 36
    FillValue = 1
    EraseValue = 0

    def __init__(self, editor):
        self.editor = editor
        self.pipelines = {}
        self.dragStart = (0, 0)

    def parameter(self, name):
        return parameter(self.editor.editorNode, "Scissors", name)

    def operationInside(self):
        return self.parameter("Operation") in ("EraseInside", "FillInside")

    def operationErase(self):
        return self.parameter("Operation") in ("EraseInside", "EraseOutside")

    def deactivate(self):
        for pipeline in self.pipelines.values():
            pipeline.remove()
        self.pipelines = {}

    def pipeline(self, view):
        pipeline = self.pipelines.get(view)
        if pipeline is None:
            pipeline = ScissorsPipeline(view)
            self.pipelines[view] = pipeline
        return pipeline

    def processEvent(self, view, interactor, event):
        """qSlicerSegmentEditorScissorsEffect::processInteractionEvents"""
        pipeline = self.pipeline(view)
        position = tuple(interactor.GetEventPosition())
        if event == "LeftButtonPressEvent" and not _anyModifierKey(interactor):
            if not self.editor.canEdit():
                return False
            pipeline.isDragging = True
            self.createGlyph(pipeline, position)
            return True
        if event == "MouseMoveEvent" and pipeline.isDragging:
            self.updateGlyph(pipeline, position, False)
            return True
        if event == "LeftButtonReleaseEvent" and pipeline.isDragging:
            self.updateGlyph(pipeline, position, True)
            pipeline.isDragging = False
            try:
                if len(pipeline.points) > 1:
                    self.paintApply(pipeline)
            finally:
                pipeline.outline.set([])
                pipeline.outlineThin.set([])
            return True
        return False

    def createGlyph(self, pipeline, position):
        shape = self.parameter("Shape")
        count = {"Rectangle": 4, "Circle": self.CircleNumberOfPoints}.get(shape, 1)
        self.dragStart = position
        pipeline.points = [position] * count
        self.showGlyph(pipeline)

    def updateGlyph(self, pipeline, position, finalize):
        shape = self.parameter("Shape")
        centered = bool(self.parameter("ShapeDrawCentered"))
        x0, y0 = self.dragStart
        x, y = position
        if shape == "Rectangle":
            if centered:
                halfWidth, halfHeight = abs(x - x0), abs(y - y0)
                pipeline.points = [(x0 - halfWidth, y0 - halfHeight), (x0 + halfWidth, y0 - halfHeight),
                                   (x0 + halfWidth, y0 + halfHeight), (x0 - halfWidth, y0 + halfHeight)]
            else:
                pipeline.points = [(x0, y0), (x0, y), (x, y), (x, y0)]
        elif shape == "Circle":
            radius = math.hypot(x - x0, y - y0)
            if centered:
                center, circleRadius = (x0, y0), radius
            else:
                center, circleRadius = ((x + x0) / 2, (y + y0) / 2), radius / 2
            pipeline.points = [(center[0] + circleRadius * math.sin(2.0 * math.pi * i / self.CircleNumberOfPoints),
                                center[1] + circleRadius * math.cos(2.0 * math.pi * i / self.CircleNumberOfPoints))
                               for i in range(self.CircleNumberOfPoints)]
        else:
            pipeline.points.append(position)
        self.showGlyph(pipeline, finalize)

    def showGlyph(self, pipeline, finalize=False):
        if self.parameter("Shape") == "FreeForm":
            pipeline.outline.set(pipeline.points, closed=finalize)
            pipeline.outlineThin.set([] if finalize else [pipeline.points[0], pipeline.points[-1]])
        else:
            pipeline.outline.set(pipeline.points, closed=True)
            pipeline.outlineThin.set([])

    def brushModel(self, pipeline, modifierLabelmap):
        """The outline swept through the segmentation: from the slice plane, or along the rays of the camera."""
        import slicer
        import vtk

        points = pipeline.points
        if len(points) < 3:
            return None   # at least a triangle is needed
        segmentationNode = self.editor.logic.GetSegmentationNode()
        segmentationToWorld = vtk.vtkMatrix4x4()
        slicer.vtkMRMLTransformNode.GetMatrixTransformBetweenNodes(
            segmentationNode.GetParentTransformNode(), None, segmentationToWorld)
        surfacePoints = vtk.vtkPoints()   # p0Top, p0Bottom, p1Top, p1Bottom, ...
        additionalBrushRegion = None
        view = pipeline.view
        if _isSliceView(view):
            sliceNode = view.GetSliceNode()
            # Modifier labelmap extent in slice coordinate system, to know how much to cut through
            worldToSliceXY = vtk.vtkMatrix4x4()
            vtk.vtkMatrix4x4.Invert(sliceNode.GetXYToRAS(), worldToSliceXY)
            segmentationToSliceXY = vtk.vtkTransform()
            segmentationToSliceXY.Concatenate(worldToSliceXY)
            segmentationToSliceXY.Concatenate(segmentationToWorld)
            bounds = [0.0, -1.0, 0.0, -1.0, 0.0, -1.0]
            slicer.vtkOrientedImageDataResample.TransformOrientedImageDataBounds(modifierLabelmap, segmentationToSliceXY, bounds)
            originalBounds = list(bounds)
            sliceCutMode = self.parameter("SliceCutMode")
            if sliceCutMode == "Positive":
                bounds[4] = 0
            elif sliceCutMode == "Negative":
                bounds[5] = 0
            elif sliceCutMode == "Symmetric":
                sliceXYToSegmentation = vtk.vtkMatrix4x4()
                vtk.vtkMatrix4x4.Invert(segmentationToSliceXY.GetMatrix(), sliceXYToSegmentation)
                normal = [0.0, 0.0, 0.0, 0.0]
                sliceXYToSegmentation.MultiplyPoint([0.0, 0.0, 1.0, 0.0], normal)
                sliceThicknessMmPerPixel = math.sqrt(sum(c * c for c in normal[:3]))
                halfDepthPixel = self.parameter("SliceCutDepthMm") / sliceThicknessMmPerPixel / 2.0
                halfDepthPixel = max(halfDepthPixel, 0.5)   # include at least the current slice
                bounds[4], bounds[5] = -halfDepthPixel, halfDepthPixel
            brushZEpsilon = 0.001   # main and additional brush planes very close but not coincident
            if sliceCutMode != "Symmetric":
                # Half a slice more, so that the current slice and the last one are fully included
                if bounds[4] < bounds[5]:
                    bounds[4] -= 0.5
                    bounds[5] += 0.5
                else:
                    bounds[4] += 0.5
                    bounds[5] -= 0.5
                    brushZEpsilon = -0.001
            if not self.operationInside() and sliceCutMode != "Unlimited":
                # The side of the plane that is not cut stays as it is when working "outside"
                append = vtk.vtkAppendPolyData()
                if sliceCutMode in ("Positive", "Symmetric"):
                    cube = vtk.vtkCubeSource()
                    cube.SetBounds(bounds[0], bounds[1], bounds[2], bounds[3], originalBounds[4], bounds[4] - brushZEpsilon)
                    cube.Update()
                    append.AddInputData(cube.GetOutput())
                if sliceCutMode in ("Negative", "Symmetric"):
                    cube = vtk.vtkCubeSource()
                    cube.SetBounds(bounds[0], bounds[1], bounds[2], bounds[3], bounds[5] + brushZEpsilon, originalBounds[5])
                    cube.Update()
                    append.AddInputData(cube.GetOutput())
                toRas = vtk.vtkTransform()
                toRas.SetMatrix(sliceNode.GetXYToRAS())
                toRasFilter = vtk.vtkTransformPolyDataFilter()
                toRasFilter.SetTransform(toRas)
                toRasFilter.SetInputConnection(append.GetOutputPort())
                toRasFilter.Update()
                additionalBrushRegion = toRasFilter.GetOutput()
            xyToRas = sliceNode.GetXYToRAS()
            for x, y in points:
                for z in (bounds[4], bounds[5]):
                    world = [0.0, 0.0, 0.0, 1.0]
                    xyToRas.MultiplyPoint([float(x), float(y), z, 1.0], world)
                    surfacePoints.InsertNextPoint(world[:3])
        else:
            renderer = view.GetRenderer()
            camera = renderer.GetActiveCamera() if renderer is not None else None
            if camera is None:
                return None
            cameraPos = list(camera.GetPosition())
            cameraFP = list(camera.GetFocalPoint())
            cameraDOP = [cameraFP[i] - cameraPos[i] for i in range(3)]
            vtk.vtkMath.Normalize(cameraDOP)
            cameraViewUp = list(camera.GetViewUp())
            vtk.vtkMath.Normalize(cameraViewUp)
            renderer.SetWorldPoint(cameraFP[0], cameraFP[1], cameraFP[2], 1.0)
            renderer.WorldToDisplay()
            selectionZ = renderer.GetDisplayPoint()[2]
            # Modifier labelmap extent in camera coordinate system, to know how much to cut through
            cameraViewRight = [0.0, 0.0, 0.0]
            vtk.vtkMath.Cross(cameraDOP, cameraViewUp, cameraViewRight)
            cameraToWorld = vtk.vtkMatrix4x4()
            for i in range(3):
                cameraToWorld.SetElement(i, 3, cameraPos[i])
                cameraToWorld.SetElement(i, 0, cameraViewUp[i])
                cameraToWorld.SetElement(i, 1, cameraViewRight[i])
                cameraToWorld.SetElement(i, 2, cameraDOP[i])
            worldToCamera = vtk.vtkMatrix4x4()
            vtk.vtkMatrix4x4.Invert(cameraToWorld, worldToCamera)
            segmentationToCamera = vtk.vtkTransform()
            segmentationToCamera.Concatenate(worldToCamera)
            segmentationToCamera.Concatenate(segmentationToWorld)
            bounds = [0.0, -1.0, 0.0, -1.0, 0.0, -1.0]
            slicer.vtkOrientedImageDataResample.TransformOrientedImageDataBounds(modifierLabelmap, segmentationToCamera, bounds)
            clipFromLabelmap = [min(bounds[4], bounds[5]) - 0.5, max(bounds[4], bounds[5]) + 0.5]
            # What the camera sees, reduced to the modifier labelmap to keep the stencil small
            clipFromCamera = camera.GetClippingRange()
            clipRange = [max(clipFromLabelmap[0], clipFromCamera[0]), min(clipFromLabelmap[1], clipFromCamera[1])]
            for x, y in points:
                renderer.SetDisplayPoint(x, y, selectionZ)
                renderer.DisplayToWorld()
                world = renderer.GetWorldPoint()
                if world[3] == 0.0:
                    logger.warning("Scissors: bad homogeneous coordinates")
                    return None
                pick = [world[i] / world[3] for i in range(3)]
                # The ray from the camera through the point, between the clipping planes
                ray = [pick[i] - cameraPos[i] for i in range(3)]
                rayLength = vtk.vtkMath.Dot(cameraDOP, ray)
                if rayLength == 0.0:
                    return None
                if camera.GetParallelProjection():
                    tF, tB = clipRange[0] - rayLength, clipRange[1] - rayLength
                    p1 = [pick[i] + tF * cameraDOP[i] for i in range(3)]
                    p2 = [pick[i] + tB * cameraDOP[i] for i in range(3)]
                else:
                    tF, tB = clipRange[0] / rayLength, clipRange[1] / rayLength
                    p1 = [cameraPos[i] + tF * ray[i] for i in range(3)]
                    p2 = [cameraPos[i] + tB * ray[i] for i in range(3)]
                surfacePoints.InsertNextPoint(p1)
                surfacePoints.InsertNextPoint(p2)

        count = len(points)
        strips = vtk.vtkCellArray()   # the skirt
        strips.InsertNextCell(count * 2 + 2, list(range(count * 2)) + [0, 1])
        polys = vtk.vtkCellArray()    # front and back caps
        polys.InsertNextCell(count, [i * 2 for i in range(count)])
        polys.InsertNextCell(count, [i * 2 + 1 for i in range(count)])
        surface = vtk.vtkPolyData()
        surface.SetPoints(surfacePoints)
        surface.SetStrips(strips)
        surface.SetPolys(polys)
        if additionalBrushRegion is not None:
            append = vtk.vtkAppendPolyData()
            append.AddInputData(surface)
            append.AddInputData(additionalBrushRegion)
            append.Update()
            surface = append.GetOutput()
        return surface

    def paintApply(self, pipeline):
        import slicer
        import vtk

        editor = self.editor
        if not editor.prepareModifierForEdit():
            return
        modifierLabelmap = editor.logic.GetModifierLabelmap()
        surface = self.brushModel(pipeline, modifierLabelmap)
        if surface is None:
            return
        segmentationNode = editor.logic.GetSegmentationNode()

        normals = vtk.vtkPolyDataNormals()
        normals.AutoOrientNormalsOn()
        normals.SetInputData(surface)
        worldToIjk = vtk.vtkTransform()
        worldToModifierIjk = vtk.vtkMatrix4x4()
        modifierLabelmap.GetWorldToImageMatrix(worldToModifierIjk)
        worldToIjk.Concatenate(worldToModifierIjk)
        worldToSegmentation = vtk.vtkMatrix4x4()
        slicer.vtkMRMLTransformNode.GetMatrixTransformBetweenNodes(
            None, segmentationNode.GetParentTransformNode(), worldToSegmentation)
        worldToIjk.Concatenate(worldToSegmentation)
        toIjk = vtk.vtkTransformPolyDataFilter()
        toIjk.SetTransform(worldToIjk)
        toIjk.SetInputConnection(normals.GetOutputPort())
        toIjk.Update()
        toStencil = vtk.vtkPolyDataToImageStencil()
        toStencil.SetOutputSpacing(1.0, 1.0, 1.0)
        toStencil.SetInputConnection(toIjk.GetOutputPort())
        modifierExtent = modifierLabelmap.GetExtent()
        modificationExtent = None
        if self.operationInside():
            # Only the region of the brush, which makes modifying the labelmap faster
            b = toIjk.GetOutput().GetBounds()
            brushExtent = [math.floor(b[0]) - 1, math.ceil(b[1]) + 1, math.floor(b[2]) - 1,
                           math.ceil(b[3]) + 1, math.floor(b[4]) - 1, math.ceil(b[5]) + 1]
            toStencil.SetOutputWholeExtent(*[int(v) for v in brushExtent])
            modificationExtent = [max(brushExtent[a], modifierExtent[a]) if a % 2 == 0 else min(brushExtent[a], modifierExtent[a])
                                  for a in range(6)]
        else:
            toStencil.SetOutputWholeExtent(modifierExtent)

        stencilToImage = vtk.vtkImageStencilToImage()
        stencilToImage.SetInputConnection(toStencil.GetOutputPort())
        inside, outside = (self.FillValue, self.EraseValue) if self.operationInside() else (self.EraseValue, self.FillValue)
        stencilToImage.SetInsideValue(inside)
        stencilToImage.SetOutsideValue(outside)
        stencilToImage.SetOutputScalarType(modifierLabelmap.GetScalarType())
        stencilToImage.Update()
        brush = slicer.vtkOrientedImageData()
        brush.ShallowCopy(stencilToImage.GetOutput())
        imageToWorld = vtk.vtkMatrix4x4()
        modifierLabelmap.GetImageToWorldMatrix(imageToWorld)
        brush.SetImageToWorldMatrix(imageToWorld)
        slicer.vtkOrientedImageDataResample.ModifyImage(
            modifierLabelmap, brush, slicer.vtkOrientedImageDataResample.OPERATION_MAXIMUM)

        if modificationExtent is not None and any(modificationExtent[2 * a] > modificationExtent[2 * a + 1] for a in range(3)):
            return   # the outline is outside of the segmentation
        segmentIDs = None
        if self.parameter("ApplyToAllVisibleSegments"):
            visible = vtk.vtkStringArray()
            displayNode = segmentationNode.GetDisplayNode()
            if displayNode is not None:
                displayNode.GetVisibleSegmentIDs(visible)
            segmentIDs = [visible.GetValue(i) for i in range(visible.GetNumberOfValues())]
        editor.modifySegments(modifierLabelmap, "Remove" if self.operationErase() else "Add",
                              segmentIDs=segmentIDs, extent=modificationExtent)


# --------------------------------------------------------------------------- Mask volume
def maskVolumeWithSegment(segmentationNode, segmentID, operationMode, fillValues, inputVolumeNode, outputVolumeNode,
                          softEdgeMm=0.0):
    """Fill voxels of the input volume inside/outside the segment (SegmentEditorMaskVolumeEffect.maskVolumeWithSegment).

    fillValues: one value for FILL_INSIDE and FILL_OUTSIDE, inside and outside values for FILL_INSIDE_AND_OUTSIDE.
    """
    import slicer
    import vtk

    segmentIDs = vtk.vtkStringArray()
    segmentIDs.InsertNextValue(segmentID)
    maskVolumeNode = slicer.modules.volumes.logic().CreateAndAddLabelVolume(inputVolumeNode, "TemporaryVolumeMask")
    if not maskVolumeNode:
        raise RuntimeError("Failed to create the mask volume")
    try:
        if not slicer.vtkSlicerSegmentationsModuleLogic.ExportSegmentsToLabelmapNode(
                segmentationNode, segmentIDs, maskVolumeNode, inputVolumeNode):
            raise RuntimeError("Failed to export the segment to a labelmap volume")

        if softEdgeMm == 0:
            # Hard edge
            maskToStencil = vtk.vtkImageToImageStencil()
            maskToStencil.ThresholdByLower(0)
            maskToStencil.SetInputData(maskVolumeNode.GetImageData())
            stencil = vtk.vtkImageStencil()
            if operationMode == "FILL_INSIDE_AND_OUTSIDE":
                # Set input to constant value
                thresh = vtk.vtkImageThreshold()
                thresh.SetInputData(inputVolumeNode.GetImageData())
                thresh.ThresholdByLower(0)
                thresh.SetInValue(fillValues[1])
                thresh.SetOutValue(fillValues[1])
                thresh.SetOutputScalarType(inputVolumeNode.GetImageData().GetScalarType())
                thresh.Update()
                stencil.SetInputData(thresh.GetOutput())
            else:
                stencil.SetInputData(inputVolumeNode.GetImageData())
            stencil.SetStencilConnection(maskToStencil.GetOutputPort())
            stencil.SetReverseStencil(operationMode == "FILL_OUTSIDE")
            stencil.SetBackgroundValue(fillValues[0])
            stencil.Update()
            outputVolumeNode.SetAndObserveImageData(stencil.GetOutput())
        else:
            # Soft edge
            import numpy as np
            from vtk.util import numpy_support

            thresh = vtk.vtkImageThreshold()
            thresh.SetOutputScalarTypeToUnsignedChar()
            thresh.SetInputData(maskVolumeNode.GetImageData())
            thresh.ThresholdByLower(0)
            thresh.SetInValue(0)
            thresh.SetOutValue(255)
            thresh.Update()
            gaussianFilter = vtk.vtkImageGaussianSmooth()
            spacing = maskVolumeNode.GetSpacing()
            gaussianFilter.SetInputConnection(thresh.GetOutputPort())
            gaussianFilter.SetStandardDeviations(*[softEdgeMm / spacing[i] for i in range(3)])
            # Not truncated at the default 1.5 sigma, which would leave edge artifacts
            gaussianFilter.SetRadiusFactor(3.0)
            gaussianFilter.Update()
            maskImage = gaussianFilter.GetOutput()
            maskArray = numpy_support.vtk_to_numpy(maskImage.GetPointData().GetScalars()).reshape(
                tuple(reversed(maskImage.GetDimensions())))
            # Normalized with the actual minimum and maximum, which the Gaussian does not keep exactly.
            # In single precision and in place: a volume of doubles is more than a page has to spare.
            maskMin, maskMax = float(maskArray.min()), float(maskArray.max())
            mask = maskArray.astype(np.float32)
            mask -= maskMin
            mask *= (1.0 / (maskMax - maskMin)) if maskMax > maskMin else 0.0
            inputArray = slicer.util.arrayFromVolume(inputVolumeNode)
            if operationMode == "FILL_INSIDE_AND_OUTSIDE":
                # Rescale the smoothed mask
                mask *= float(fillValues[1] - fillValues[0])
                mask += float(fillValues[0])
                resultArray = mask
            else:
                # Weighted average of the fill value and the input volume: input * mask + fill * (1 - mask)
                if operationMode == "FILL_INSIDE":
                    np.subtract(1.0, mask, out=mask)
                resultArray = inputArray.astype(np.float32)
                resultArray -= float(fillValues[0])
                resultArray *= mask
                resultArray += float(fillValues[0])
                del mask
            slicer.util.updateVolumeFromArray(outputVolumeNode, resultArray.astype(inputArray.dtype))

        # The same geometry and parent transform as the input volume
        ijkToRas = vtk.vtkMatrix4x4()
        inputVolumeNode.GetIJKToRASMatrix(ijkToRas)
        outputVolumeNode.SetIJKToRASMatrix(ijkToRas)
        outputVolumeNode.SetAndObserveTransformNodeID(inputVolumeNode.GetTransformNodeID())
    finally:
        displayNode = maskVolumeNode.GetDisplayNode()
        if displayNode is not None:
            if displayNode.GetColorNode() is not None and displayNode.GetColorNode().GetScene() is not None \
                    and not displayNode.GetColorNode().GetSingletonTag():
                slicer.mrmlScene.RemoveNode(displayNode.GetColorNode())
            slicer.mrmlScene.RemoveNode(displayNode)
        slicer.mrmlScene.RemoveNode(maskVolumeNode)
    return True


def setSliceViewerBackground(volumeNode):
    """Show the volume in the background of all slice views (slicer.util.setSliceViewerLayers(background=...))."""
    import slicer

    if volumeNode is None:
        return
    composites = slicer.mrmlScene.GetNodesByClass("vtkMRMLSliceCompositeNode")
    try:
        for i in range(composites.GetNumberOfItems()):
            composites.GetItemAsObject(i).SetBackgroundVolumeID(volumeNode.GetID())
    finally:
        composites.UnRegister(None)


def isVolumeVisible(volumeNode):
    import slicer

    if volumeNode is None:
        return False
    composites = slicer.mrmlScene.GetNodesByClass("vtkMRMLSliceCompositeNode")
    try:
        return any(composites.GetItemAsObject(i).GetBackgroundVolumeID() == volumeNode.GetID()
                   for i in range(composites.GetNumberOfItems()))
    finally:
        composites.UnRegister(None)


class MaskVolumeEffect:
    def __init__(self, editor):
        self.editor = editor

    def inputVolume(self):
        node = nodeReference(self.editor.editorNode, "MaskVolume", "InputVolume")
        return node if node is not None else self.editor.logic.GetSourceVolumeNode()

    def outputVolume(self):
        return nodeReference(self.editor.editorNode, "MaskVolume", "OutputVolume")

    def deactivate(self):
        # The output is not shown any more, the volume being segmented is (as on the desktop)
        setSliceViewerBackground(self.editor.logic.GetSourceVolumeNode())

    def state(self):
        inputVolume, outputVolume = self.inputVolume(), self.outputVolume()
        explicitInput = nodeReference(self.editor.editorNode, "MaskVolume", "InputVolume")
        return {
            "inputVolumeNodeID": explicitInput.GetID() if explicitInput is not None else None,
            "outputVolumeNodeID": outputVolume.GetID() if outputVolume is not None else None,
            "inputVisible": isVolumeVisible(inputVolume),
            "outputVisible": isVolumeVisible(outputVolume),
        }

    def apply(self):
        import slicer

        editor = self.editor
        segmentationNode = editor.logic.GetSegmentationNode()
        segmentID = editor.logic.GetCurrentSegmentID()
        if segmentationNode is None or not segmentID:
            raise RuntimeError("Select a segment first")
        inputVolume = self.inputVolume()
        if inputVolume is None:
            raise RuntimeError("Select an input volume or a source volume first")
        outputVolume = self.outputVolume()
        node = editor.editorNode
        operationMode = parameter(node, "MaskVolume", "Operation")
        if outputVolume is None:
            # A new node for the output
            volumesLogic = slicer.modules.volumes.logic()
            if operationMode == "FILL_INSIDE_AND_OUTSIDE":
                outputVolume = volumesLogic.CreateAndAddLabelVolume(inputVolume, inputVolume.GetName() + " label")
            else:
                outputVolume = volumesLogic.CloneVolumeGeneric(
                    inputVolume.GetScene(), inputVolume, inputVolume.GetName() + " masked", False)
            setNodeReference(node, "MaskVolume", "OutputVolume", outputVolume.GetID())
        if operationMode in ("FILL_INSIDE", "FILL_OUTSIDE"):
            fillValues = [parameter(node, "MaskVolume", "FillValue")]
        else:
            fillValues = [parameter(node, "MaskVolume", "BinaryMaskFillValueInside"),
                          parameter(node, "MaskVolume", "BinaryMaskFillValueOutside")]
        maskVolumeWithSegment(segmentationNode, segmentID, operationMode, fillValues, inputVolume, outputVolume,
                              softEdgeMm=parameter(node, "MaskVolume", "SoftEdgeMm"))
        setSliceViewerBackground(outputVolume)


# --------------------------------------------------------------------------- auto-complete preview
ResultPreviewNodeReferenceRole = "SegmentationResultPreview"


class AutoCompletePreview:
    """The preview of Grow from seeds and Fill between slices (AbstractScriptedSegmentEditorAutoCompleteEffect).

    Initialize computes the result for all visible segments into a preview segmentation, shown over
    the inputs; while it is there, editing the inputs (with Paint, say) updates it a second after the
    last change; Apply replaces the segments by it and Cancel removes it.
    """

    autoUpdateDelaySec = 1.0
    minimumExtentMargin = 3

    def __init__(self, editor):
        self.editor = editor
        self.mergedLabelmapGeometryImage = None
        self.selectedSegmentIds = None
        self.selectedSegmentModifiedTimes = {}
        self.clippedSourceImageData = None
        self.clippedMaskImageData = None
        self.growCutFilter = None
        self.extentGrowthRatio = 0.1
        self.observedSegmentation = None
        self.segmentationObserverTags = []
        self.previewComputationInProgress = False
        self._timerGeneration = 0   # a newer request makes the pending ones do nothing
        self._timerPending = False

    # --- settings of the effects
    @staticmethod
    def minimumNumberOfSegments(effect):
        return 2 if effect == "GrowFromSeeds" else 1

    @staticmethod
    def minimumNumberOfSegmentsWithEditableArea(effect):
        return 1

    # --- the preview node
    def owner(self):
        """The effect whose preview is shown, or None."""
        node = self.editor.editorNode
        if node.GetNodeReference(ResultPreviewNodeReferenceRole) is None:
            return None
        owner = node.GetAttribute("SegmentationResultPreviewOwnerEffect") or ""
        for effect, name in DESKTOP_NAMES.items():
            if name == owner:
                return effect
        return None

    def previewNode(self, effect=None):
        node = self.editor.editorNode.GetNodeReference(ResultPreviewNodeReferenceRole)
        if node is not None and effect is not None and self.owner() != effect:
            return None   # another effect owns this preview node
        return node

    def state(self):
        owner = self.owner()
        previewNode = self.previewNode()
        return {
            "effect": owner,
            "opacity": self.getPreviewOpacity(),
            "show3D": self.getPreviewShow3D(),
            "computing": self.previewComputationInProgress or self._timerPending,
        } if owner is not None and previewNode is not None else None

    # --- observing the inputs
    def observeSegmentation(self, enabled):
        import slicer

        segmentationNode = self.editor.logic.GetSegmentationNode()
        segmentation = segmentationNode.GetSegmentation() if segmentationNode is not None else None
        if enabled and self.observedSegmentation is segmentation:
            return
        if not enabled and self.observedSegmentation is None:
            return
        if self.observedSegmentation is not None:
            for tag in self.segmentationObserverTags:
                self.observedSegmentation.RemoveObserver(tag)
            self.segmentationObserverTags = []
            self.observedSegmentation = None
        if enabled and segmentation is not None:
            self.observedSegmentation = segmentation
            for event in (slicer.vtkSegmentation.SegmentAdded, slicer.vtkSegmentation.SegmentRemoved,
                          slicer.vtkSegmentation.SegmentModified, slicer.vtkSegmentation.SourceRepresentationModified):
                self.segmentationObserverTags.append(segmentation.AddObserver(event, self.onSegmentationModified))

    def restore(self):
        """Follow the inputs of a preview the scene has, which this object did not compute.

        The preview segmentation and which effect owns it are kept in the scene, but which segments
        it was computed from, and the watching of them for auto-update, only here: after a scene is
        loaded (or the page is started again) they are taken from the preview itself, whose
        segments have the IDs of the segments they were computed from. The first change of the
        inputs then computes it again, as on the desktop with the effect active.
        """
        import vtk

        if self.selectedSegmentIds is not None or self.owner() is None:
            return
        previewNode = self.previewNode()
        segmentationNode = self.editor.logic.GetSegmentationNode()
        if previewNode is None or segmentationNode is None:
            return
        segmentIDs = vtk.vtkStringArray()
        segmentation = segmentationNode.GetSegmentation()
        for i in range(previewNode.GetSegmentation().GetNumberOfSegments()):
            segmentID = previewNode.GetSegmentation().GetNthSegmentID(i)
            if segmentation.GetSegment(segmentID) is not None:
                segmentIDs.InsertNextValue(segmentID)
        if segmentIDs.GetNumberOfValues() == 0:
            return
        self.selectedSegmentIds = segmentIDs
        self.updateObservation()

    def forget(self):
        """The scene was closed: nothing of its preview is followed any more."""
        self._timerGeneration += 1
        self._timerPending = False
        self.observeSegmentation(False)
        self.observedSegmentation = None
        self.segmentationObserverTags = []
        self.mergedLabelmapGeometryImage = None
        self.selectedSegmentIds = None
        self.selectedSegmentModifiedTimes = {}
        self.clippedSourceImageData = None
        self.clippedMaskImageData = None
        self.growCutFilter = None

    def updateObservation(self):
        owner = self.owner()
        autoUpdate = owner is not None and parameter(self.editor.editorNode, owner, "AutoUpdate")
        if not autoUpdate:
            self._timerGeneration += 1
            self._timerPending = False
        self.observeSegmentation(bool(autoUpdate))

    def onSegmentationModified(self, caller, event):
        import slicer

        owner = self.owner()
        if owner is None or not parameter(self.editor.editorNode, owner, "AutoUpdate") or self.selectedSegmentIds is None:
            return
        segmentation = self.editor.logic.GetSegmentationNode().GetSegmentation()
        updateNeeded = False
        for index in range(self.selectedSegmentIds.GetNumberOfValues()):
            segmentID = self.selectedSegmentIds.GetValue(index)
            segment = segmentation.GetSegment(segmentID)
            if not segment:
                # An input segment was deleted
                logger.info("Segmentation operation is cancelled because an input segment was deleted")
                self.reset()
                host.emit("segment-editor-changed", self.editor.state())
                return
            labelmap = segment.GetRepresentation(slicer.vtkSegmentationConverter.GetSegmentationBinaryLabelmapRepresentationName())
            if segmentID in self.selectedSegmentModifiedTimes and labelmap and labelmap.GetMTime() == self.selectedSegmentModifiedTimes[segmentID]:
                continue   # this segment has not changed since the last update
            if labelmap:
                self.selectedSegmentModifiedTimes[segmentID] = labelmap.GetMTime()
            else:
                self.selectedSegmentModifiedTimes.pop(segmentID, None)
            updateNeeded = True
        if updateNeeded and not self.previewComputationInProgress:
            # One edit may modify several segments: the update waits for the last of them
            self.scheduleUpdate()

    def scheduleUpdate(self):
        from .qtcompat import dom

        self._timerGeneration += 1
        generation = self._timerGeneration
        self._timerPending = True

        def fire():
            if generation != self._timerGeneration:
                return
            self._timerPending = False
            owner = self.owner()
            if owner is None:
                return
            try:
                self.onPreview(owner)
            except Exception as e:
                logger.error("%s auto-complete failed: %s", DESKTOP_NAMES[owner], e)
            host.emit("segment-editor-changed", self.editor.state())

        dom.set_timeout(fire, int(self.autoUpdateDelaySec * 1000))

    # --- display
    def setPreviewOpacity(self, opacity):
        segmentationNode = self.editor.logic.GetSegmentationNode()
        if segmentationNode is not None and segmentationNode.GetDisplayNode() is not None:
            segmentationNode.GetDisplayNode().SetOpacity(1.0 - opacity)
        previewNode = self.previewNode()
        if previewNode is not None and previewNode.GetDisplayNode() is not None:
            previewNode.GetDisplayNode().SetOpacity(opacity)
            previewNode.GetDisplayNode().SetOpacity3D(opacity)

    def getPreviewOpacity(self):
        previewNode = self.previewNode()
        return previewNode.GetDisplayNode().GetOpacity() if previewNode is not None and previewNode.GetDisplayNode() else 0.6

    def setPreviewShow3D(self, show):
        from .panels import showSurfaces

        previewNode = self.previewNode()
        if previewNode is not None:
            showSurfaces(previewNode, bool(show))

    def getPreviewShow3D(self):
        from .panels import shownIn3D

        previewNode = self.previewNode()
        return bool(previewNode is not None and shownIn3D(previewNode))

    # --- computing
    def onPreview(self, effect):
        if self.previewComputationInProgress:
            return
        self.previewComputationInProgress = True
        try:
            self.preview(effect)
        finally:
            self.previewComputationInProgress = False

    def reset(self):
        import slicer

        self._timerGeneration += 1
        self._timerPending = False
        self.observeSegmentation(False)
        node = self.editor.editorNode
        previewNode = node.GetNodeReference(ResultPreviewNodeReferenceRole)
        if previewNode is not None:
            node.SetNodeReferenceID(ResultPreviewNodeReferenceRole, None)
            slicer.mrmlScene.RemoveNode(previewNode)
            node.SetAttribute("SegmentationResultPreviewOwnerEffect", "")
        segmentationNode = self.editor.logic.GetSegmentationNode()
        if segmentationNode is not None and segmentationNode.GetDisplayNode() is not None:
            segmentationNode.GetDisplayNode().SetOpacity(1.0)
        self.mergedLabelmapGeometryImage = None
        self.selectedSegmentIds = None
        self.selectedSegmentModifiedTimes = {}
        self.clippedSourceImageData = None
        self.clippedMaskImageData = None
        self.growCutFilter = None

    def cancel(self):
        self.reset()

    @staticmethod
    def isBackgroundLabelmap(labelmap, label=None):
        """Five or more corner voxels of the image are set: it is the background."""
        if labelmap is None:
            return False
        extent = labelmap.GetExtent()
        if extent[0] > extent[1] or extent[2] > extent[3] or extent[4] > extent[5]:
            return False
        filled = 0
        for i in (0, 1):
            for j in (2, 3):
                for k in (4, 5):
                    value = labelmap.GetScalarComponentAsFloat(extent[i], extent[j], extent[k], 0)
                    if (value > 0) if label is None else (value == label):
                        filled += 1
                    if filled > 4:
                        return True
        return False

    def apply(self):
        import slicer
        import vtk
        from .panels import showSurfaces

        self._timerGeneration += 1
        self._timerPending = False
        self.observeSegmentation(False)
        previewNode = self.previewNode()
        if previewNode is None:
            raise RuntimeError("Initialize the preview first")
        segmentationNode = self.editor.logic.GetSegmentationNode()
        displayNode = segmentationNode.GetDisplayNode()
        self.editor.logic.SaveStateForUndo()
        previewShownIn3D = self.getPreviewShow3D()
        # The segments of the preview replace the segments
        segmentIDs = vtk.vtkStringArray()
        previewNode.GetSegmentation().GetSegmentIDs(segmentIDs)
        for index in range(segmentIDs.GetNumberOfValues()):
            segmentID = segmentIDs.GetValue(index)
            labelmap = slicer.vtkOrientedImageData()
            previewNode.GetBinaryLabelmapRepresentation(segmentID, labelmap)
            self.editor.logic.ModifySegmentByLabelmap(segmentationNode, segmentID, labelmap,
                                                      slicer.vtkSlicerSegmentEditorLogic.ModificationModeSet, False, False)
            if displayNode is not None and self.isBackgroundLabelmap(labelmap):
                # Segments that are the background (all eight corners set) are hidden
                displayNode.SetSegmentVisibility(segmentID, False)
            previewNode.GetSegmentation().RemoveSegment(segmentID)   # now, to limit memory usage
        if previewShownIn3D:
            showSurfaces(segmentationNode, True)
        self.reset()

    def effectiveExtentChanged(self, effect):
        import slicer

        if self.previewNode(effect) is None or self.mergedLabelmapGeometryImage is None or self.selectedSegmentIds is None:
            return True
        segmentationNode = self.editor.logic.GetSegmentationNode()
        # The effective extent of the input segments now
        effectiveGeometry = segmentationNode.GetSegmentation().DetermineCommonLabelmapGeometry(
            slicer.vtkSegmentation.EXTENT_UNION_OF_EFFECTIVE_SEGMENTS, self.selectedSegmentIds)
        if not effectiveGeometry:
            return True
        effectiveGeometryImage = slicer.vtkOrientedImageData()
        slicer.vtkSegmentationConverter.DeserializeImageGeometry(effectiveGeometry, effectiveGeometryImage)
        sourceExtent = self.sourceImageData().GetExtent()
        effective = effectiveGeometryImage.GetExtent()
        current = self.mergedLabelmapGeometryImage.GetExtent()
        # Less than a 3 voxel margin around the segments (where the source volume is larger)
        margin = self.minimumExtentMargin
        return any(
            (sourceExtent[2 * a] != current[2 * a] and current[2 * a] > effective[2 * a] - margin)
            or (sourceExtent[2 * a + 1] != current[2 * a + 1] and current[2 * a + 1] < effective[2 * a + 1] + margin)
            for a in range(3))

    def sourceImageData(self):
        logic = self.editor.logic
        logic.UpdateAlignedSourceVolume()
        return logic.GetAlignedSourceVolume()

    def preview(self, effect):
        import slicer
        import vtk

        editor = self.editor
        segmentationNode = editor.logic.GetSegmentationNode()
        if segmentationNode is None:
            raise RuntimeError("Select a segmentation first")
        sourceImageData = self.sourceImageData()
        if sourceImageData is None:
            raise RuntimeError("Select a source volume first")
        editorNode = editor.editorNode

        previewNode = self.previewNode(effect)
        # How the preview is shown is kept when it is computed again (as on the desktop)
        hadPreview = previewNode is not None
        previewOpacity = self.getPreviewOpacity()
        previewShow3D = self.getPreviewShow3D()
        # The input segments, if they are set already, are kept
        currentSelectedSegmentIds = self.selectedSegmentIds

        if self.effectiveExtentChanged(effect):
            if previewNode is None:
                # A preview of another effect is not kept
                currentSelectedSegmentIds = None
            self.reset()
            self.selectedSegmentIds = currentSelectedSegmentIds
            if self.selectedSegmentIds is None:
                self.selectedSegmentIds = vtk.vtkStringArray()
                segmentationNode.GetDisplayNode().GetVisibleSegmentIDs(self.selectedSegmentIds)

            minimum = self.minimumNumberOfSegments(effect)
            minimumWithEditableArea = self.minimumNumberOfSegmentsWithEditableArea(effect)
            count = self.selectedSegmentIds.GetNumberOfValues()
            if minimum != minimumWithEditableArea:
                editableAreaSpecified = (editorNode.GetSourceVolumeIntensityMask()
                                         or editorNode.GetMaskMode() != slicer.vtkMRMLSegmentationNode.EditAllowedEverywhere)
                if editableAreaSpecified and count < minimumWithEditableArea:
                    self.selectedSegmentIds = None
                    raise RuntimeError(f"Minimum {minimumWithEditableArea} visible segments are required.")
                if not editableAreaSpecified and count < minimum:
                    self.selectedSegmentIds = None
                    raise RuntimeError(f"Minimum {minimum} visible segments (or specification of editable area or "
                                       "intensity range) is required.")
            elif count < minimum:
                self.selectedSegmentIds = None
                raise RuntimeError(f"Minimum {minimum} visible segments are required.")

            # The extent of the segments, grown by a margin relative to their size but at least 3 voxels
            commonGeometry = segmentationNode.GetSegmentation().DetermineCommonLabelmapGeometry(
                slicer.vtkSegmentation.EXTENT_UNION_OF_EFFECTIVE_SEGMENTS, self.selectedSegmentIds)
            if not commonGeometry:
                self.selectedSegmentIds = None
                raise RuntimeError("All visible segments are empty: paint into them first")
            self.mergedLabelmapGeometryImage = slicer.vtkOrientedImageData()
            slicer.vtkSegmentationConverter.DeserializeImageGeometry(commonGeometry, self.mergedLabelmapGeometryImage)
            if effect == "GrowFromSeeds":
                # Masking: the background segment does not surround the region of interest, so the
                # extent grows more
                maskUsed = (editorNode.GetSourceVolumeIntensityMask()
                            or editorNode.GetMaskMode() != slicer.vtkMRMLSegmentationNode.EditAllowedEverywhere)
                self.extentGrowthRatio = 0.50 if maskUsed else 0.20
            else:
                self.extentGrowthRatio = 0.1
            sourceExtent = sourceImageData.GetExtent()
            labelsExtent = self.mergedLabelmapGeometryImage.GetExtent()
            margin = [int(max(3, self.extentGrowthRatio * (labelsExtent[2 * a + 1] - labelsExtent[2 * a]))) for a in range(3)]
            expanded = []
            for a in range(3):
                expanded += [max(sourceExtent[2 * a], labelsExtent[2 * a] - margin[a]),
                             min(sourceExtent[2 * a + 1], labelsExtent[2 * a + 1] + margin[a])]
            self.mergedLabelmapGeometryImage.SetExtent(expanded)

            # The preview node
            previewNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode")
            previewNode.CreateDefaultDisplayNodes()
            previewNode.GetDisplayNode().SetVisibility2DOutline(False)
            if segmentationNode.GetParentTransformNode():
                previewNode.SetAndObserveTransformNodeID(segmentationNode.GetParentTransformNode().GetID())
            editorNode.SetNodeReferenceID(ResultPreviewNodeReferenceRole, previewNode.GetID())
            editorNode.SetAttribute("SegmentationResultPreviewOwnerEffect", DESKTOP_NAMES[effect])
            if not hadPreview:
                previewOpacity = 0.6
            # No smoothing for the closed surface, which makes it fast
            previewNode.GetSegmentation().SetConversionParameter(
                slicer.vtkBinaryLabelmapToClosedSurfaceConversionRule.GetSmoothingFactorParameterName(), "-0.5")
            if not hadPreview:
                previewShow3D = editor._shownIn3D(segmentationNode)

            if effect == "GrowFromSeeds":
                # The source volume intensities are used, and masking
                self.clippedSourceImageData = slicer.vtkOrientedImageData()
                clipper = vtk.vtkImageConstantPad()
                clipper.SetInputData(sourceImageData)
                clipper.SetOutputWholeExtent(self.mergedLabelmapGeometryImage.GetExtent())
                clipper.Update()
                self.clippedSourceImageData.ShallowCopy(clipper.GetOutput())
                self.clippedSourceImageData.CopyDirections(self.mergedLabelmapGeometryImage)
                self.clippedMaskImageData = slicer.vtkOrientedImageData()
                intensityBasedMasking = editorNode.GetSourceVolumeIntensityMask()
                maskSegmentID = editorNode.GetMaskSegmentID() or ""
                intensityRange = editorNode.GetSourceVolumeIntensityMaskRange() if intensityBasedMasking else None
                if not segmentationNode.GenerateEditMask(
                        self.clippedMaskImageData, editorNode.GetMaskMode(), self.clippedSourceImageData, "",
                        maskSegmentID, self.clippedSourceImageData if intensityBasedMasking else None, intensityRange):
                    logger.error("Failed to create edit mask")
                    self.clippedMaskImageData = None

        previewNode.SetName(segmentationNode.GetName() + " preview")
        mergedImage = slicer.vtkOrientedImageData()
        segmentationNode.GenerateMergedLabelmapForAllSegments(
            mergedImage, slicer.vtkSegmentation.EXTENT_UNION_OF_EFFECTIVE_SEGMENTS,
            self.mergedLabelmapGeometryImage, self.selectedSegmentIds)
        outputLabelmap = slicer.vtkOrientedImageData()
        self.computePreviewLabelmap(effect, mergedImage, outputLabelmap)

        segmentation = previewNode.GetSegmentation()
        if segmentation.GetNumberOfSegments() != self.selectedSegmentIds.GetNumberOfValues():
            # First update (or the number of segments changed): a full reinitialization
            segmentation.RemoveAllSegments()
        labelmapName = slicer.vtkSegmentationConverter.GetSegmentationBinaryLabelmapRepresentationName()
        for index in range(self.selectedSegmentIds.GetNumberOfValues()):
            segmentID = self.selectedSegmentIds.GetValue(index)
            previewSegment = segmentation.GetSegment(segmentID)
            if not previewSegment:
                inputSegment = segmentationNode.GetSegmentation().GetSegment(segmentID)
                previewSegment = slicer.vtkSegment()
                previewSegment.SetName(inputSegment.GetName())
                previewSegment.SetColor(inputSegment.GetColor())
                segmentation.AddSegment(previewSegment, segmentID)
            labelValue = index + 1   # n-th segment label value = n + 1 (background label value is 0)
            previewSegment.AddRepresentation(labelmapName, outputLabelmap)
            previewSegment.SetLabelValue(labelValue)
            # Result segments that are the background (all eight corners set) are hidden in 3D
            previewNode.GetDisplayNode().SetSegmentVisibility3D(segmentID, not self.isBackgroundLabelmap(outputLabelmap, labelValue))
        # Remember what the inputs were, so that only a change of them updates the preview
        segmentationOfInputs = segmentationNode.GetSegmentation()
        for index in range(self.selectedSegmentIds.GetNumberOfValues()):
            segmentID = self.selectedSegmentIds.GetValue(index)
            segment = segmentationOfInputs.GetSegment(segmentID)
            labelmap = segment.GetRepresentation(labelmapName) if segment else None
            if labelmap is not None:
                self.selectedSegmentModifiedTimes[segmentID] = labelmap.GetMTime()
        segmentation.Modified()

        # If the preview was reset, the display options are restored
        self.setPreviewOpacity(previewOpacity)
        self.setPreviewShow3D(previewShow3D)
        self.updateObservation()

    def computePreviewLabelmap(self, effect, mergedImage, outputLabelmap):
        import vtk
        import vtkITK

        if effect == "GrowFromSeeds":
            if self.growCutFilter is None:
                self.growCutFilter = vtkITK.vtkITKGrowCut()
                self.growCutFilter.SetIntensityVolume(self.clippedSourceImageData)
                self.growCutFilter.SetMaskVolume(self.clippedMaskImageData)
            self.growCutFilter.SetDistancePenalty(float(parameter(self.editor.editorNode, effect, "SeedLocalityFactor")))
            self.growCutFilter.SetSeedLabelVolume(mergedImage)
            startTime = time.time()
            self.growCutFilter.Update()
            dimensions = self.clippedSourceImageData.GetDimensions()
            logger.info("Grow-cut operation on volume of %dx%dx%d voxels was completed in %.1f seconds.",
                        dimensions[0], dimensions[1], dimensions[2], time.time() - startTime)
            outputLabelmap.DeepCopy(self.growCutFilter.GetOutput())
        else:
            interpolator = vtkITK.vtkITKMorphologicalContourInterpolator()
            interpolator.SetInputData(mergedImage)
            interpolator.Update()
            outputLabelmap.DeepCopy(interpolator.GetOutput())
        imageToWorld = vtk.vtkMatrix4x4()
        mergedImage.GetImageToWorldMatrix(imageToWorld)
        outputLabelmap.SetImageToWorldMatrix(imageToWorld)


def clippedToContent(image, margin):
    """The image clipped to where it is not empty, grown by a margin (voxels, per axis), or None if it is empty.

    Filters on a segment need only the region the segment is in, and the margin they reach beyond
    it: what they do with the rest of the volume, empty, changes nothing. Labelmaps of a segment
    have the size of the volume, and in a web page memory and time follow the voxels processed.
    """
    import slicer
    import vtk

    extent = [0, -1, 0, -1, 0, -1]
    slicer.vtkOrientedImageDataResample.CalculateEffectiveExtent(image, extent, 0)
    if extent[0] > extent[1] or extent[2] > extent[3] or extent[4] > extent[5]:
        return None
    imageExtent = image.GetExtent()
    clipExtent = []
    for a in range(3):
        clipExtent += [max(imageExtent[2 * a], extent[2 * a] - margin[a]), min(imageExtent[2 * a + 1], extent[2 * a + 1] + margin[a])]
    clipper = vtk.vtkImageClip()
    clipper.SetOutputWholeExtent(clipExtent)
    clipper.SetInputData(image)
    clipper.SetClipData(True)
    clipper.Update()
    clipped = slicer.vtkOrientedImageData()
    clipped.ShallowCopy(clipper.GetOutput())
    clipped.CopyDirections(image)
    return clipped


# --------------------------------------------------------------------------- Islands
KEEP_LARGEST_ISLAND = "KEEP_LARGEST_ISLAND"
KEEP_SELECTED_ISLAND = "KEEP_SELECTED_ISLAND"
REMOVE_SMALL_ISLANDS = "REMOVE_SMALL_ISLANDS"
REMOVE_SELECTED_ISLAND = "REMOVE_SELECTED_ISLAND"
ADD_SELECTED_ISLAND = "ADD_SELECTED_ISLAND"
SPLIT_ISLANDS_TO_SEGMENTS = "SPLIT_ISLANDS_TO_SEGMENTS"


class IslandsEffect:
    """SegmentEditorIslandsEffect: operations on the connected regions (islands) of a segment.

    Keep largest island, remove small islands and split islands to segments are applied with the
    Apply button; keep, remove and add selected island act on the island clicked in a slice view.
    """

    def __init__(self, editor):
        self.editor = editor

    def operation(self):
        return parameter(self.editor.editorNode, "Islands", "Operation")

    def requiresSegmentSelection(self):
        return self.operation() in (KEEP_SELECTED_ISLAND, REMOVE_SELECTED_ISLAND, ADD_SELECTED_ISLAND)

    def selectedSegmentLabelmap(self):
        logic = self.editor.logic
        logic.UpdateSelectedSegmentLabelmap()
        return logic.GetSelectedSegmentLabelmap()

    def modifySegment(self, segmentID, labelmap, mode):
        import slicer

        modeValue = {"Add": slicer.vtkSlicerSegmentEditorLogic.ModificationModeAdd,
                     "Remove": slicer.vtkSlicerSegmentEditorLogic.ModificationModeRemove,
                     "Set": slicer.vtkSlicerSegmentEditorLogic.ModificationModeSet}[mode]
        self.editor.logic.ModifySegmentByLabelmap(self.editor.logic.GetSegmentationNode(), segmentID, labelmap,
                                                  modeValue, False, False)

    def apply(self):
        if not self.editor.canEdit():
            raise RuntimeError("Select a segment first")
        operation = self.operation()
        minimumSize = parameter(self.editor.editorNode, "Islands", "MinimumSize")
        if operation == KEEP_LARGEST_ISLAND:
            self.splitSegments(minimumSize=minimumSize, maxNumberOfSegments=1)
        elif operation == REMOVE_SMALL_ISLANDS:
            self.splitSegments(minimumSize=minimumSize, split=False)
        elif operation == SPLIT_ISLANDS_TO_SEGMENTS:
            self.splitSegments(minimumSize=minimumSize)
        else:
            raise RuntimeError("Click in a slice view to select an island.")

    def splitSegments(self, minimumSize=0, maxNumberOfSegments=0, split=True):
        """minimumSize: 0 keeps all islands, whatever their size; maxNumberOfSegments: 0 keeps all of them."""
        import slicer
        import vtk
        import vtkITK

        logic = self.editor.logic
        logic.SaveStateForUndo()
        selectedSegmentLabelmap = clippedToContent(self.selectedSegmentLabelmap(), [1, 1, 1])
        if selectedSegmentLabelmap is None:
            return   # an empty segment has no islands

        castIn = vtk.vtkImageCast()
        castIn.SetInputData(selectedSegmentLabelmap)
        castIn.SetOutputScalarTypeToUnsignedInt()
        islandMath = vtkITK.vtkITKIslandMath()
        islandMath.SetInputConnection(castIn.GetOutputPort())
        islandMath.SetFullyConnected(False)
        islandMath.SetMinimumSize(int(minimumSize))
        islandMath.Update()

        islandImage = slicer.vtkOrientedImageData()
        islandImage.ShallowCopy(islandMath.GetOutput())
        imageToWorld = vtk.vtkMatrix4x4()
        selectedSegmentLabelmap.GetImageToWorldMatrix(imageToWorld)
        islandImage.SetImageToWorldMatrix(imageToWorld)

        baseSegmentName = "Label"
        selectedSegmentID = logic.GetCurrentSegmentID()
        segmentationNode = logic.GetSegmentationNode()
        labelmapName = slicer.vtkSegmentationConverter.GetSegmentationBinaryLabelmapRepresentationName()
        wasModifying = segmentationNode.StartModify()
        try:
            segmentation = segmentationNode.GetSegmentation()
            selectedSegment = segmentation.GetSegment(selectedSegmentID)
            if selectedSegment.GetName():
                baseSegmentName = selectedSegment.GetName()
            labelValues = vtk.vtkIntArray()
            slicer.vtkSlicerSegmentationsModuleLogic.GetAllLabelValues(labelValues, islandImage)
            numberOfIslands = labelValues.GetNumberOfTuples()

            # The selected segment is replaced last ("Set"): when the editable area is that segment,
            # erasing it first would leave nowhere to write the islands back
            if split:
                for i in range(1, numberOfIslands):
                    if maxNumberOfSegments > 0 and i >= maxNumberOfSegments:
                        break
                    labelValue = int(labelValues.GetTuple1(i))
                    segment = slicer.vtkSegment()
                    segment.SetName(baseSegmentName + "_" + str(i + 1))
                    segment.AddRepresentation(labelmapName, selectedSegment.GetRepresentation(labelmapName))
                    segmentation.AddSegment(segment)
                    segmentID = segmentation.GetSegmentIdBySegment(segment)
                    segment.SetLabelValue(segmentation.GetUniqueLabelValueForSharedLabelmap(selectedSegmentID))
                    threshold = vtk.vtkImageThreshold()
                    threshold.SetInputData(islandMath.GetOutput())
                    threshold.ThresholdBetween(labelValue, labelValue)
                    threshold.SetInValue(1)
                    threshold.SetOutValue(0)
                    threshold.Update()
                    modifierImage = slicer.vtkOrientedImageData()
                    modifierImage.DeepCopy(threshold.GetOutput())
                    modifierImage.SetGeometryFromImageToWorldMatrix(imageToWorld)
                    # Into the layer of the selected segment, rather than a new layer for each island
                    self.modifySegment(segmentID, modifierImage, "Add")

            threshold = vtk.vtkImageThreshold()
            threshold.SetInputData(islandMath.GetOutput())
            if numberOfIslands > 0 and not split and maxNumberOfSegments <= 0:
                # All islands that are left stay in the selected segment
                threshold.ThresholdByLower(0)
                threshold.SetInValue(0)
                threshold.SetOutValue(1)
            elif numberOfIslands > 0:
                # The first (largest) island stays in the selected segment
                labelValue = int(labelValues.GetTuple1(0))
                threshold.ThresholdBetween(labelValue, labelValue)
                threshold.SetInValue(1)
                threshold.SetOutValue(0)
            else:
                # No islands are left (all smaller than the minimum size): the segment is cleared
                threshold.ThresholdByLower(0)
                threshold.SetInValue(0)
                threshold.SetOutValue(0)
            threshold.Update()
            modifierImage = slicer.vtkOrientedImageData()
            modifierImage.DeepCopy(threshold.GetOutput())
            modifierImage.SetGeometryFromImageToWorldMatrix(imageToWorld)
            self.modifySegment(selectedSegmentID, modifierImage, "Set")
        finally:
            segmentationNode.EndModify(wasModifying)

    def xyToIjk(self, xy, view, image, parentTransformNode):
        """The voxel of the image under a position of a slice view."""
        import slicer
        import vtk

        ras = [0.0, 0.0, 0.0, 1.0]
        view.GetSliceNode().GetXYToRAS().MultiplyPoint([float(xy[0]), float(xy[1]), 0.0, 1.0], ras)
        point = list(ras[:3])
        if parentTransformNode is not None:
            worldToSegmentation = vtk.vtkGeneralTransform()
            slicer.vtkMRMLTransformNode.GetTransformBetweenNodes(None, parentTransformNode, worldToSegmentation)
            point = list(worldToSegmentation.TransformPoint(point))
        worldToImage = vtk.vtkMatrix4x4()
        image.GetWorldToImageMatrix(worldToImage)
        ijk = [0.0, 0.0, 0.0, 1.0]
        worldToImage.MultiplyPoint(point + [1.0], ijk)
        return [int(round(c)) for c in ijk[:3]]

    def defaultModifierLabelmap(self):
        logic = self.editor.logic
        logic.UpdateReferenceGeometryImage()
        logic.ResetModifierLabelmapToDefault()
        return logic.GetModifierLabelmap()

    def processEvent(self, view, interactor, event):
        """A click on an island in a slice view, for the operations that act on the selected island."""
        import slicer
        import vtk

        if not self.requiresSegmentSelection() or not _isSliceView(view):
            return False
        if event != "LeftButtonPressEvent" or _anyModifierKey(interactor):
            return False
        if not self.editor.canEdit():
            return False
        logic = self.editor.logic
        segmentationNode = logic.GetSegmentationNode()
        visibleSegmentIds = vtk.vtkStringArray()
        segmentationNode.GetDisplayNode().GetVisibleSegmentIDs(visibleSegmentIds)
        if visibleSegmentIds.GetNumberOfValues() == 0:
            logger.info("Island operation skipped: there are no visible segments")
            return True
        logic.SaveStateForUndo()
        operation = self.operation()
        if operation == ADD_SELECTED_ISLAND:
            inputLabelImage = slicer.vtkOrientedImageData()
            if not segmentationNode.GenerateMergedLabelmapForAllSegments(
                    inputLabelImage, slicer.vtkSegmentation.EXTENT_UNION_OF_SEGMENTS_PADDED, None, visibleSegmentIds):
                logger.error("Failed to apply island operation: cannot get list of visible segments")
                return True
        else:
            selectedSegmentLabelmap = clippedToContent(self.selectedSegmentLabelmap(), [1, 1, 1])
            if selectedSegmentLabelmap is None:
                return True   # an empty segment has no islands to click on
            # The exact value of the segment's voxels: 1
            thresh = vtk.vtkImageThreshold()
            thresh.SetInputData(selectedSegmentLabelmap)
            thresh.ThresholdByLower(0)
            thresh.SetInValue(0)
            thresh.SetOutValue(1)
            thresh.SetOutputScalarType(selectedSegmentLabelmap.GetScalarType())
            thresh.Update()
            inputLabelImage = slicer.vtkOrientedImageData()
            inputLabelImage.ShallowCopy(thresh.GetOutput())
            imageToWorld = vtk.vtkMatrix4x4()
            selectedSegmentLabelmap.GetImageToWorldMatrix(imageToWorld)
            inputLabelImage.SetImageToWorldMatrix(imageToWorld)

        ijk = self.xyToIjk(interactor.GetEventPosition(), view, inputLabelImage, segmentationNode.GetParentTransformNode())
        extent = inputLabelImage.GetExtent()
        if any(ijk[a] < extent[2 * a] or ijk[a] > extent[2 * a + 1] for a in range(3)):
            return True   # outside of the segmentation
        pixelValue = inputLabelImage.GetScalarComponentAsFloat(ijk[0], ijk[1], ijk[2], 0)

        floodFillingFilter = vtk.vtkImageThresholdConnectivity()
        floodFillingFilter.SetInputData(inputLabelImage)
        seedPoints = vtk.vtkPoints()
        origin = inputLabelImage.GetOrigin()
        spacing = inputLabelImage.GetSpacing()
        seedPoints.InsertNextPoint(origin[0] + ijk[0] * spacing[0], origin[1] + ijk[1] * spacing[1], origin[2] + ijk[2] * spacing[2])
        floodFillingFilter.SetSeedPoints(seedPoints)
        floodFillingFilter.ThresholdBetween(pixelValue, pixelValue)
        floodFillingFilter.SetInValue(1)
        floodFillingFilter.SetOutValue(0)
        if operation == ADD_SELECTED_ISLAND:
            floodFillingFilter.Update()
            modifier = self.defaultModifierLabelmap()
            modifier.DeepCopy(floodFillingFilter.GetOutput())
            self.modifySegment(logic.GetCurrentSegmentID(), modifier, "Add")
        elif pixelValue != 0:   # clicked on an empty part: there is nothing to remove or keep
            floodFillingFilter.Update()
            modifier = self.defaultModifierLabelmap()
            modifier.DeepCopy(floodFillingFilter.GetOutput())
            self.modifySegment(logic.GetCurrentSegmentID(), modifier, "Set" if operation == KEEP_SELECTED_ISLAND else "Remove")
        return True


# --------------------------------------------------------------------------- Smoothing
MEDIAN = "MEDIAN"
GAUSSIAN = "GAUSSIAN"
MORPHOLOGICAL_OPENING = "MORPHOLOGICAL_OPENING"
MORPHOLOGICAL_CLOSING = "MORPHOLOGICAL_CLOSING"
JOINT_TAUBIN = "JOINT_TAUBIN"


class SmoothingEffect:
    """SegmentEditorSmoothingEffect: smooth the selected segment (median, opening, closing, Gaussian),
    each visible segment, or all visible segments together (joint smoothing).

    Applied to the whole segment with Apply, or where the smoothing brush is painted.
    """

    def __init__(self, editor):
        self.editor = editor

    def parameter(self, name):
        return parameter(self.editor.editorNode, "Smoothing", name)

    def referenceSpacing(self):
        """The spacing of the segmentation's labelmaps, without making any of them."""
        import slicer

        segmentationNode = self.editor.logic.GetSegmentationNode()
        if segmentationNode is None:
            return [1.0, 1.0, 1.0]
        geometry = segmentationNode.GetSegmentation().GetConversionParameter(
            slicer.vtkSegmentationConverter.GetReferenceImageGeometryParameterName())
        if not geometry:
            return [1.0, 1.0, 1.0]
        image = slicer.vtkOrientedImageData()
        slicer.vtkSegmentationConverter.DeserializeImageGeometry(geometry, image, False)
        return list(image.GetSpacing())

    def kernelSizePixel(self, spacing=None):
        # rounded to the nearest odd number: an even kernel size shifts the image
        spacing = spacing or self.referenceSpacing()
        kernelSizeMm = self.parameter("KernelSizeMm")
        return [int(round((kernelSizeMm / spacing[i] + 1) / 2) * 2 - 1) for i in range(3)]

    def state(self):
        return {"kernelSizePixel": self.kernelSizePixel()}

    def modifySegment(self, segmentID, labelmap, mode, extent=None, bypassMasking=False):
        import slicer

        modeValue = {"Add": slicer.vtkSlicerSegmentEditorLogic.ModificationModeAdd,
                     "Remove": slicer.vtkSlicerSegmentEditorLogic.ModificationModeRemove,
                     "Set": slicer.vtkSlicerSegmentEditorLogic.ModificationModeSet}[mode]
        logic = self.editor.logic
        if extent is not None:
            logic.ModifySegmentByLabelmap(logic.GetSegmentationNode(), segmentID, labelmap, modeValue, extent, False, bypassMasking)
        else:
            logic.ModifySegmentByLabelmap(logic.GetSegmentationNode(), segmentID, labelmap, modeValue, False, bypassMasking)

    def apply(self, maskImage=None, maskExtent=None):
        """maskImage: nonzero where smoothing is applied (the smoothing brush); the whole segment without it."""
        import vtk

        editor = self.editor
        logic = editor.logic
        method = self.parameter("SmoothingMethod")
        if method != JOINT_TAUBIN and not editor.canEdit():
            raise RuntimeError("Select a segment first")
        if logic.GetSegmentationNode() is None:
            raise RuntimeError("Select a segmentation first")
        logic.SaveStateForUndo()
        if method == JOINT_TAUBIN:
            self.smoothMultipleSegments()
        elif self.parameter("ApplyToAllVisibleSegments"):
            segmentationNode = logic.GetSegmentationNode()
            segmentIDs = vtk.vtkStringArray()
            segmentationNode.GetDisplayNode().GetVisibleSegmentIDs(segmentIDs)
            if segmentIDs.GetNumberOfValues() == 0:
                logger.info("Smoothing operation skipped: there are no visible segments.")
                return
            selected = logic.GetCurrentSegmentID()
            try:
                for index in range(segmentIDs.GetNumberOfValues()):
                    logic.SetCurrentSegmentID(segmentIDs.GetValue(index))
                    self.smoothSelectedSegment(self.copyOf(maskImage), maskExtent)
            finally:
                logic.SetCurrentSegmentID(selected)
        else:
            self.smoothSelectedSegment(maskImage, maskExtent)

    @staticmethod
    def copyOf(image):
        import slicer

        if image is None:
            return None
        copy = slicer.vtkOrientedImageData()
        copy.DeepCopy(image)
        return copy

    @staticmethod
    def clipImage(inputImage, maskExtent, margin):
        import slicer
        import vtk

        clipper = vtk.vtkImageClip()
        clipper.SetOutputWholeExtent(maskExtent[0] - margin[0], maskExtent[1] + margin[0],
                                     maskExtent[2] - margin[1], maskExtent[3] + margin[1],
                                     maskExtent[4] - margin[2], maskExtent[5] + margin[2])
        clipper.SetInputData(inputImage)
        clipper.SetClipData(True)
        clipper.Update()
        clippedImage = slicer.vtkOrientedImageData()
        clippedImage.ShallowCopy(clipper.GetOutput())
        clippedImage.CopyDirections(inputImage)
        return clippedImage

    def modifySelectedSegmentByLabelmap(self, smoothedImage, selectedSegmentLabelmap, modifierLabelmap, maskImage, maskExtent):
        import slicer

        segmentID = self.editor.logic.GetCurrentSegmentID()
        if maskImage is not None:
            smoothedClipped = slicer.vtkOrientedImageData()
            smoothedClipped.ShallowCopy(smoothedImage)
            smoothedClipped.CopyDirections(modifierLabelmap)
            # 1 outside the painted region, so that OPERATION_MINIMUM leaves the segment there as it is
            slicer.vtkOrientedImageDataResample.ApplyImageMask(smoothedClipped, maskImage, 1.0, False)
            # the segment outside the painted region, solid 1 inside it
            slicer.vtkOrientedImageDataResample.ModifyImage(maskImage, selectedSegmentLabelmap,
                                                            slicer.vtkOrientedImageDataResample.OPERATION_MAXIMUM)
            slicer.vtkOrientedImageDataResample.ModifyImage(maskImage, smoothedClipped,
                                                            slicer.vtkOrientedImageDataResample.OPERATION_MINIMUM)
            modifierExtent = modifierLabelmap.GetExtent()
            updateExtent = [min(maskExtent[a], modifierExtent[a]) if a % 2 == 0 else max(maskExtent[a], modifierExtent[a])
                            for a in range(6)]
            self.modifySegment(segmentID, maskImage, "Set", extent=updateExtent)
        else:
            # The smoothed region (the whole segment and the reach of the filter) replaces the segment
            smoothed = slicer.vtkOrientedImageData()
            smoothed.ShallowCopy(smoothedImage)
            smoothed.CopyDirections(selectedSegmentLabelmap)
            self.modifySegment(segmentID, smoothed, "Set", extent=list(smoothed.GetExtent()))

    def smoothSelectedSegment(self, maskImage=None, maskExtent=None):
        import vtk

        logic = self.editor.logic
        logic.UpdateReferenceGeometryImage()
        logic.ResetModifierLabelmapToDefault()
        modifierLabelmap = logic.GetModifierLabelmap()
        logic.UpdateSelectedSegmentLabelmap()
        selectedSegmentLabelmap = logic.GetSelectedSegmentLabelmap()
        method = self.parameter("SmoothingMethod")

        if method == GAUSSIAN:
            maxValue = 255
            radiusFactor = 4.0
            standardDeviationMm = self.parameter("GaussianStandardDeviationMm")
            spacing = modifierLabelmap.GetSpacing()
            standardDeviationPixel = [standardDeviationMm / spacing[i] for i in range(3)]
            radiusPixel = [int(standardDeviationPixel[i] * radiusFactor) + 1 for i in range(3)]
            clipped = self.clipImage(selectedSegmentLabelmap, maskExtent, radiusPixel) if maskExtent else clippedToContent(selectedSegmentLabelmap, radiusPixel)
            if clipped is None:
                return   # an empty segment stays empty
            thresh = vtk.vtkImageThreshold()
            thresh.SetInputData(clipped)
            thresh.ThresholdByLower(0)
            thresh.SetInValue(0)
            thresh.SetOutValue(maxValue)
            thresh.SetOutputScalarType(vtk.VTK_UNSIGNED_CHAR)
            gaussianFilter = vtk.vtkImageGaussianSmooth()
            gaussianFilter.SetInputConnection(thresh.GetOutputPort())
            gaussianFilter.SetStandardDeviation(*standardDeviationPixel)
            gaussianFilter.SetRadiusFactor(radiusFactor)
            thresh2 = vtk.vtkImageThreshold()
            thresh2.SetInputConnection(gaussianFilter.GetOutputPort())
            thresh2.ThresholdByUpper(int(maxValue / 2))
            thresh2.SetInValue(1)
            thresh2.SetOutValue(0)
            thresh2.SetOutputScalarType(selectedSegmentLabelmap.GetScalarType())
            thresh2.Update()
            self.modifySelectedSegmentByLabelmap(thresh2.GetOutput(), selectedSegmentLabelmap, modifierLabelmap, maskImage, maskExtent)
            return

        kernelSizePixel = self.kernelSizePixel(selectedSegmentLabelmap.GetSpacing())
        clipped = self.clipImage(selectedSegmentLabelmap, maskExtent, kernelSizePixel) if maskExtent else clippedToContent(selectedSegmentLabelmap, kernelSizePixel)
        if clipped is None:
            return   # an empty segment stays empty
        if method == MEDIAN:
            # The median filter does not need a particular label value
            smoothingFilter = vtk.vtkImageMedian3D()
            smoothingFilter.SetInputData(clipped)
        else:
            # The exact value of the segment's voxels: 1
            labelValue, backgroundValue = 1, 0
            thresh = vtk.vtkImageThreshold()
            thresh.SetInputData(clipped)
            thresh.ThresholdByLower(0)
            thresh.SetInValue(backgroundValue)
            thresh.SetOutValue(labelValue)
            thresh.SetOutputScalarType(clipped.GetScalarType())
            smoothingFilter = vtk.vtkImageOpenClose3D()
            smoothingFilter.SetInputConnection(thresh.GetOutputPort())
            if method == MORPHOLOGICAL_OPENING:
                smoothingFilter.SetOpenValue(labelValue)
                smoothingFilter.SetCloseValue(backgroundValue)
            else:
                smoothingFilter.SetOpenValue(backgroundValue)
                smoothingFilter.SetCloseValue(labelValue)
        smoothingFilter.SetKernelSize(*kernelSizePixel)
        smoothingFilter.Update()
        self.modifySelectedSegmentByLabelmap(smoothingFilter.GetOutput(), selectedSegmentLabelmap, modifierLabelmap, maskImage, maskExtent)

    def smoothMultipleSegments(self):
        import slicer
        import vtk

        logic = self.editor.logic
        segmentationNode = logic.GetSegmentationNode()
        visibleSegmentIds = vtk.vtkStringArray()
        segmentationNode.GetDisplayNode().GetVisibleSegmentIDs(visibleSegmentIds)
        if visibleSegmentIds.GetNumberOfValues() == 0:
            logger.info("Smoothing operation skipped: there are no visible segments")
            return
        mergedImage = slicer.vtkOrientedImageData()
        if not segmentationNode.GenerateMergedLabelmapForAllSegments(
                mergedImage, slicer.vtkSegmentation.EXTENT_UNION_OF_SEGMENTS_PADDED, None, visibleSegmentIds):
            raise RuntimeError("Failed to apply smoothing: cannot get list of visible segments")
        segmentLabelValues = [(visibleSegmentIds.GetValue(i), i + 1) for i in range(visibleSegmentIds.GetNumberOfValues())]

        # Smoothing in voxel space
        ici = vtk.vtkImageChangeInformation()
        ici.SetInputData(mergedImage)
        ici.SetOutputSpacing(1, 1, 1)
        ici.SetOutputOrigin(0, 0, 0)
        # vtkDiscreteFlyingEdges3D would disconnect the labeled regions from each other: for joint
        # smoothing the points of neighboring regions must move together
        convertToPolyData = vtk.vtkDiscreteMarchingCubes()
        convertToPolyData.SetInputConnection(ici.GetOutputPort())
        convertToPolyData.SetNumberOfContours(len(segmentLabelValues))
        for contourIndex, (_segmentId, labelValue) in enumerate(segmentLabelValues):
            convertToPolyData.SetValue(contourIndex, labelValue)

        # Low-pass filtering using Taubin's method
        smoothingFactor = self.parameter("JointTaubinSmoothingFactor")
        passBand = pow(10.0, -4.0 * smoothingFactor)   # 1-0.0001 from a user input of 0-1
        smoother = vtk.vtkWindowedSincPolyDataFilter()
        smoother.SetInputConnection(convertToPolyData.GetOutputPort())
        smoother.SetNumberOfIterations(100)   # more than the 10-20 that could be enough, to reduce shrinking
        smoother.BoundarySmoothingOff()
        smoother.FeatureEdgeSmoothingOff()
        smoother.SetFeatureAngle(90.0)
        smoother.SetPassBand(passBand)
        smoother.NonManifoldSmoothingOn()
        smoother.NormalizeCoordinatesOn()

        threshold = vtk.vtkThreshold()
        threshold.SetInputConnection(smoother.GetOutputPort())
        geometryFilter = vtk.vtkGeometryFilter()
        geometryFilter.SetInputConnection(threshold.GetOutputPort())
        polyDataToImageStencil = vtk.vtkPolyDataToImageStencil()
        polyDataToImageStencil.SetInputConnection(geometryFilter.GetOutputPort())
        polyDataToImageStencil.SetOutputSpacing(1, 1, 1)
        polyDataToImageStencil.SetOutputOrigin(0, 0, 0)
        polyDataToImageStencil.SetOutputWholeExtent(mergedImage.GetExtent())
        stencil = vtk.vtkImageStencil()
        emptyBinaryLabelMap = vtk.vtkImageData()
        emptyBinaryLabelMap.SetExtent(mergedImage.GetExtent())
        emptyBinaryLabelMap.AllocateScalars(vtk.VTK_UNSIGNED_CHAR, 1)
        slicer.vtkOrientedImageDataResample.FillImage(emptyBinaryLabelMap, 0)
        stencil.SetInputData(emptyBinaryLabelMap)
        stencil.SetStencilConnection(polyDataToImageStencil.GetOutputPort())
        stencil.ReverseStencilOn()
        stencil.SetBackgroundValue(1)
        imageToWorldMatrix = vtk.vtkMatrix4x4()
        mergedImage.GetImageToWorldMatrix(imageToWorldMatrix)

        # The visible segments overwrite each other while they are written back, as on the desktop
        editorNode = self.editor.editorNode
        oldOverwriteMode = editorNode.GetOverwriteMode()
        editorNode.SetOverwriteMode(slicer.vtkMRMLSegmentEditorNode.OverwriteVisibleSegments)
        try:
            for segmentId, labelValue in segmentLabelValues:
                threshold.SetLowerThreshold(labelValue)
                threshold.SetUpperThreshold(labelValue)
                threshold.SetThresholdFunction(vtk.vtkThreshold.THRESHOLD_BETWEEN)
                stencil.Update()
                smoothed = slicer.vtkOrientedImageData()
                smoothed.ShallowCopy(stencil.GetOutput())
                smoothed.SetImageToWorldMatrix(imageToWorldMatrix)
                self.modifySegment(segmentId, smoothed, "Set")
        finally:
            editorNode.SetOverwriteMode(oldOverwriteMode)


# --------------------------------------------------------------------------- Margin
class MarginEffect:
    """SegmentEditorMarginEffect: grow or shrink the selected segment, or each visible segment, by a margin."""

    def __init__(self, editor):
        self.editor = editor

    def marginSizeMm(self):
        return parameter(self.editor.editorNode, "Margin", "MarginSizeMm")

    def spacing(self):
        return SmoothingEffect(self.editor).referenceSpacing()

    def marginSizePixel(self, spacing=None):
        spacing = spacing or self.spacing()
        marginSizeMm = abs(self.marginSizeMm())
        return [int(math.floor(marginSizeMm / s)) for s in spacing]

    def state(self):
        """What the desktop shows under the margin size: the margin the voxels allow."""
        spacing = self.spacing()
        pixels = self.marginSizePixel(spacing)
        if min(pixels) < 1:
            return {"feasible": False, "actual": "Not feasible at current resolution."}
        actualMm = [abs(pixels[i] * spacing[i]) for i in range(3)]
        for i in range(3):
            if actualMm[i] > 0:
                actualMm[i] = round(actualMm[i], max(int(-math.floor(math.log10(actualMm[i]))), 1))
        return {"feasible": True, "actual": "Actual: {} x {} x {} mm ({}x{}x{} pixel)".format(*actualMm, *pixels)}

    def apply(self):
        import vtk

        editor = self.editor
        logic = editor.logic
        if not editor.canEdit():
            raise RuntimeError("Select a segment first")
        if not self.state()["feasible"]:
            raise RuntimeError("Not feasible at current resolution.")
        logic.SaveStateForUndo()
        if parameter(editor.editorNode, "Margin", "ApplyToAllVisibleSegments"):
            segmentIDs = vtk.vtkStringArray()
            logic.GetSegmentationNode().GetDisplayNode().GetVisibleSegmentIDs(segmentIDs)
            if segmentIDs.GetNumberOfValues() == 0:
                logger.info("Margin operation skipped: there are no visible segments.")
                return
            selected = logic.GetCurrentSegmentID()
            try:
                for index in range(segmentIDs.GetNumberOfValues()):
                    logic.SetCurrentSegmentID(segmentIDs.GetValue(index))
                    self.processMargin()
            finally:
                logic.SetCurrentSegmentID(selected)
        else:
            self.processMargin()

    def processMargin(self):
        import slicer
        import vtk
        import vtkITK

        logic = self.editor.logic
        logic.UpdateSelectedSegmentLabelmap()
        marginSizeMm = self.marginSizeMm()
        # Only the region of the segment and as far as the margin reaches: the rest stays empty
        reach = [p + 1 for p in self.marginSizePixel(logic.GetSelectedSegmentLabelmap().GetSpacing())]
        selectedSegmentLabelmap = clippedToContent(logic.GetSelectedSegmentLabelmap(), reach if marginSizeMm > 0 else [1, 1, 1])
        if selectedSegmentLabelmap is None:
            return   # an empty segment stays empty

        # The exact value of the segment's voxels: 1
        labelValue, backgroundValue = 1, 0
        thresh = vtk.vtkImageThreshold()
        thresh.SetInputData(selectedSegmentLabelmap)
        thresh.ThresholdByLower(0)
        thresh.SetInValue(backgroundValue)
        thresh.SetOutValue(labelValue)
        thresh.SetOutputScalarType(selectedSegmentLabelmap.GetScalarType())
        if marginSizeMm < 0:
            # The distance starts at zero at the border voxels: shrinking is more accurate as growing
            # the inverted labelmap
            thresh.SetInValue(labelValue)
            thresh.SetOutValue(backgroundValue)
        margin = vtkITK.vtkITKImageMargin()
        margin.SetInputConnection(thresh.GetOutputPort())
        margin.CalculateMarginInMMOn()
        margin.SetOuterMarginMM(abs(marginSizeMm))
        margin.Update()
        result = margin.GetOutput()
        if marginSizeMm < 0:
            # Shrinking: the result is inverted back
            invert = vtk.vtkImageThreshold()
            invert.SetInputData(margin.GetOutput())
            invert.ThresholdByLower(0)
            invert.SetInValue(labelValue)
            invert.SetOutValue(backgroundValue)
            invert.SetOutputScalarType(selectedSegmentLabelmap.GetScalarType())
            invert.Update()
            result = invert.GetOutput()
        modifier = slicer.vtkOrientedImageData()
        modifier.ShallowCopy(result)
        modifier.CopyDirections(selectedSegmentLabelmap)
        imageToWorld = vtk.vtkMatrix4x4()
        selectedSegmentLabelmap.GetImageToWorldMatrix(imageToWorld)
        modifier.SetImageToWorldMatrix(imageToWorld)
        logic.ModifySegmentByLabelmap(logic.GetSegmentationNode(), logic.GetCurrentSegmentID(), modifier,
                                      slicer.vtkSlicerSegmentEditorLogic.ModificationModeSet, list(modifier.GetExtent()), False, False)


# --------------------------------------------------------------------------- Threshold preview
class ThresholdPreview:
    """What the threshold would fill, shown while the Threshold effect is active.

    As desktop Slicer's Threshold effect: in the color of the selected segment, pulsing between
    half and full opacity in the slice views every 200 ms. The desktop draws it in slice views
    only; here it is a hidden segmentation, so it is also shown in 3D views - as binary labelmap,
    computed on the GPU - when the segmentation being edited is shown in 3D.
    """

    PulseIntervalMs = 200
    PulseSteps = 5

    def __init__(self, editor):
        self.editor = editor
        self.node = None
        self.segmentID = None
        self.range = None
        self._pulse = None   # (handle, proxy) of the interval
        self._pulseState = 0
        self._pulseStep = 1

    def update(self, lower, upper):
        import slicer
        import vtk

        editor = self.editor
        logic = editor.logic
        segmentationNode = logic.GetSegmentationNode()
        if segmentationNode is None or not logic.GetCurrentSegmentID():
            self.stop()
            return
        logic.UpdateAlignedSourceVolume()
        source = logic.GetAlignedSourceVolume()
        if source is None:
            self.stop()
            return
        self.range = (float(lower), float(upper))
        node = self.ensureNode(segmentationNode)

        threshold = vtk.vtkImageThreshold()
        threshold.SetInputData(source)
        threshold.ThresholdBetween(*self.range)
        threshold.SetInValue(1)
        threshold.SetOutValue(0)
        threshold.SetOutputScalarType(vtk.VTK_UNSIGNED_CHAR)
        threshold.Update()
        labelmap = slicer.vtkOrientedImageData()
        labelmap.ShallowCopy(threshold.GetOutput())
        imageToWorld = vtk.vtkMatrix4x4()
        source.GetImageToWorldMatrix(imageToWorld)
        labelmap.SetImageToWorldMatrix(imageToWorld)
        slicer.vtkSlicerSegmentationsModuleLogic.SetBinaryLabelmapToSegment(
            labelmap, node, self.segmentID, slicer.vtkSlicerSegmentationsModuleLogic.MODE_REPLACE)
        self.updateDisplay()
        self.startPulse()

    def ensureNode(self, segmentationNode):
        import slicer

        if self.node is not None and self.node.GetScene() is None:
            self.node = None
        if self.node is None:
            node = slicer.vtkMRMLSegmentationNode()
            node.SetName(slicer.mrmlScene.GetUniqueNameByString("Threshold preview"))
            node.SetHideFromEditors(True)   # not in the Data tree, nor in node selectors
            node.SetSaveWithScene(False)
            slicer.mrmlScene.AddNode(node)
            node.CreateDefaultDisplayNodes()
            display = node.GetDisplayNode()
            display.SetVisibility2DOutline(False)
            display.SetPreferredDisplayRepresentationName3D(slicer.vtkSegmentationConverter.GetSegmentationBinaryLabelmapRepresentationName())
            self.segmentID = node.GetSegmentation().AddEmptySegment("threshold", "Threshold preview")
            self.node = node
        if segmentationNode.GetParentTransformNode() is not None:
            self.node.SetAndObserveTransformNodeID(segmentationNode.GetParentTransformNode().GetID())
        else:
            self.node.SetAndObserveTransformNodeID(None)
        return self.node

    def updateDisplay(self):
        """The color of the selected segment, and shown in 3D when the segmentation is."""
        if self.node is None:
            return
        logic = self.editor.logic
        segmentationNode = logic.GetSegmentationNode()
        segment = segmentationNode.GetSegmentation().GetSegment(logic.GetCurrentSegmentID() or "") if segmentationNode else None
        if segment is not None:
            self.node.GetSegmentation().GetSegment(self.segmentID).SetColor(segment.GetColor())
        display = self.node.GetDisplayNode()
        display.SetVisibility3D(bool(self.editor._shownIn3D(segmentationNode)) if segmentationNode else False)

    def startPulse(self):
        from .qtcompat import dom

        if self._pulse is not None:
            return
        self._pulse = dom.set_interval(self.pulse, self.PulseIntervalMs)

    def pulse(self):
        if self.node is None or self.node.GetDisplayNode() is None:
            return
        opacity = 0.5 + self._pulseState / (2.0 * self.PulseSteps)
        self.node.GetDisplayNode().SetOpacity2DFill(opacity)
        self._pulseState += self._pulseStep
        if self._pulseState >= self.PulseSteps:
            self._pulseStep = -1
        if self._pulseState <= 0:
            self._pulseStep = 1

    def stop(self):
        import slicer
        from .qtcompat import dom

        if self._pulse is not None:
            handle, proxy = self._pulse
            dom.clear_interval(handle)
            if proxy is not None and hasattr(proxy, "destroy"):
                proxy.destroy()
            self._pulse = None
        if self.node is not None:
            if self.node.GetScene() is not None:
                slicer.mrmlScene.RemoveNode(self.node)
            self.node = None
        self.range = None

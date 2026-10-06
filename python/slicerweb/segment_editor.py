"""Segment Editor for the browser, built on Slicer's Qt-free vtkSlicerSegmentEditorLogic.

The desktop Segment Editor (qMRMLSegmentEditorWidget) uses vtkSlicerSegmentEditorLogic for segment
management, masking, undo/redo and modifying segments with labelmaps; its effects are Qt classes.
This module provides the same workflow with effects implemented in Python:

- Paint / Erase: brush strokes in slice views (disc in the slice plane, or sphere)
- Draw, Scissors: outlines drawn in the views (segment_editor_effects)
- Threshold: fill the selected segment with voxels of the source volume within a range
- Grow from seeds, Fill between slices: a preview of the result, kept up to date while the inputs
  are edited, that replaces the segments when applied (segment_editor_effects)
- Margin, Hollow, Islands, Smoothing (median filter), Logical operations
- Mask volume: fill a volume inside or outside a segment (segment_editor_effects)

All edits go through ``ModifySegmentByLabelmap`` so masking settings (editable area, overwrite) and
undo/redo behave as in desktop Slicer.
"""

import logging
import math

from . import host
from . import segment_editor_effects as effects
from .bridge import _node, method

logger = logging.getLogger("slicerweb.segmenteditor")

_editor = None


def slicer_binary_labelmap_name():
    """The name segmentations keep their voxels under."""
    import slicer

    return slicer.vtkSegmentationConverter.GetSegmentationBinaryLabelmapRepresentationName()


def slicer_volume_image_data_modified():
    """vtkMRMLVolumeNode::ImageDataModifiedEvent - the voxels changed, not just the node."""
    import slicer

    return slicer.vtkMRMLVolumeNode.ImageDataModifiedEvent


def editor():
    global _editor
    if _editor is None:
        _editor = SegmentEditor()
    return _editor


class SegmentEditor:
    def __init__(self):
        import slicer

        self.scene = slicer.mrmlScene
        self.logic = slicer.vtkSlicerSegmentEditorLogic()
        self.logic.SetMRMLApplicationLogic(slicer.app.applicationLogic())
        self.logic.SetMRMLScene(self.scene)
        node = self.scene.GetSingletonNode("SegmentEditor", "vtkMRMLSegmentEditorNode")
        if node is None:
            node = slicer.vtkMRMLSegmentEditorNode()
            node.SetSingletonTag("SegmentEditor")
            node = self.scene.AddNode(node)
        self.editorNode = node
        self.logic.SetSegmentEditorNode(node)
        self.effect = None
        self.lastEffect = None  # the effect before the current one: Space switches back to it
        # Another mouse mode was chosen: the effect stays, but the views are not given to it
        # until its mouse mode is chosen again
        self.suspended = False
        self.brushRadius = 5.0  # mm
        self.sphereBrush = False
        self._observers = []  # (interactor, tag)
        self._painting = None  # (view, mode)
        self._strokePoints = []
        self._feedbackActors = []
        self._hoverBrushes = {}  # 3D view -> the brush shown where painting would start
        self._sourceVolume = None
        self._sourceVolumeObservers = []
        # A scene loaded with a preview of Grow from seeds or Fill between slices in it: its inputs
        # are followed (auto-update) without the effect being chosen first; a scene closed: not
        self._sceneObservers = [
            self.scene.AddObserver(slicer.vtkMRMLScene.EndImportEvent, lambda caller, event: self._onSceneLoaded()),
            self.scene.AddObserver(slicer.vtkMRMLScene.StartCloseEvent, lambda caller, event: self.autoComplete.forget()),
        ]
        self.draw = effects.DrawEffect(self)
        self.scissors = effects.ScissorsEffect(self)
        self.maskVolume = effects.MaskVolumeEffect(self)
        self.islands = effects.IslandsEffect(self)
        self.smoothing = effects.SmoothingEffect(self)
        self.marginEffect = effects.MarginEffect(self)
        self.thresholdPreview = effects.ThresholdPreview(self)
        self.autoComplete = effects.AutoCompletePreview(self)

    # ------------------------------------------------------------------ setup
    def setup(self, segmentationNodeID, sourceVolumeNodeID):
        if segmentationNodeID:
            self.logic.SetSegmentationNodeID(segmentationNodeID)
        if sourceVolumeNodeID:
            self.logic.SetSourceVolumeNodeID(sourceVolumeNodeID)
        elif self.logic.GetSourceVolumeNode() is None:
            # Nothing can be painted without a volume to paint on - it says where the voxels are
            # and how big they are - so the editor starts on the volume the slice views show, which
            # is what the Segment Editor module does on the desktop.
            volume = self._volumeOfTheSliceViews()
            if volume is not None:
                self.logic.SetSourceVolumeNodeID(volume.GetID())
        self._observeSourceVolume()
        segmentationNode = self.logic.GetSegmentationNode()
        if segmentationNode is not None and self.logic.GetSourceVolumeNode() is not None:
            segmentationNode.SetReferenceImageGeometryParameterFromVolumeNode(self.logic.GetSourceVolumeNode())
        if segmentationNode is not None and not segmentationNode.GetDisplayNode():
            segmentationNode.CreateDefaultDisplayNodes()
        return self.state()

    def _volumeOfTheSliceViews(self):
        """The volume the slice views have in the background, or any volume in the scene."""
        import slicer

        appLogic = slicer.app.applicationLogic()
        selection = appLogic.GetSelectionNode() if appLogic else None
        volumeID = selection.GetActiveVolumeID() if selection is not None else None
        volume = self.scene.GetNodeByID(volumeID) if volumeID else None
        if volume is not None:
            return volume
        volumes = self.scene.GetNodesByClass("vtkMRMLScalarVolumeNode")
        try:
            for i in range(volumes.GetNumberOfItems()):
                candidate = volumes.GetItemAsObject(i)
                if not candidate.IsA("vtkMRMLLabelMapVolumeNode"):
                    return candidate
        finally:
            volumes.UnRegister(None)
        return None

    def _observeSourceVolume(self):
        """Watch the volume being segmented, so that what is shown of it stays true.

        The threshold effect offers the values of this volume and nothing else, so when the volume
        changes - another one is chosen, or the one in hand is written to by a module - the page is
        told, and asks for the state again with the new range in it.
        """
        import vtk

        volume = self.logic.GetSourceVolumeNode()
        if volume is self._sourceVolume:
            return
        for node, tag in self._sourceVolumeObservers:
            node.RemoveObserver(tag)
        self._sourceVolumeObservers = []
        self._sourceVolume = volume
        if volume is None:
            return
        for event in (vtk.vtkCommand.ModifiedEvent, slicer_volume_image_data_modified()):
            self._sourceVolumeObservers.append((volume, volume.AddObserver(event, self._onSourceVolumeModified)))

    def _onSourceVolumeModified(self, caller, event):
        host.emit("segment-editor-changed", self.state())

    def _onSceneLoaded(self):
        try:
            self.autoComplete.restore()
        except Exception:
            logger.exception("Could not follow the preview of the loaded scene")

    def ensureSegmentation(self):
        """Give the editor something to edit: the segmentation in hand, one from the scene, or a new one.

        The Segment Editor of the desktop starts on whichever segmentation is there, and offers to
        make one when there is none; here the making is done straight away, so that the effects can
        be used as soon as the module is open.
        """
        import slicer

        if self.logic.GetSegmentationNode() is None:
            existing = self.scene.GetFirstNodeByClass("vtkMRMLSegmentationNode")
            node = existing if existing is not None else self.scene.AddNewNodeByClass(
                "vtkMRMLSegmentationNode", self.scene.GetUniqueNameByString("Segmentation"))
            self.setup(node.GetID(), None)
        return self.state()

    def state(self):
        import slicer

        self._observeSourceVolume()   # in case the volume was changed by something other than setup
        self.autoComplete.restore()   # a preview the scene has, that nothing follows yet
        seg = self.logic.GetSegmentationNode()
        segments = []
        if seg is not None:
            segmentation = seg.GetSegmentation()
            for i in range(segmentation.GetNumberOfSegments()):
                sid = segmentation.GetNthSegmentID(i)
                s = segmentation.GetSegment(sid)
                segments.append({"id": sid, "name": s.GetName(),
                                 "color": "#%02x%02x%02x" % tuple(int(c * 255 + 0.5) for c in s.GetColor())})
        source = self.logic.GetSourceVolumeNode()
        scalarRange = [0.0, 1.0]
        if source is not None and source.GetImageData() is not None:
            scalarRange = list(source.GetImageData().GetScalarRange())
        return {
            "segmentationNodeID": seg.GetID() if seg else None,
            "sourceVolumeNodeID": source.GetID() if source else None,
            "segments": segments,
            "currentSegmentID": self.logic.GetCurrentSegmentID() or None,
            "effect": self.effect,
            # used with the mouse in the views (a mouse mode), and whether another mouse mode has them now
            "takesMouse": self.takesMouse(),
            "suspended": self.suspended,
            "brushRadius": self.brushRadius,
            "sphereBrush": self.sphereBrush,
            "canUndo": bool(self.logic.CanUndo()),
            "canRedo": bool(self.logic.CanRedo()),
            "scalarRange": scalarRange,
            "show3D": self._shownIn3D(seg),
            "maskMode": self.editorNode.GetMaskMode(),
            "overwriteMode": self.editorNode.GetOverwriteMode(),
            # What the effects are set to, kept in the segment editor node as on the desktop
            "effectParameters": {effect: effects.parameters(self.editorNode, effect)
                                 for effect in effects.PARAMETER_DEFAULTS},
            # The result of Grow from seeds or Fill between slices, shown before it is applied
            "preview": self.autoComplete.state() if seg is not None else None,
            "maskVolume": self.maskVolume.state(),
            "smoothing": self.smoothing.state() if self.effect == "Smoothing" else None,
            "margin": self.marginEffect.state() if self.effect == "Margin" else None,
        }

    # ------------------------------------------------------------------ segments
    def addSegment(self):
        sid = self.logic.AddEmptySegment()
        self.logic.SetCurrentSegmentID(sid)
        host.emit("segment-editor-changed", self.state())
        return sid

    def removeSegment(self):
        removed = self.logic.RemoveSelectedSegment()
        host.emit("segment-editor-changed", self.state())
        return removed

    def selectSegment(self, segmentID):
        self.logic.SetCurrentSegmentID(segmentID or "")
        self.thresholdPreview.updateDisplay()
        host.emit("segment-editor-changed", self.state())

    # ------------------------------------------------------------------ effects
    # Effects that are used by clicking and dragging in the views
    InteractiveEffects = ("Paint", "Erase", "Draw", "Scissors", "Islands", "Smoothing")
    # Effects that paint with the brush (the smoothing brush smooths where it is painted)
    BrushEffects = ("Paint", "Erase", "Smoothing")

    def setEffect(self, name):
        self._removeObservers()
        if self.effect == "MaskVolume" and name != "MaskVolume":
            self.maskVolume.deactivate()
        if name != "Threshold":
            self.thresholdPreview.stop()
        if (name or None) != self.effect:
            self.lastEffect = self.effect
        self.effect = name or None
        self.suspended = False
        if self.effect in self.InteractiveEffects:
            self._installObservers()
        self._publishBrush()
        host.emit("segment-editor-changed", self.state())

    def takesMouse(self):
        """Whether the effect is used with the mouse (or a finger) in the views: it is a mouse mode then."""
        if self.effect == "Islands":
            return self.islands.requiresSegmentSelection()
        return self.effect in ("Paint", "Erase", "Draw", "Scissors", "Smoothing")

    def setSuspended(self, suspended):
        """Give the views to another mouse mode (scroll slices, say) and back, the effect staying active."""
        suspended = bool(suspended) and self.effect is not None
        if suspended == self.suspended:
            return
        self.suspended = suspended
        self._removeObservers()
        if not suspended and self.effect in self.InteractiveEffects:
            self._installObservers()
        self._publishBrush()
        host.emit("segment-editor-changed", self.state())

    def scaleBrush(self, factor):
        """Make the brush bigger or smaller, within what is usable in a slice view."""
        self.brushRadius = max(0.1, min(100.0, self.brushRadius * float(factor)))
        self._publishBrush()
        host.emit("segment-editor-changed", self.state())
        return self.brushRadius

    def _publishBrush(self):
        """Put the brush on the segment editor node, which is where the views read it from.

        The brush circle is drawn by a displayable manager of the slice views
        (vtkSlicerWebSegmentEditorDisplayableManager), so what it needs - the effect at work and how
        wide its brush is - is kept on the node rather than in this object. The attribute is the one
        desktop Slicer uses for the same setting.
        """
        # (no brush is shown in the views while another mouse mode has them)
        shown = "" if self.suspended else (self.effect or "")
        self.editorNode.SetActiveEffectName(self.effect or "")
        self.editorNode.SetAttribute("SegmentEditorEffect.ActiveEffect", shown)
        for effect in self.BrushEffects:
            self.editorNode.SetAttribute("SegmentEditorEffect.%s.BrushAbsoluteDiameter" % effect,
                                         str(2.0 * self.brushRadius))

    def _installObservers(self):
        import slicer

        lm = slicer.app.layoutManager()
        for name, view in lm.views().items():
            # Scissors cut from the viewpoint of 3D views as well, and Paint and Erase work on the
            # surfaces shown in 3D views when "Edit in 3D views" is on
            if not (view.IsA("vtkSlicerWebSliceView") or (view.IsA("vtkSlicerWebThreeDView") and self._editsIn3DViews())):
                continue
            interactor = view.GetInteractor()
            tags = {}
            handler = self._makeHandler(view, tags)
            for event in ("LeftButtonPressEvent", "MouseMoveEvent", "LeftButtonReleaseEvent",
                          "MouseWheelForwardEvent", "MouseWheelBackwardEvent", "RightButtonPressEvent",
                          "RightButtonReleaseEvent", "LeftButtonDoubleClickEvent", "KeyPressEvent", "LeaveEvent"):
                # Higher priority than Slicer's interactor style, so that painting takes precedence
                tags[event] = interactor.AddObserver(event, handler, 1.0)
                self._observers.append((interactor, tags[event]))

    def _removeObservers(self):
        for interactor, tag in self._observers:
            interactor.RemoveObserver(tag)
        self._observers = []
        self._hideStrokeFeedback()
        self._hideHoverBrushes()
        self._painting = None
        self.draw.deactivate()
        self.scissors.deactivate()

    def editingInView(self, layoutName):
        """Whether an effect is drawing in the view now: a brush stroke, a Draw outline, a Scissors drag
        (the touch magnifier is shown then, as for placing control points)."""
        import slicer

        view = slicer.app.layoutManager().views().get(layoutName)
        if view is None:
            return False
        if self._painting is not None and self._painting[0] is view:
            return True
        pipeline = self.draw.pipelines.get(view)
        if pipeline is not None and pipeline.actionState == "drawing":
            return True
        pipeline = self.scissors.pipelines.get(view)
        return bool(pipeline is not None and pipeline.isDragging)

    def _editsIn3DViews(self):
        if self.effect == "Scissors":
            return True
        return self.effect in self.BrushEffects and bool(effects.parameter(self.editorNode, self.effect, "EditIn3DViews"))

    def refreshViewObservers(self):
        """Call when views are created or destroyed (layout change)."""
        if self.effect in self.InteractiveEffects and not self.suspended:
            self._removeObservers()
            self._installObservers()

    def _makeHandler(self, view, tags):
        def abort(interactor, event):
            # Stop processing of this event by the interactor style and displayable managers
            command = interactor.GetCommand(tags[event])
            if command is not None:
                command.SetAbortFlag(1)

        def handler(caller, event):
            if self.effect in ("Draw", "Scissors", "Islands"):
                effect = {"Draw": self.draw, "Scissors": self.scissors, "Islands": self.islands}[self.effect]
                try:
                    taken = effect.processEvent(view, caller, event)
                except Exception:
                    logger.exception("%s failed", self.effect)
                    taken = False
                if taken:
                    abort(caller, event)
                    if event in ("LeftButtonPressEvent", "LeftButtonReleaseEvent", "RightButtonReleaseEvent", "LeftButtonDoubleClickEvent", "KeyPressEvent"):
                        host.emit("segment-editor-changed", self.state())
                return
            threeD = view.IsA("vtkSlicerWebThreeDView")
            if event == "LeaveEvent":
                self._hideHoverBrushes()
                return
            if event not in ("LeftButtonPressEvent", "MouseMoveEvent", "LeftButtonReleaseEvent",
                             "MouseWheelForwardEvent", "MouseWheelBackwardEvent"):
                return
            if threeD and event in ("LeftButtonPressEvent", "MouseMoveEvent") and self._painting is None:
                # The brush is shown where the mouse is over a surface
                self._showHoverBrush(view, self._pick3D(view, caller.GetEventPosition()))
            if event == "LeftButtonPressEvent":
                if self.logic.GetSegmentationNode() is None or not self.logic.GetCurrentSegmentID():
                    return
                anyModifier = caller.GetShiftKey() or caller.GetControlKey() or caller.GetAltKey()
                if threeD and (anyModifier or self._pick3D(view, caller.GetEventPosition()) is None):
                    # Not on a surface: the view rotates, as on the desktop
                    return
                self._beginStroke(view)
                self._paintAt(view, caller.GetEventPosition())
                abort(caller, event)
            elif event == "MouseMoveEvent" and self._painting is not None and self._painting[0] is view:
                self._paintAt(view, caller.GetEventPosition())
                abort(caller, event)
            elif event == "LeftButtonReleaseEvent" and self._painting is not None:
                self._endStroke(caller.GetEventPosition())
                # A finger lifted off a touch screen is not hovering anywhere (and no leave event
                # comes): the brush of the 3D views is hidden until the pointer moves over a surface
                self._hideHoverBrushes()
                abort(caller, event)
            elif event in ("MouseWheelForwardEvent", "MouseWheelBackwardEvent") and caller.GetShiftKey():
                # Shift and the wheel make the brush bigger or smaller, by the fifth that Slicer's
                # paint effect uses, and the slice does not move while it happens.
                self.scaleBrush(1.2 if event == "MouseWheelForwardEvent" else 0.8)
                abort(caller, event)

        return handler

    # As in desktop Slicer's Paint effect (with its default "delayed paint"), a stroke is shown as a
    # series of brushes while the mouse moves and the segment is painted once, when the button is
    # released: quick feedback however large the segmentation is, and one update of the segment.
    MaximumPointDistanceInStroke = 0.2  # brushes of the preview are at most this many diameters apart

    def _beginStroke(self, view):
        self.logic.SaveStateForUndo()
        self.logic.UpdateMaskLabelmap()
        self.logic.UpdateReferenceGeometryImage()
        self.logic.ResetModifierLabelmapToDefault()
        self._painting = (view, {"Erase": "Remove", "Smoothing": "Smooth"}.get(self.effect, "Add"))
        self._strokePoints = []  # brush centers (RAS) where the mouse was
        self._showStrokeFeedback(view)

    def _pick3D(self, view, xy):
        """The point of the surface under the mouse that is nearest the camera, or None.

        As desktop Slicer's Paint effect: vtkMRMLAccuratePicker also picks segmentations shown as
        binary labelmap (surfaces with no polygons) and volume rendering.
        """
        import slicer

        renderer = view.GetRenderer()
        if renderer is None:
            return None
        picker = slicer.vtkMRMLAccuratePicker()
        picker.SetTolerance(0.005)
        if not picker.Pick(float(xy[0]), float(xy[1]), 0, renderer):
            return None
        positions = picker.GetPickedPositions()
        if positions is None or positions.GetNumberOfPoints() < 1:
            return None
        camera = renderer.GetActiveCamera().GetPosition()
        return min((positions.GetPoint(i) for i in range(positions.GetNumberOfPoints())),
                   key=lambda p: math.dist(p, camera))

    def _showHoverBrush(self, view, center):
        """The sphere brush at the surface point the mouse is over in a 3D view (hidden when there is none)."""
        import vtk

        entry = self._hoverBrushes.get(view)
        if entry is None:
            if center is None:
                return
            sphere = vtk.vtkSphereSource()
            sphere.SetPhiResolution(16)
            sphere.SetThetaResolution(32)
            mapper = vtk.vtkPolyDataMapper()
            mapper.SetInputConnection(sphere.GetOutputPort())
            actor = vtk.vtkActor()
            actor.SetMapper(mapper)
            actor.PickableOff()   # otherwise the brush itself would be picked
            actor.GetProperty().SetColor(1.0, 1.0, 0.0)
            actor.GetProperty().SetOpacity(0.5)
            view.GetRenderer().AddViewProp(actor)
            entry = self._hoverBrushes[view] = (sphere, actor)
        sphere, actor = entry
        if center is not None:
            sphere.SetRadius(self.brushRadius)
            sphere.SetCenter(center)
        if actor.GetVisibility() != (center is not None) or center is not None:
            actor.SetVisibility(center is not None)
            view.ScheduleRender()

    def _hideHoverBrushes(self):
        for view, (_sphere, actor) in self._hoverBrushes.items():
            if view.GetRenderer() is not None:
                view.GetRenderer().RemoveViewProp(actor)
            view.ScheduleRender()
        self._hoverBrushes = {}

    def _paintAt(self, view, xy):
        """Add a point to the stroke and show the brushes up to it."""
        if view.IsA("vtkSlicerWebThreeDView"):
            # On the surface under the mouse; where there is none, nothing is added
            center = self._pick3D(view, xy)
            if center is None:
                return
            center = list(center)
            self._showHoverBrush(view, center)
        else:
            ras = [0.0, 0.0, 0.0, 0.0]
            view.GetSliceNode().GetXYToRAS().MultiplyPoint([float(xy[0]), float(xy[1]), 0.0, 1.0], ras)
            center = ras[:3]
        if self._strokePoints:
            # Brushes between mouse positions that are far apart, so that the preview has no gaps
            last = self._strokePoints[-1]
            spacing = self.MaximumPointDistanceInStroke * 2.0 * self.brushRadius
            count = int(math.dist(last, center) / spacing) - 1 if spacing > 0 else 0
            for index in range(count):
                weight = (index + 1) / (count + 1)
                self._feedbackPoints.InsertNextPoint([last[a] + weight * (center[a] - last[a]) for a in range(3)])
        self._feedbackPoints.InsertNextPoint(center)
        self._feedbackPoints.Modified()
        self._strokePoints.append(center)
        for feedbackView, _actor in self._feedbackActors:
            feedbackView.ScheduleRender()

    def _showStrokeFeedback(self, paintView):
        """Brushes of the stroke, cut by the plane of each slice view and drawn in all 3D views."""
        import slicer
        import vtk

        # A sphere in 3D views, as on the desktop: there is no slice plane there
        sphere = self.sphereBrush or paintView.IsA("vtkSlicerWebThreeDView")
        if sphere:
            brush = vtk.vtkSphereSource()
            brush.SetRadius(self.brushRadius)
            brush.SetPhiResolution(16)
            brush.SetThetaResolution(32)
        else:
            # A disk in the slice plane: a cylinder as thick as what is painted (a voxel)
            modifier = self.logic.GetModifierLabelmap()
            brush = vtk.vtkCylinderSource()
            brush.SetRadius(self.brushRadius)
            brush.SetHeight(min(modifier.GetSpacing()) if modifier is not None else 1.0)
            brush.SetResolution(32)
        brushToWorld = vtk.vtkTransform()
        if not sphere:
            sliceToRas = paintView.GetSliceNode().GetSliceToRAS()
            orientation = vtk.vtkMatrix4x4()
            for r in range(3):
                for c in range(3):
                    orientation.SetElement(r, c, sliceToRas.GetElement(r, c))
            brushToWorld.Concatenate(orientation)
            brushToWorld.RotateX(90)  # the cylinder's axis (y) along the slice normal
        orientedBrush = vtk.vtkTransformPolyDataFilter()
        orientedBrush.SetTransform(brushToWorld)
        orientedBrush.SetInputConnection(brush.GetOutputPort())
        # Normals that point outwards (as the desktop's brush has), for lighting in 3D views
        brushNormals = vtk.vtkPolyDataNormals()
        brushNormals.SetInputConnection(orientedBrush.GetOutputPort())
        brushNormals.AutoOrientNormalsOn()
        self._feedbackPoints = vtk.vtkPoints()
        points = vtk.vtkPolyData()
        points.SetPoints(self._feedbackPoints)
        glyphs = vtk.vtkGlyph3D()
        glyphs.SetInputData(points)
        glyphs.SetSourceConnection(brushNormals.GetOutputPort())
        glyphs.ScalingOff()
        glyphs.OrientOff()
        self._feedbackActors = []
        for view in slicer.app.layoutManager().views().values():
            renderer = view.GetRenderer()
            if renderer is None:
                continue
            if view.IsA("vtkSlicerWebSliceView"):
                sliceNode = view.GetSliceNode()
                planeToRas = sliceNode.GetSliceToRAS()
                plane = vtk.vtkPlane()
                plane.SetOrigin([planeToRas.GetElement(r, 3) for r in range(3)])
                plane.SetNormal([planeToRas.GetElement(r, 2) for r in range(3)])
                cutter = vtk.vtkCutter()
                cutter.SetCutFunction(plane)
                cutter.SetGenerateCutScalars(0)
                cutter.SetInputConnection(glyphs.GetOutputPort())
                rasToXy = vtk.vtkTransform()
                rasToXy.SetMatrix(sliceNode.GetXYToRAS())
                rasToXy.Inverse()
                toXy = vtk.vtkTransformPolyDataFilter()
                toXy.SetTransform(rasToXy)
                toXy.SetInputConnection(cutter.GetOutputPort())
                mapper = vtk.vtkPolyDataMapper2D()
                mapper.SetInputConnection(toXy.GetOutputPort())
                actor = vtk.vtkActor2D()
                actor.GetProperty().SetOpacity(0.5)
            elif view.IsA("vtkSlicerWebThreeDView"):
                mapper = vtk.vtkPolyDataMapper()
                mapper.SetInputConnection(glyphs.GetOutputPort())
                mapper.ScalarVisibilityOff()
                actor = vtk.vtkActor()
                actor.PickableOff()
            else:
                continue
            actor.SetMapper(mapper)
            actor.GetProperty().SetColor(0.7, 0.7, 0.0)
            renderer.AddViewProp(actor)
            self._feedbackActors.append((view, actor))

    def _hideStrokeFeedback(self):
        for view, actor in self._feedbackActors:
            view.GetRenderer().RemoveViewProp(actor)
            view.ScheduleRender()
        self._feedbackActors = []

    def _paintStroke(self):
        """Paint the brush along the stroke into the modifier labelmap: around each mouse position
        and along the lines between them. Returns the extent that was painted, or None."""
        import numpy as np
        import vtk
        from vtk.util import numpy_support

        modifier = self.logic.GetModifierLabelmap()
        if modifier is None or not self._strokePoints:
            return None
        worldToImage = vtk.vtkMatrix4x4()
        modifier.GetWorldToImageMatrix(worldToImage)
        imageToWorld = vtk.vtkMatrix4x4()
        modifier.GetImageToWorldMatrix(imageToWorld)
        worldToImageArray = np.array([[worldToImage.GetElement(r, c) for c in range(4)] for r in range(3)])
        imageToWorldArray = np.array([[imageToWorld.GetElement(r, c) for c in range(4)] for r in range(3)])
        centers = [worldToImageArray @ np.array(list(point) + [1.0]) for point in self._strokePoints]
        spacing = np.array(modifier.GetSpacing())
        radiusVoxels = self.brushRadius / spacing
        extent = modifier.GetExtent()
        dims = modifier.GetDimensions()
        scalars = modifier.GetPointData().GetScalars()
        voxels = numpy_support.vtk_to_numpy(scalars).reshape(dims[2], dims[1], dims[0])
        # A sphere in 3D views, as on the desktop; a disc in the slice plane in slice views
        sphere = self.sphereBrush or self._painting[0].IsA("vtkSlicerWebThreeDView")
        if not sphere:
            sliceToRas = self._painting[0].GetSliceNode().GetSliceToRAS()
            normal = np.array([sliceToRas.GetElement(r, 2) for r in range(3)])
            normal /= np.linalg.norm(normal) or 1.0
            planePoint = np.array(self._strokePoints[0])
        painted = None
        for start, end in list(zip(centers, centers[1:])) or [(centers[0], centers[0])]:
            lo = [max(extent[2 * a], int(math.floor(min(start[a], end[a]) - radiusVoxels[a]))) for a in range(3)]
            hi = [min(extent[2 * a + 1], int(math.ceil(max(start[a], end[a]) + radiusVoxels[a]))) for a in range(3)]
            if any(lo[a] > hi[a] for a in range(3)):
                continue
            k, j, i = np.meshgrid(np.arange(lo[2], hi[2] + 1), np.arange(lo[1], hi[1] + 1), np.arange(lo[0], hi[0] + 1), indexing="ij")
            ijk = np.stack([i, j, k], axis=-1).astype(float)
            # Within a brush radius of the line between the two mouse positions
            direction = (end - start) / radiusVoxels
            offsets = (ijk - start) / radiusVoxels
            length2 = float(direction @ direction)
            t = np.clip((offsets @ direction) / length2, 0.0, 1.0)[..., None] if length2 > 0 else 0.0
            mask = ((offsets - t * direction) ** 2).sum(axis=-1) <= 1.0
            if not sphere:
                # In the slice only: less than half a voxel from the slice plane
                world = np.concatenate([ijk, np.ones(ijk.shape[:-1] + (1,))], axis=-1) @ imageToWorldArray.T
                mask &= np.abs((world - planePoint) @ normal) <= 0.5 * spacing.min() + 1e-6
            voxels[lo[2]:hi[2] + 1, lo[1]:hi[1] + 1, lo[0]:hi[0] + 1][mask] = 1
            box = [lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]]
            painted = box if painted is None else [min(painted[a], box[a]) if a % 2 == 0 else max(painted[a], box[a]) for a in range(6)]
        scalars.Modified()
        modifier.Modified()
        return painted

    def _apply(self, extent=None, mode=None):
        import slicer

        mode = mode or self._painting[1]
        modeValue = {"Add": slicer.vtkSlicerSegmentEditorLogic.ModificationModeAdd,
                     "Remove": slicer.vtkSlicerSegmentEditorLogic.ModificationModeRemove,
                     "Set": slicer.vtkSlicerSegmentEditorLogic.ModificationModeSet}[mode]
        segmentationNode = self.logic.GetSegmentationNode()
        segmentID = self.logic.GetCurrentSegmentID()
        modifier = self.logic.GetModifierLabelmap()
        if extent is not None:
            self.logic.ModifySegmentByLabelmap(segmentationNode, segmentID, modifier, modeValue, extent, False, False)
        else:
            self.logic.ModifySegmentByLabelmap(segmentationNode, segmentID, modifier, modeValue, False, False)

    def _endStroke(self, xy):
        self._paintAt(self._painting[0], xy)
        if not self._strokePoints:
            # A stroke in a 3D view that never was on a surface
            self._hideStrokeFeedback()
            self._painting = None
            return
        self._hideStrokeFeedback()
        painted = self._paintStroke()
        if painted is not None and self._painting[1] == "Smooth":
            # The smoothing brush: what was painted is where the segment is smoothed
            import slicer

            if effects.parameter(self.editorNode, "Smoothing", "SmoothingMethod") == effects.JOINT_TAUBIN:
                logger.error("Smoothing brush is not available for 'joint smoothing' method.")
            else:
                mask = slicer.vtkOrientedImageData()
                mask.DeepCopy(self.logic.GetModifierLabelmap())
                self.smoothing.apply(mask, painted)
        elif painted is not None:
            self._apply(painted)
        self._painting = None
        self._strokePoints = []
        host.emit("segment-editor-changed", self.state())

    # --- what the effects of segment_editor_effects edit with
    def canEdit(self):
        """There is a segment to edit."""
        return self.logic.GetSegmentationNode() is not None and bool(self.logic.GetCurrentSegmentID())

    def prepareModifierForEdit(self):
        """An empty modifier labelmap of the segmentation's geometry, and the state saved for undo."""
        if not self.canEdit():
            return False
        self.logic.SaveStateForUndo()
        self.logic.UpdateMaskLabelmap()
        self.logic.UpdateReferenceGeometryImage()
        self.logic.ResetModifierLabelmapToDefault()
        return self.logic.GetModifierLabelmap() is not None

    def modifySegments(self, modifier, mode, segmentIDs=None, extent=None):
        """Modify the current segment, or the given ones, with the modifier labelmap (masking applies)."""
        import slicer

        modeValue = {"Add": slicer.vtkSlicerSegmentEditorLogic.ModificationModeAdd,
                     "Remove": slicer.vtkSlicerSegmentEditorLogic.ModificationModeRemove,
                     "Set": slicer.vtkSlicerSegmentEditorLogic.ModificationModeSet}[mode]
        segmentationNode = self.logic.GetSegmentationNode()
        for segmentID in segmentIDs if segmentIDs is not None else [self.logic.GetCurrentSegmentID()]:
            if extent is not None:
                self.logic.ModifySegmentByLabelmap(segmentationNode, segmentID, modifier, modeValue, extent, False, False)
            else:
                self.logic.ModifySegmentByLabelmap(segmentationNode, segmentID, modifier, modeValue, False, False)

    # ------------------------------------------------------------------ whole-volume effects
    def _prepareModifier(self):
        if self.logic.GetSegmentationNode() is None or not self.logic.GetCurrentSegmentID():
            raise RuntimeError("Select a segmentation and a segment first")
        self.logic.SaveStateForUndo()
        self.logic.UpdateMaskLabelmap()
        self.logic.UpdateReferenceGeometryImage()
        self.logic.UpdateAlignedSourceVolume()
        self.logic.ResetModifierLabelmapToDefault()
        return self.logic.GetModifierLabelmap()

    def threshold(self, lower, upper):
        import vtk

        modifier = self._prepareModifier()
        source = self.logic.GetAlignedSourceVolume()
        if source is None:
            raise RuntimeError("Select a source volume first")
        f = vtk.vtkImageThreshold()
        f.SetInputData(source)
        f.ThresholdBetween(float(lower), float(upper))
        f.SetInValue(1)
        f.SetOutValue(0)
        f.SetOutputScalarType(modifier.GetScalarType())
        f.Update()
        modifier.DeepCopy(f.GetOutput())
        self._copyGeometry(source, modifier)
        self._apply(mode="Set")

    # --- effects that work out what to fill in from what is already there

    @staticmethod
    def _shownIn3D(segmentationNode):
        """Whether the "Show 3D" button is pressed."""
        from .panels import shownIn3D

        return shownIn3D(segmentationNode)

    def previewAutoComplete(self, effect):
        """Initialize or update the preview of Grow from seeds or Fill between slices."""
        if effect not in effects.AUTO_COMPLETE_EFFECTS:
            raise ValueError(f"{effect} has no preview")
        self.autoComplete.onPreview(effect)
        host.emit("segment-editor-changed", self.state())

    def growFromSeeds(self, seedLocality=None):
        """Grow the segments until they meet, and apply the result (Initialize and Apply at once)."""
        if seedLocality is not None:
            effects.setParameter(self.editorNode, "GrowFromSeeds", "SeedLocalityFactor", float(seedLocality))
        self.autoComplete.onPreview("GrowFromSeeds")
        self.autoComplete.apply()
        host.emit("segment-editor-changed", self.state())

    def fillBetweenSlices(self):
        """Fill in the slices between the segmented ones, and apply the result (Initialize and Apply at once)."""
        self.autoComplete.onPreview("FillBetweenSlices")
        self.autoComplete.apply()
        host.emit("segment-editor-changed", self.state())

    # --- effects that change the shape of the segment in hand

    def hollow(self, thicknessMm=3.0, shellMode="inside"):
        """Keep a shell of the given thickness where the segment's surface is, and empty the rest.

        *shellMode* says what the surface the segment has now becomes: the shell's "inside" surface
        (the shell is added around it), its "outside" surface (the shell is taken from within it),
        or the middle of the shell ("medial"). The margins are Slicer's, to the voxel.
        """
        import vtk
        import vtkITK

        modifier = self._prepareModifier()
        self.logic.UpdateSelectedSegmentLabelmap()
        selected = self.logic.GetSelectedSegmentLabelmap()
        thicknessMm = abs(float(thicknessMm))
        voxelDiameter = min(selected.GetSpacing())

        wanted = vtk.vtkImageThreshold()
        wanted.SetInputData(selected)
        wanted.ThresholdByLower(0)
        wanted.SetInValue(0)
        wanted.SetOutValue(1)
        wanted.SetOutputScalarType(selected.GetScalarType())

        shell = vtkITK.vtkITKImageMargin()
        shell.SetInputConnection(wanted.GetOutputPort())
        shell.CalculateMarginInMMOn()
        if shellMode == "medial":
            shell.SetOuterMarginMM(0.5 * thicknessMm)
            shell.SetInnerMarginMM(-0.5 * thicknessMm + 0.5 * voxelDiameter)
        elif shellMode == "outside":
            shell.SetOuterMarginMM(0.0)
            shell.SetInnerMarginMM(-thicknessMm + voxelDiameter)
        else:  # the surface it has now becomes the inside of the shell
            shell.SetOuterMarginMM(thicknessMm + 0.1 * voxelDiameter)
            shell.SetInnerMarginMM(0.0 + 0.1 * voxelDiameter)
        shell.Update()
        modifier.DeepCopy(shell.GetOutput())
        self._copyGeometry(selected, modifier)
        self._apply(mode="Set")

    # --- one segment against another

    def logicalOperation(self, operation, modifierSegmentID=None):
        """Copy, add, subtract or intersect another segment with this one, or invert or fill it
        (SegmentEditorLogicalEffect.onApply).

        With "Bypass masking", which is on by default as on the desktop, only the selected segment
        is modified: the masking settings (editable area, overwriting other segments) are ignored.
        """
        import slicer

        needsOther = operation in ("copy", "add", "subtract", "intersect")
        segmentationNode = self.logic.GetSegmentationNode()
        if segmentationNode is None or not self.logic.GetCurrentSegmentID():
            raise RuntimeError("Select a segmentation and a segment first")
        if needsOther and not modifierSegmentID:
            raise RuntimeError("Choose the other segment to %s" % operation)
        bypassMasking = bool(effects.parameter(self.editorNode, "Logic", "BypassMasking"))
        self.logic.SaveStateForUndo()
        self.logic.UpdateMaskLabelmap()
        self.logic.UpdateReferenceGeometryImage()
        self.logic.UpdateSelectedSegmentLabelmap()
        selected = self.logic.GetSelectedSegmentLabelmap()

        if operation in ("clear", "fill"):
            slicer.vtkOrientedImageDataResample.FillImage(
                selected, 1 if operation == "fill" else 0, selected.GetExtent())
            self._modifySelected(selected, "Set", bypassMasking=bypassMasking)
            return
        if operation == "invert":
            self._modifySelected(self._inverted(selected), "Set", bypassMasking=bypassMasking)
            return

        other = slicer.vtkOrientedImageData()
        segmentationNode.GetBinaryLabelmapRepresentation(modifierSegmentID, other)
        # The modifier segment in the common geometry of the segments (it may have just been copied
        # from another segmentation, of another geometry)
        commonGeometry = segmentationNode.GetSegmentation().DetermineCommonLabelmapGeometry(
            slicer.vtkSegmentation.EXTENT_UNION_OF_SEGMENTS, None)
        if not commonGeometry:
            logger.info("Logical operation skipped: all segments are empty")
            return
        commonGeometryImage = slicer.vtkOrientedImageData()
        slicer.vtkSegmentationConverter.DeserializeImageGeometry(commonGeometry, commonGeometryImage, False)
        if not slicer.vtkOrientedImageDataResample.DoGeometriesMatch(commonGeometryImage, other):
            resampled = slicer.vtkOrientedImageData()
            slicer.vtkOrientedImageDataResample.ResampleOrientedImageToReferenceOrientedImage(
                other, commonGeometryImage, resampled, False, True)
            other = resampled
        if operation == "copy":
            self._modifySelected(other, "Set", bypassMasking=bypassMasking)
        elif operation == "add":
            self._modifySelected(other, "Add", bypassMasking=bypassMasking)
        elif operation == "subtract":
            self._modifySelected(other, "Remove", bypassMasking=bypassMasking)
        else:  # what the two of them have in common
            intersection = slicer.vtkOrientedImageData()
            slicer.vtkOrientedImageDataResample.MergeImage(
                selected, other, intersection,
                slicer.vtkOrientedImageDataResample.OPERATION_MINIMUM, selected.GetExtent())
            a, b = selected.GetExtent(), other.GetExtent()
            commonExtent = [max(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]),
                            min(a[3], b[3]), max(a[4], b[4]), min(a[5], b[5])]
            self._modifySelected(intersection, "Set", extent=commonExtent, bypassMasking=bypassMasking)

    @staticmethod
    def _inverted(labelmap):
        """A labelmap with what it holds turned around: what was in it is out, and what was out is in."""
        import slicer
        import vtk

        threshold = vtk.vtkImageThreshold()
        threshold.SetInputData(labelmap)
        threshold.ThresholdByLower(0)
        threshold.SetInValue(1)
        threshold.SetOutValue(0)
        threshold.SetOutputScalarType(labelmap.GetScalarType())
        threshold.Update()
        inverted = slicer.vtkOrientedImageData()
        inverted.DeepCopy(threshold.GetOutput())
        matrix = vtk.vtkMatrix4x4()
        labelmap.GetImageToWorldMatrix(matrix)
        inverted.SetImageToWorldMatrix(matrix)
        return inverted

    def _modifySelected(self, labelmap, mode, extent=None, bypassMasking=False):
        import slicer

        modeValue = {"Add": slicer.vtkSlicerSegmentEditorLogic.ModificationModeAdd,
                     "Remove": slicer.vtkSlicerSegmentEditorLogic.ModificationModeRemove,
                     "Set": slicer.vtkSlicerSegmentEditorLogic.ModificationModeSet}[mode]
        if extent is not None:
            self.logic.ModifySegmentByLabelmap(
                self.logic.GetSegmentationNode(), self.logic.GetCurrentSegmentID(), labelmap,
                modeValue, extent, False, bool(bypassMasking))
        else:
            self.logic.ModifySegmentByLabelmap(
                self.logic.GetSegmentationNode(), self.logic.GetCurrentSegmentID(), labelmap,
                modeValue, False, bool(bypassMasking))
        host.emit("segment-editor-changed", self.state())

    @staticmethod
    def _copyGeometry(source, target):
        import vtk

        m = vtk.vtkMatrix4x4()
        source.GetImageToWorldMatrix(m)
        target.SetImageToWorldMatrix(m)

    def undo(self):
        self.logic.Undo()

    def redo(self):
        self.logic.Redo()


def _onViewsChanged(payload):
    if _editor is not None:
        _editor.refreshViewObservers()


host.on("view-attached", _onViewsChanged)
host.on("view-detached", _onViewsChanged)


# --------------------------------------------------------------------------- bridge methods
@method()
def segmentEditorSetup(segmentationNodeID=None, sourceVolumeNodeID=None):
    return editor().setup(segmentationNodeID, sourceVolumeNodeID)


@method()
def segmentEditorState():
    return editor().state()


@method()
def segmentEditorAddSegment():
    return editor().addSegment()


@method()
def segmentEditorRemoveSegment():
    return editor().removeSegment()


@method()
def segmentEditorSelectSegment(segmentID):
    editor().selectSegment(segmentID)
    return True


@method()
def segmentEditorSetEffect(name):
    editor().setEffect(name)
    return True


@method()
def segmentEditorSetBrush(radius=None, sphere=None):
    e = editor()
    if radius is not None:
        e.brushRadius = float(radius)
    if sphere is not None:
        e.sphereBrush = bool(sphere)
    e._publishBrush()
    return True


@method()
def segmentEditorEnsureSegmentation():
    """The module was opened: make sure there is something to edit."""
    return editor().ensureSegmentation()


@method()
def segmentEditorScaleBrush(factor):
    return editor().scaleBrush(factor)


@method()
def segmentEditorShow3D(enabled):
    """Show the segments in the 3D views, as the "Show 3D" button of the Segment Editor does.

    A segmentation is shown in 3D by giving it a closed surface, which is built from the labelmaps
    and kept up to date while they are edited (or, if binary labelmap is chosen for 3D, by showing it).
    """
    from .panels import showSurfaces

    e = editor()
    segmentationNode = e.logic.GetSegmentationNode()
    if segmentationNode is None:
        return False
    showSurfaces(segmentationNode, bool(enabled))
    e.thresholdPreview.updateDisplay()
    host.emit("segment-editor-changed", e.state())
    return True


@method()
def segmentEditorApply(effect, parameters=None):
    e = editor()
    parameters = parameters or {}
    if effect == "Threshold":
        e.threshold(parameters["lower"], parameters["upper"])
    elif effect == "Islands":
        e.islands.apply()
    elif effect == "Smoothing":
        if "kernelSizeMm" in parameters:
            effects.setParameter(e.editorNode, "Smoothing", "KernelSizeMm", float(parameters["kernelSizeMm"]))
        e.smoothing.apply()
    elif effect == "GrowFromSeeds":
        e.growFromSeeds(parameters.get("seedLocality"))
    elif effect == "FillBetweenSlices":
        e.fillBetweenSlices()
    elif effect == "Margin":
        if "marginMm" in parameters:
            effects.setParameter(e.editorNode, "Margin", "MarginSizeMm", float(parameters["marginMm"]))
        e.marginEffect.apply()
    elif effect == "Hollow":
        e.hollow(float(parameters.get("thicknessMm", 3.0)), str(parameters.get("shellMode", "inside")))
    elif effect == "Logic":
        e.logicalOperation(str(parameters.get("operation", "copy")), parameters.get("modifierSegmentID") or None)
    elif effect == "MaskVolume":
        e.maskVolume.apply()
    else:
        raise ValueError(f"Unknown effect {effect}")
    return e.state()


@method()
def segmentEditorUndo():
    editor().undo()
    return editor().state()


@method()
def segmentEditorRedo():
    editor().redo()
    return editor().state()


@method()
def segmentEditorSetMasking(maskMode=None, overwriteMode=None):
    node = editor().editorNode
    if maskMode is not None:
        node.SetMaskMode(int(maskMode))
    if overwriteMode is not None:
        node.SetOverwriteMode(int(overwriteMode))
    return True


@method()
def segmentEditorSetEffectParameter(effect, name, value):
    """Set a parameter of an effect (as on the desktop, stored in the segment editor node)."""
    e = editor()
    effects.setParameter(e.editorNode, effect, name, value)
    if name == "EditIn3DViews" and effect == e.effect:
        e.refreshViewObservers()
    if effect == e.autoComplete.owner():
        if name == "AutoUpdate":
            e.autoComplete.updateObservation()
        elif name == "SeedLocalityFactor":
            # The preview is computed again with it, a moment after the last change
            e.autoComplete.scheduleUpdate()
    host.emit("segment-editor-changed", e.state())
    return True


@method()
def segmentEditorSetEffectNodeReference(effect, role, nodeID=None):
    """Choose a node an effect works with (the input and output volume of Mask volume)."""
    e = editor()
    effects.setNodeReference(e.editorNode, effect, role, nodeID)
    host.emit("segment-editor-changed", e.state())
    return True


@method()
def segmentEditorShowVolume(nodeID):
    """Show a volume in the slice views (the eye buttons of Mask volume)."""
    effects.setSliceViewerBackground(_node(nodeID) if nodeID else editor().logic.GetSourceVolumeNode())
    host.emit("segment-editor-changed", editor().state())
    return True


@method()
def segmentEditorPreview(effect):
    """Initialize, or update, the preview of Grow from seeds or Fill between slices."""
    e = editor()
    e.previewAutoComplete(effect)
    return e.state()


@method()
def segmentEditorCancelPreview():
    e = editor()
    e.autoComplete.cancel()
    host.emit("segment-editor-changed", e.state())
    return e.state()


@method()
def segmentEditorApplyPreview():
    """Replace the segments by the previewed result."""
    e = editor()
    e.autoComplete.apply()
    host.emit("segment-editor-changed", e.state())
    return e.state()


@method()
def segmentEditorSetPreviewDisplay(opacity=None, show3D=None):
    """How the preview is shown: its opacity against the inputs', and whether it is shown in 3D."""
    e = editor()
    if opacity is not None:
        e.autoComplete.setPreviewOpacity(float(opacity))
    if show3D is not None:
        e.autoComplete.setPreviewShow3D(bool(show3D))
    host.emit("segment-editor-changed", e.state())
    return True


@method()
def segmentEditorSelectLastEffect():
    """Switch to the effect that was active before the current one (Space, as on the desktop)."""
    e = editor()
    e.setEffect(e.lastEffect)
    return e.state()


@method()
def segmentEditorThresholdPreview(lower, upper):
    """Show what the Threshold effect would fill with this range (while the effect is active)."""
    e = editor()
    if e.effect != "Threshold":
        return False
    e.thresholdPreview.update(float(lower), float(upper))
    return True


@method()
def segmentEditorSuspend(suspended=True):
    """Another mouse mode was chosen (or the effect's own again): the effect stays active meanwhile."""
    e = editor()
    e.setSuspended(suspended)
    return e.state()

"""Segment Editor for the browser, built on Slicer's Qt-free vtkSlicerSegmentEditorLogic.

The desktop Segment Editor (qMRMLSegmentEditorWidget) uses vtkSlicerSegmentEditorLogic for segment
management, masking, undo/redo and modifying segments with labelmaps; its effects are Qt classes.
This module provides the same workflow with effects implemented in Python:

- Paint / Erase: brush strokes in slice views (disc in the slice plane, or sphere)
- Threshold: fill the selected segment with voxels of the source volume within a range
- Islands: keep the largest connected region
- Smoothing: median filter
- Logical operations: clear, fill

All edits go through ``ModifySegmentByLabelmap`` so masking settings (editable area, overwrite) and
undo/redo behave as in desktop Slicer.
"""

import logging
import math

from . import host
from .bridge import _node, method

logger = logging.getLogger("slicerweb.segmenteditor")

_editor = None


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
        self.brushRadius = 5.0  # mm
        self.sphereBrush = False
        self._observers = []  # (interactor, tag)
        self._painting = None  # (view, mode)
        self._strokeExtent = None

    # ------------------------------------------------------------------ setup
    def setup(self, segmentationNodeID, sourceVolumeNodeID):
        if segmentationNodeID:
            self.logic.SetSegmentationNodeID(segmentationNodeID)
        if sourceVolumeNodeID:
            self.logic.SetSourceVolumeNodeID(sourceVolumeNodeID)
        segmentationNode = self.logic.GetSegmentationNode()
        if segmentationNode is not None and self.logic.GetSourceVolumeNode() is not None:
            segmentationNode.SetReferenceImageGeometryParameterFromVolumeNode(self.logic.GetSourceVolumeNode())
        if segmentationNode is not None and not segmentationNode.GetDisplayNode():
            segmentationNode.CreateDefaultDisplayNodes()
        return self.state()

    def state(self):
        import slicer

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
            "brushRadius": self.brushRadius,
            "sphereBrush": self.sphereBrush,
            "canUndo": bool(self.logic.CanUndo()),
            "canRedo": bool(self.logic.CanRedo()),
            "scalarRange": scalarRange,
            "show3D": bool(seg is not None and seg.GetSegmentation().ContainsRepresentation(
                slicer.vtkSegmentationConverter.GetSegmentationClosedSurfaceRepresentationName())),
            "maskMode": self.editorNode.GetMaskMode(),
            "overwriteMode": self.editorNode.GetOverwriteMode(),
        }

    # ------------------------------------------------------------------ segments
    def addSegment(self):
        sid = self.logic.AddEmptySegment()
        self.logic.SetCurrentSegmentID(sid)
        return sid

    def removeSegment(self):
        return self.logic.RemoveSelectedSegment()

    def selectSegment(self, segmentID):
        self.logic.SetCurrentSegmentID(segmentID or "")

    # ------------------------------------------------------------------ effects
    def setEffect(self, name):
        self._removeObservers()
        self.effect = name or None
        if self.effect in ("Paint", "Erase"):
            self._installObservers()
        self._publishBrush()
        host.emit("segment-editor-changed", self.state())

    def _publishBrush(self):
        """Put the brush on the segment editor node, which is where the views read it from.

        The brush circle is drawn by a displayable manager of the slice views
        (vtkSlicerWebSegmentEditorDisplayableManager), so what it needs - the effect at work and how
        wide its brush is - is kept on the node rather than in this object. The attribute is the one
        desktop Slicer uses for the same setting.
        """
        self.editorNode.SetActiveEffectName(self.effect or "")
        self.editorNode.SetAttribute("SegmentEditorEffect.ActiveEffect", self.effect or "")
        for effect in ("Paint", "Erase"):
            self.editorNode.SetAttribute("SegmentEditorEffect.%s.BrushAbsoluteDiameter" % effect,
                                         str(2.0 * self.brushRadius))

    def _installObservers(self):
        import slicer

        lm = slicer.app.layoutManager()
        for name, view in lm.views().items():
            if not view.IsA("vtkSlicerWebSliceView"):
                continue
            interactor = view.GetInteractor()
            tags = {}
            handler = self._makeHandler(view, tags)
            for event in ("LeftButtonPressEvent", "MouseMoveEvent", "LeftButtonReleaseEvent"):
                # Higher priority than Slicer's interactor style, so that painting takes precedence
                tags[event] = interactor.AddObserver(event, handler, 1.0)
                self._observers.append((interactor, tags[event]))

    def _removeObservers(self):
        for interactor, tag in self._observers:
            interactor.RemoveObserver(tag)
        self._observers = []
        self._painting = None

    def refreshViewObservers(self):
        """Call when views are created or destroyed (layout change)."""
        if self.effect in ("Paint", "Erase"):
            self._removeObservers()
            self._installObservers()

    def _makeHandler(self, view, tags):
        def abort(interactor, event):
            # Stop processing of this event by the interactor style and displayable managers
            command = interactor.GetCommand(tags[event])
            if command is not None:
                command.SetAbortFlag(1)

        def handler(caller, event):
            if event == "LeftButtonPressEvent":
                if self.logic.GetSegmentationNode() is None or not self.logic.GetCurrentSegmentID():
                    return
                self._beginStroke(view)
                self._paintAt(view, caller.GetEventPosition())
                abort(caller, event)
            elif event == "MouseMoveEvent" and self._painting is not None and self._painting[0] is view:
                self._paintAt(view, caller.GetEventPosition())
                abort(caller, event)
            elif event == "LeftButtonReleaseEvent" and self._painting is not None:
                self._endStroke()
                abort(caller, event)

        return handler

    def _beginStroke(self, view):
        self.logic.SaveStateForUndo()
        self.logic.UpdateMaskLabelmap()
        self.logic.UpdateReferenceGeometryImage()
        self.logic.ResetModifierLabelmapToDefault()
        self._painting = (view, "Remove" if self.effect == "Erase" else "Add")
        self._strokeExtent = None

    def _paintAt(self, view, xy):
        import numpy as np
        import vtk
        from vtk.util import numpy_support

        modifier = self.logic.GetModifierLabelmap()
        if modifier is None:
            return
        sliceNode = view.GetSliceNode()
        xyToRas = sliceNode.GetXYToRAS()
        ras = [0.0, 0.0, 0.0, 0.0]
        xyToRas.MultiplyPoint([float(xy[0]), float(xy[1]), 0.0, 1.0], ras)
        worldToImage = vtk.vtkMatrix4x4()
        modifier.GetWorldToImageMatrix(worldToImage)
        ijk = [0.0, 0.0, 0.0, 0.0]
        worldToImage.MultiplyPoint(ras[:3] + [1.0], ijk)
        spacing = modifier.GetSpacing()
        extent = modifier.GetExtent()
        radiusVoxels = [self.brushRadius / s for s in spacing]
        lo = [max(extent[2 * a], int(math.floor(ijk[a] - radiusVoxels[a]))) for a in range(3)]
        hi = [min(extent[2 * a + 1], int(math.ceil(ijk[a] + radiusVoxels[a]))) for a in range(3)]
        if any(lo[a] > hi[a] for a in range(3)):
            return
        dims = modifier.GetDimensions()
        scalars = modifier.GetPointData().GetScalars()
        arr = numpy_support.vtk_to_numpy(scalars).reshape(dims[2], dims[1], dims[0])
        k, j, i = np.meshgrid(np.arange(lo[2], hi[2] + 1), np.arange(lo[1], hi[1] + 1), np.arange(lo[0], hi[0] + 1), indexing="ij")
        d2 = ((i - ijk[0]) / radiusVoxels[0]) ** 2 + ((j - ijk[1]) / radiusVoxels[1]) ** 2 + ((k - ijk[2]) / radiusVoxels[2]) ** 2
        mask = d2 <= 1.0
        if not self.sphereBrush:
            # Restrict to the slice: distance from the slice plane less than half voxel along the normal
            imageToWorld = vtk.vtkMatrix4x4()
            modifier.GetImageToWorldMatrix(imageToWorld)
            sliceToRas = sliceNode.GetSliceToRAS()
            normal = np.array([sliceToRas.GetElement(r, 2) for r in range(3)])
            normal /= np.linalg.norm(normal) or 1.0
            m = np.array([[imageToWorld.GetElement(r, c) for c in range(4)] for r in range(3)])
            pts = np.stack([i, j, k, np.ones_like(i)], axis=-1).astype(float) @ m.T
            dist = np.abs((pts - np.array(ras[:3])) @ normal)
            mask &= dist <= 0.5 * min(spacing) + 1e-6
        sub = arr[lo[2]:hi[2] + 1, lo[1]:hi[1] + 1, lo[0]:hi[0] + 1]
        sub[mask] = 1
        scalars.Modified()
        modifier.Modified()
        ext = [lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]]
        if self._strokeExtent is None:
            self._strokeExtent = ext
        else:
            self._strokeExtent = [min(self._strokeExtent[a], ext[a]) if a % 2 == 0 else max(self._strokeExtent[a], ext[a]) for a in range(6)]
        self._apply(ext)

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

    def _endStroke(self):
        self._painting = None
        host.emit("segment-editor-changed", self.state())

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

    def islandsKeepLargest(self):
        import vtk

        modifier = self._prepareModifier()
        self.logic.UpdateSelectedSegmentLabelmap()
        selected = self.logic.GetSelectedSegmentLabelmap()
        f = vtk.vtkImageConnectivityFilter()
        f.SetInputData(selected)
        f.SetExtractionModeToLargestRegion()
        f.SetScalarRange(1, 255)
        f.SetLabelModeToConstantValue()
        f.SetLabelConstantValue(1)
        f.SetOutputScalarType(modifier.GetScalarType())
        f.Update()
        modifier.DeepCopy(f.GetOutput())
        self._copyGeometry(selected, modifier)
        self._apply(mode="Set")

    def smoothMedian(self, kernelSizeMm=3.0):
        import vtk

        modifier = self._prepareModifier()
        self.logic.UpdateSelectedSegmentLabelmap()
        selected = self.logic.GetSelectedSegmentLabelmap()
        spacing = selected.GetSpacing()
        size = [max(1, int(round(kernelSizeMm / s)) // 2 * 2 + 1) for s in spacing]
        f = vtk.vtkImageMedian3D()
        f.SetInputData(selected)
        f.SetKernelSize(*size)
        f.Update()
        modifier.DeepCopy(f.GetOutput())
        self._copyGeometry(selected, modifier)
        self._apply(mode="Set")

    def clearSegment(self):
        self._prepareModifier()
        self._apply(mode="Set")

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
def segmentEditorShow3D(enabled):
    """Show the segments in the 3D views, as the "Show 3D" button of the Segment Editor does.

    A segmentation is shown in 3D by giving it a closed surface, which is built from the labelmaps
    and kept up to date while they are edited.
    """
    e = editor()
    segmentationNode = e.logic.GetSegmentationNode()
    if segmentationNode is None:
        return False
    if enabled:
        segmentationNode.CreateClosedSurfaceRepresentation()
    else:
        segmentationNode.RemoveClosedSurfaceRepresentation()
    host.emit("segment-editor-changed", e.state())
    return True


@method()
def segmentEditorApply(effect, parameters=None):
    e = editor()
    parameters = parameters or {}
    if effect == "Threshold":
        e.threshold(parameters["lower"], parameters["upper"])
    elif effect == "Islands":
        e.islandsKeepLargest()
    elif effect == "Smoothing":
        e.smoothMedian(float(parameters.get("kernelSizeMm", 3.0)))
    elif effect == "Clear":
        e.clearSegment()
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

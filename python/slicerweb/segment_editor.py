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
        self.brushRadius = 5.0  # mm
        self.sphereBrush = False
        self._observers = []  # (interactor, tag)
        self._painting = None  # (view, mode)
        self._strokeExtent = None
        self._sourceVolume = None
        self._sourceVolumeObservers = []

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
            # An effect works on the segment in hand, so with no segments there is nothing any of
            # them can do; growing from seeds needs two of them to grow towards each other.
            "segmentsWithContent": self._segmentIDsWithContent().GetNumberOfValues() if seg is not None else 0,
            "maskMode": self.editorNode.GetMaskMode(),
            "overwriteMode": self.editorNode.GetOverwriteMode(),
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
        host.emit("segment-editor-changed", self.state())

    # ------------------------------------------------------------------ effects
    def setEffect(self, name):
        self._removeObservers()
        self.effect = name or None
        if self.effect in ("Paint", "Erase"):
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
            for event in ("LeftButtonPressEvent", "MouseMoveEvent", "LeftButtonReleaseEvent",
                          "MouseWheelForwardEvent", "MouseWheelBackwardEvent"):
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
            elif event in ("MouseWheelForwardEvent", "MouseWheelBackwardEvent") and caller.GetShiftKey():
                # Shift and the wheel make the brush bigger or smaller, by the fifth that Slicer's
                # paint effect uses, and the slice does not move while it happens.
                self.scaleBrush(1.2 if event == "MouseWheelForwardEvent" else 0.8)
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

    # --- effects that work out what to fill in from what is already there

    def _segmentIDsWithContent(self):
        """The segments that have something in them, in the order they are in the segmentation."""
        import vtk

        segmentationNode = self.logic.GetSegmentationNode()
        segmentation = segmentationNode.GetSegmentation()
        segmentIDs = vtk.vtkStringArray()
        for i in range(segmentation.GetNumberOfSegments()):
            segmentID = segmentation.GetNthSegmentID(i)
            labelmap = segmentation.GetSegment(segmentID).GetRepresentation(
                slicer_binary_labelmap_name())
            if labelmap is not None and labelmap.GetNumberOfPoints() > 0:
                segmentIDs.InsertNextValue(segmentID)
        return segmentIDs

    def _mergedSeeds(self, segmentIDs, geometry=None):
        """All the segments in one labelmap, the n-th of them holding the value n + 1.

        This is what the filters that complete a segmentation are given: they are told which voxels
        are known to belong to which segment, and say what the rest of the voxels are.
        """
        import slicer

        merged = slicer.vtkOrientedImageData()
        self.logic.GetSegmentationNode().GenerateMergedLabelmapForAllSegments(
            merged, slicer.vtkSegmentation.EXTENT_UNION_OF_EFFECTIVE_SEGMENTS, geometry, segmentIDs)
        return merged

    @staticmethod
    def _grownExtent(image, ratio):
        """The extent of an image, grown by a fraction of its size on every side."""
        extent = list(image.GetExtent())
        for axis in range(3):
            low, high = extent[2 * axis], extent[2 * axis + 1]
            margin = int(round((high - low + 1) * ratio))
            extent[2 * axis], extent[2 * axis + 1] = low - margin, high + margin
        return extent

    @staticmethod
    def _clippedTo(image, extent):
        """A copy of an image over the given extent, with whatever it holds there."""
        import vtk

        clip = vtk.vtkImageConstantPad()
        clip.SetInputData(image)
        clip.SetOutputWholeExtent(*extent)
        clip.SetConstant(0)
        clip.Update()
        return clip.GetOutput()

    def _writeSegments(self, output, segmentIDs, imageToWorld):
        """Give each segment what the filter said belongs to it (the n-th value is the n-th segment)."""
        import slicer
        import vtk

        segmentationNode = self.logic.GetSegmentationNode()
        for index in range(segmentIDs.GetNumberOfValues()):
            segmentID = segmentIDs.GetValue(index)
            label = index + 1
            threshold = vtk.vtkImageThreshold()
            threshold.SetInputData(output)
            threshold.ThresholdBetween(label, label)
            threshold.SetInValue(1)
            threshold.SetOutValue(0)
            threshold.SetOutputScalarType(vtk.VTK_UNSIGNED_CHAR)
            threshold.Update()
            result = slicer.vtkOrientedImageData()
            result.DeepCopy(threshold.GetOutput())
            result.SetImageToWorldMatrix(imageToWorld)
            self.logic.ModifySegmentByLabelmap(
                segmentationNode, segmentID, result,
                slicer.vtkSlicerSegmentEditorLogic.ModificationModeSet, False, False)

    def growFromSeeds(self, seedLocality=0.0):
        """Grow what is painted in each segment until the segments meet (grow-cut).

        Every segment is a seed: the voxels painted into it say "this is what this segment looks
        like", and the filter gives every other voxel to the segment it resembles most, following
        the edges in the volume. Paint a little of each structure, and a little of what is around
        them, and the rest is filled in - which is what makes it worth painting a little rather
        than all of it.

        *seedLocality* above zero makes a segment weaker the further it spreads, which keeps a seed
        from reaching across a large flat region.
        """
        import vtk
        import vtkITK

        segmentationNode = self.logic.GetSegmentationNode()
        if segmentationNode is None:
            raise RuntimeError("Select a segmentation first")
        segmentIDs = self._segmentIDsWithContent()
        if segmentIDs.GetNumberOfValues() < 2:
            raise RuntimeError("Paint into at least two segments first - one of them for what is "
                               "around the structure - and they grow until they meet")
        self.logic.SaveStateForUndo()
        self.logic.UpdateReferenceGeometryImage()
        self.logic.UpdateAlignedSourceVolume()
        source = self.logic.GetAlignedSourceVolume()
        if source is None:
            raise RuntimeError("Select a source volume first")

        merged = self._mergedSeeds(segmentIDs, self.logic.GetReferenceGeometryImage())
        # Only the region around the seeds is grown into. What growing costs follows the number of
        # voxels, and a whole volume of them is more than a page should chew on.
        extent = self._roiAroundSeeds(merged, source, 0.35)

        growCut = vtkITK.vtkITKGrowCut()
        growCut.SetIntensityVolume(self._clippedTo(source, extent))
        growCut.SetSeedLabelVolume(self._clippedTo(merged, extent))
        growCut.SetDistancePenalty(float(seedLocality))
        growCut.Update()

        imageToWorld = vtk.vtkMatrix4x4()
        merged.GetImageToWorldMatrix(imageToWorld)
        self._writeSegments(growCut.GetOutput(), segmentIDs, imageToWorld)
        host.emit("segment-editor-changed", self.state())

    def fillBetweenSlices(self):
        """Fill in the slices between the ones that were segmented.

        Segment a structure on every few slices and this puts in what lies between them, by
        following how the outline changes from one segmented slice to the next. Every segment that
        has anything in it is filled in, as the same effect of Slicer does.
        """
        import vtk
        import vtkITK

        segmentationNode = self.logic.GetSegmentationNode()
        if segmentationNode is None:
            raise RuntimeError("Select a segmentation first")
        segmentIDs = self._segmentIDsWithContent()
        if segmentIDs.GetNumberOfValues() < 1:
            raise RuntimeError("Segment a few slices first, and the ones between them are filled in")
        self.logic.SaveStateForUndo()
        self.logic.UpdateReferenceGeometryImage()

        merged = self._mergedSeeds(segmentIDs, self.logic.GetReferenceGeometryImage())
        interpolator = vtkITK.vtkITKMorphologicalContourInterpolator()
        interpolator.SetInputData(merged)
        interpolator.Update()

        imageToWorld = vtk.vtkMatrix4x4()
        merged.GetImageToWorldMatrix(imageToWorld)
        self._writeSegments(interpolator.GetOutput(), segmentIDs, imageToWorld)
        host.emit("segment-editor-changed", self.state())

    @staticmethod
    def _arrayOf(image):
        """The voxels of an image as a NumPy array, in the order NumPy keeps them (slice, row, column)."""
        from vtk.util import numpy_support

        dimensions = image.GetDimensions()
        scalars = image.GetPointData().GetScalars()
        return numpy_support.vtk_to_numpy(scalars).reshape(dimensions[2], dimensions[1], dimensions[0])

    def _roiAroundSeeds(self, seedImage, source, ratio):
        """The extent the growing happens in: around the seeds themselves, and inside the volume.

        The seed image covers the whole volume, most of it empty; what matters is the box the
        seeds sit in, widened so that the segments have somewhere to grow into.
        """
        import numpy as np

        seeds = self._arrayOf(seedImage)
        where = np.argwhere(seeds > 0)
        if where.size == 0:
            raise RuntimeError("Paint into the segments first")
        imageExtent = seedImage.GetExtent()
        low = where.min(axis=0)[::-1]    # (slice, row, column) -> (x, y, z)
        high = where.max(axis=0)[::-1]
        extent = []
        for axis in range(3):
            first = int(low[axis]) + imageExtent[2 * axis]
            last = int(high[axis]) + imageExtent[2 * axis]
            margin = max(int(round((last - first + 1) * ratio)), 3)
            extent += [first - margin, last + margin]
        volumeExtent = source.GetExtent()
        return [max(extent[0], volumeExtent[0]), min(extent[1], volumeExtent[1]),
                max(extent[2], volumeExtent[2]), min(extent[3], volumeExtent[3]),
                max(extent[4], volumeExtent[4]), min(extent[5], volumeExtent[5])]
    # --- effects that change the shape of the segment in hand

    def margin(self, marginMm):
        """Grow the segment by so many millimetres, or shrink it where the number is negative."""
        import vtk
        import vtkITK

        modifier = self._prepareModifier()
        self.logic.UpdateSelectedSegmentLabelmap()
        selected = self.logic.GetSelectedSegmentLabelmap()
        marginMm = float(marginMm)

        # Distance is measured from the edge of what the image holds, and outwards, so shrinking is
        # done by growing what surrounds the segment and turning the answer around afterwards.
        wanted = vtk.vtkImageThreshold()
        wanted.SetInputData(selected)
        wanted.ThresholdByLower(0)
        wanted.SetInValue(1 if marginMm < 0 else 0)
        wanted.SetOutValue(0 if marginMm < 0 else 1)
        wanted.SetOutputScalarType(selected.GetScalarType())

        grown = vtkITK.vtkITKImageMargin()
        grown.SetInputConnection(wanted.GetOutputPort())
        grown.CalculateMarginInMMOn()
        grown.SetOuterMarginMM(abs(marginMm))
        grown.Update()

        if marginMm >= 0:
            modifier.DeepCopy(grown.GetOutput())
        else:
            back = vtk.vtkImageThreshold()
            back.SetInputData(grown.GetOutput())
            back.ThresholdByLower(0)
            back.SetInValue(1)
            back.SetOutValue(0)
            back.SetOutputScalarType(selected.GetScalarType())
            back.Update()
            modifier.DeepCopy(back.GetOutput())
        self._copyGeometry(selected, modifier)
        self._apply(mode="Set")

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
        """Copy, add, subtract or intersect another segment with this one, or invert or fill it."""
        import slicer

        needsOther = operation in ("copy", "add", "subtract", "intersect")
        segmentationNode = self.logic.GetSegmentationNode()
        if segmentationNode is None or not self.logic.GetCurrentSegmentID():
            raise RuntimeError("Select a segmentation and a segment first")
        if needsOther and not modifierSegmentID:
            raise RuntimeError("Choose the other segment to %s" % operation)
        self.logic.SaveStateForUndo()
        self.logic.UpdateMaskLabelmap()
        self.logic.UpdateReferenceGeometryImage()
        self.logic.UpdateSelectedSegmentLabelmap()
        selected = self.logic.GetSelectedSegmentLabelmap()

        if operation in ("clear", "fill"):
            slicer.vtkOrientedImageDataResample.FillImage(
                selected, 1 if operation == "fill" else 0, selected.GetExtent())
            self._modifySelected(selected, "Set")
            return
        if operation == "invert":
            self._modifySelected(self._inverted(selected), "Set")
            return

        other = slicer.vtkOrientedImageData()
        segmentationNode.GetBinaryLabelmapRepresentation(modifierSegmentID, other)
        if not slicer.vtkOrientedImageDataResample.DoGeometriesMatch(selected, other):
            resampled = slicer.vtkOrientedImageData()
            slicer.vtkOrientedImageDataResample.ResampleOrientedImageToReferenceOrientedImage(
                other, selected, resampled, False, True)
            other = resampled
        if operation == "copy":
            self._modifySelected(other, "Set")
        elif operation == "add":
            self._modifySelected(other, "Add")
        elif operation == "subtract":
            self._modifySelected(other, "Remove")
        else:  # what the two of them have in common
            intersection = slicer.vtkOrientedImageData()
            slicer.vtkOrientedImageDataResample.MergeImage(
                selected, other, intersection,
                slicer.vtkOrientedImageDataResample.OPERATION_MINIMUM, selected.GetExtent())
            self._modifySelected(intersection, "Set")

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

    def _modifySelected(self, labelmap, mode):
        import slicer

        modeValue = {"Add": slicer.vtkSlicerSegmentEditorLogic.ModificationModeAdd,
                     "Remove": slicer.vtkSlicerSegmentEditorLogic.ModificationModeRemove,
                     "Set": slicer.vtkSlicerSegmentEditorLogic.ModificationModeSet}[mode]
        self.logic.ModifySegmentByLabelmap(
            self.logic.GetSegmentationNode(), self.logic.GetCurrentSegmentID(), labelmap,
            modeValue, False, False)
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
    elif effect == "GrowFromSeeds":
        e.growFromSeeds(float(parameters.get("seedLocality", 0.0)))
    elif effect == "FillBetweenSlices":
        e.fillBetweenSlices()
    elif effect == "Margin":
        e.margin(float(parameters.get("marginMm", 3.0)))
    elif effect == "Hollow":
        e.hollow(float(parameters.get("thicknessMm", 3.0)), str(parameters.get("shellMode", "inside")))
    elif effect == "Logic":
        e.logicalOperation(str(parameters.get("operation", "copy")), parameters.get("modifierSegmentID") or None)
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

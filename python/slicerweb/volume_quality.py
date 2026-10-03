"""Coarser volume rendering while the camera is moving.

VTK can do this by itself: the mapper is given a time to render in, compares it with how long the
last frame took, and takes coarser steps until it fits. That comparison cannot work in a browser.
WebGL hands the work to the graphics card and returns without waiting for it, so the time VTK
measures is the time it took to ask, not the time it took to draw - a millisecond or so, whatever
the volume - and the mapper concludes that it has plenty of time and never coarsens anything
(vtkOpenGLGPUVolumeRayCastMapper::ComputeReductionFactor, which does nothing while TimeToDraw is
zero).

So the coarsening is done here instead, on what the interactor says rather than on a clock: while a
camera drag is going on, the volumes in that view are rendered with fewer rays and bigger steps
along them, and when the drag ends they go back to what they were and the view is drawn again in
full. Which is what Slicer's "Adaptive" quality means; only the decision is made differently.

Segmentations shown as binary labelmap (vtkSegmentationLabelmapSurfaceMapper casts rays too) are
drawn the same way while the camera moves: rays for every n-th pixel across and down, n being the
application setting Segmentations/ImageSampleDistanceWhileMoving. And ambient shadows take fewer
samples per pixel (noisier, many times faster) unless the setting Rendering/FastShadowsWhileMoving
is off.
"""

import logging

import vtk

logger = logging.getLogger("slicerweb.volume_quality")

#: How much coarser to go while moving, by the frame rate the view is asked to keep up with. Rays
#: are cast for every n-th pixel across and down, so 2 is a quarter of the rays, 3 a ninth.
def _raysWhileMoving(expectedFPS):
    if expectedFPS >= 25:
        return 4.0
    if expectedFPS >= 15:
        return 3.0
    return 2.0


#: Samples per pixel of ambient shadows while moving (320 when still, as in desktop Slicer)
SHADOWS_KERNEL_SIZE_WHILE_MOVING = 32


#: And how big a step to take along each ray, as a multiple of the largest voxel side. One step per
#: voxel is what a still render uses; while moving, fewer and longer steps.
def _stepWhileMoving(expectedFPS):
    return 2.0 if expectedFPS >= 15 else 1.5


class AdaptiveVolumeQuality:
    """Watches one 3D view and coarsens the volumes in it while the camera is being moved."""

    def __init__(self, view):
        self._view = view
        self._saved = {}          # mapper -> what it was before the drag
        self._observers = []
        style = view.GetInteractor().GetInteractorStyle() if view.GetInteractor() else None
        if style is None:
            return
        self._style = style
        self._observers = [
            (style, style.AddObserver(vtk.vtkCommand.StartInteractionEvent, self._startMoving)),
            (style, style.AddObserver(vtk.vtkCommand.EndInteractionEvent, self._stopMoving)),
        ]

    def remove(self):
        for subject, tag in self._observers:
            subject.RemoveObserver(tag)
        self._observers = []
        self._saved = {}

    # ------------------------------------------------------------------ what the view holds
    def _volumeMappers(self):
        """The volume mappers drawing in this view, which are what there is to coarsen."""
        window = self._view.GetRenderWindow()
        renderers = window.GetRenderers() if window else None
        mappers = []
        for i in range(renderers.GetNumberOfItems() if renderers else 0):
            volumes = renderers.GetItemAsObject(i).GetVolumes()
            for v in range(volumes.GetNumberOfItems()):
                mapper = volumes.GetItemAsObject(v).GetMapper()
                if mapper is not None and hasattr(mapper, "SetImageSampleDistance"):
                    mappers.append(mapper)
        return mappers

    def _segmentationMappers(self):
        """The mappers of segmentations shown as binary labelmap in this view. They are looked up
        when a drag starts: the displayable manager makes a new one when the opacity changes."""
        window = self._view.GetRenderWindow()
        renderers = window.GetRenderers() if window else None
        mappers = []
        for i in range(renderers.GetNumberOfItems() if renderers else 0):
            actors = renderers.GetItemAsObject(i).GetActors()
            for a in range(actors.GetNumberOfItems()):
                actor = actors.GetItemAsObject(a)
                mapper = actor.GetMapper()
                if actor.GetVisibility() and mapper is not None and mapper.IsA("vtkSegmentationLabelmapSurfaceMapper"):
                    mappers.append(mapper)
        return mappers

    @staticmethod
    def _segmentationImageSampleDistance():
        """Rays for every n-th pixel while moving (application setting; 1 draws them in full)."""
        import slicer

        value = slicer.app.userSettings().value("Segmentations/ImageSampleDistanceWhileMoving", 2)
        try:
            return min(max(float(value), 1.0), 8.0)
        except (TypeError, ValueError):
            return 2.0

    @staticmethod
    def _fastShadows():
        """Whether ambient shadows take fewer samples while moving (application setting)."""
        import slicer

        value = slicer.app.userSettings().value("Rendering/FastShadowsWhileMoving", True)
        return str(value).lower() not in ("false", "0", "")

    def _expectedFPS(self):
        node = self._view.GetMRMLViewNode() if hasattr(self._view, "GetMRMLViewNode") else None
        return float(node.GetExpectedFPS()) if node is not None else 8.0

    def _adaptive(self):
        """Whether this view was asked for adaptive quality (the other settings are fixed)."""
        import slicer

        node = self._view.GetMRMLViewNode() if hasattr(self._view, "GetMRMLViewNode") else None
        return node is not None and node.GetVolumeRenderingQuality() == slicer.vtkMRMLViewNode.Adaptive

    # ------------------------------------------------------------------ the drag
    def _startMoving(self, caller, event):
        if self._saved:
            return
        if self._fastShadows() and hasattr(self._view, "SetShadowsKernelSize"):
            self._saved[self._view] = {"shadowsKernelSize": self._view.GetShadowsKernelSize()}
            self._view.SetShadowsKernelSize(SHADOWS_KERNEL_SIZE_WHILE_MOVING)
        distance = self._segmentationImageSampleDistance()
        if distance > 1.0:
            for mapper in self._segmentationMappers():
                self._saved[mapper] = {"imageSampleDistance": mapper.GetImageSampleDistance()}
                mapper.SetImageSampleDistance(distance)
        if not self._adaptive():
            return
        fps = self._expectedFPS()
        rays = _raysWhileMoving(fps)
        for mapper in self._volumeMappers():
            self._saved[mapper] = {
                "autoAdjust": mapper.GetAutoAdjustSampleDistances(),
                "imageSampleDistance": mapper.GetImageSampleDistance(),
                "sampleDistance": mapper.GetSampleDistance(),
                "lockToSpacing": mapper.GetLockSampleDistanceToInputSpacing(),
            }
            # The mapper decides the step itself while it is adjusting, so that is turned off and
            # the step is given to it.
            mapper.SetAutoAdjustSampleDistances(False)
            mapper.SetLockSampleDistanceToInputSpacing(False)
            mapper.SetImageSampleDistance(rays)
            mapper.SetSampleDistance(self._movingSampleDistance(mapper, fps))

    def _stopMoving(self, caller, event):
        for mapper, before in self._saved.items():
            try:
                if "shadowsKernelSize" in before:
                    # the view (ambient shadows)
                    mapper.SetShadowsKernelSize(before["shadowsKernelSize"])
                    continue
                if "autoAdjust" not in before:
                    # a segmentation
                    mapper.SetImageSampleDistance(before["imageSampleDistance"])
                    continue
                mapper.SetAutoAdjustSampleDistances(before["autoAdjust"])
                mapper.SetLockSampleDistanceToInputSpacing(before["lockToSpacing"])
                mapper.SetImageSampleDistance(before["imageSampleDistance"])
                mapper.SetSampleDistance(before["sampleDistance"])
            except Exception:
                logger.debug("A mapper went away while the camera was moving", exc_info=True)
        self._saved = {}
        self._view.ScheduleRender()

    @staticmethod
    def _movingSampleDistance(mapper, expectedFPS):
        """A step along the ray of a voxel or two, rather than the half millimetre of a still render."""
        image = mapper.GetInput()
        spacing = max(image.GetSpacing()) if image is not None else 1.0
        return max(spacing, 0.1) * _stepWhileMoving(expectedFPS)

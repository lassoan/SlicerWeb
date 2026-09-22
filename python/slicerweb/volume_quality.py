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
        if self._saved or not self._adaptive():
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
                mapper.SetAutoAdjustSampleDistances(before["autoAdjust"])
                mapper.SetLockSampleDistanceToInputSpacing(before["lockToSpacing"])
                mapper.SetImageSampleDistance(before["imageSampleDistance"])
                mapper.SetSampleDistance(before["sampleDistance"])
            except Exception:
                logger.debug("A volume mapper went away while the camera was moving", exc_info=True)
        self._saved = {}
        self._view.ScheduleRender()

    @staticmethod
    def _movingSampleDistance(mapper, expectedFPS):
        """A step along the ray of a voxel or two, rather than the half millimetre of a still render."""
        image = mapper.GetInput()
        spacing = max(image.GetSpacing()) if image is not None else 1.0
        return max(spacing, 0.1) * _stepWhileMoving(expectedFPS)

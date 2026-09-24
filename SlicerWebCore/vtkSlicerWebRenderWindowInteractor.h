/*==============================================================================

  SlicerWeb: 3D Slicer in the browser.
  See the LICENSE file.

==============================================================================*/

#ifndef vtkSlicerWebRenderWindowInteractor_h
#define vtkSlicerWebRenderWindowInteractor_h

#include "vtkSlicerWebCoreExport.h"

#ifdef __EMSCRIPTEN__
#include <vtkWebAssemblyRenderWindowInteractor.h>
using vtkSlicerWebRenderWindowInteractorBase = vtkWebAssemblyRenderWindowInteractor;
#else
#include <vtkRenderWindowInteractor.h>
using vtkSlicerWebRenderWindowInteractorBase = vtkRenderWindowInteractor;
#endif

/// \brief The interactor of the browser views: two fingers make one continuous gesture.
///
/// vtkRenderWindowInteractor tells a pinch, a rotation and a pan apart: whichever the fingers
/// have done most of since they touched is the gesture, and when another takes the lead the
/// first is ended and the next started - with values measured from where the fingers first
/// touched, so the view jumps by what the new gesture had accumulated meanwhile. Fingers on a
/// phone do all three at once, so here they are one gesture: from the moment it starts, every
/// move reports the scale, the rotation and the translation since the fingers touched, and the
/// widgets apply the change of each since the previous move. (A slice view puts off the rotation
/// until the fingers have turned well past what a pinch turns them by, see vtkSlicerWebSliceView.)
class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebRenderWindowInteractor : public vtkSlicerWebRenderWindowInteractorBase
{
public:
  static vtkSlicerWebRenderWindowInteractor* New();
  vtkTypeMacro(vtkSlicerWebRenderWindowInteractor, vtkSlicerWebRenderWindowInteractorBase);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// Ready to take events without rendering a frame first and without listening to the page:
  /// for a view of a shared canvas, which is sent its events by the canvas, and for the canvas's
  /// own interactor, which has nothing to render (vtkSlicerWebCanvas).
  void InitializeWithoutRendering();

protected:
  vtkSlicerWebRenderWindowInteractor() = default;
  ~vtkSlicerWebRenderWindowInteractor() override = default;

  void RecognizeGesture(vtkCommand::EventIds event) override;
  void EndGesture();

  /// Whether the fingers have moved enough since they touched for a gesture to have started.
  bool GestureStarted{ false };

private:
  vtkSlicerWebRenderWindowInteractor(const vtkSlicerWebRenderWindowInteractor&) = delete;
  void operator=(const vtkSlicerWebRenderWindowInteractor&) = delete;
};

#endif

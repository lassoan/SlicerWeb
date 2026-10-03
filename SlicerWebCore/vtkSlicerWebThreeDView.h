/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

  Qt-free equivalent of qMRMLThreeDView: view logic, 3D displayable managers and
  Slicer's 3D view interactor style.

==============================================================================*/

#ifndef vtkSlicerWebThreeDView_h
#define vtkSlicerWebThreeDView_h

#include "vtkSlicerWebView.h"

class vtkMRMLCameraNode;
class vtkMRMLThreeDViewInteractorStyle;
class vtkMRMLViewLogic;
class vtkMRMLViewNode;

class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebThreeDView : public vtkSlicerWebView
{
public:
  static vtkSlicerWebThreeDView* New();
  vtkTypeMacro(vtkSlicerWebThreeDView, vtkSlicerWebView);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  vtkMRMLViewLogic* GetViewLogic();
  vtkMRMLViewNode* GetMRMLViewNode();
  vtkMRMLCameraNode* GetCameraNode();
  vtkMRMLThreeDViewInteractorStyle* GetThreeDViewInteractorStyle();

  /// Reset focal point to the center of visible content (same as qMRMLThreeDView::resetFocalPoint).
  void ResetFocalPoint();

  /// Reset camera to show all visible content and rotate to the given direction
  /// (vtkMRMLCameraNode::Left, Right, Posterior, Anterior, Inferior, Superior).
  void ResetCamera(int direction = -1);

  /// Displayable managers instantiated in each 3D view (in addition to those registered by modules).
  static void RegisterDefaultDisplayableManagers();

  /// Show ambient shadows (screen-space ambient occlusion) as the view node sets them
  /// (ShadowsVisibility, AmbientShadows*), as qMRMLThreeDView does. Called when the view node changes.
  void UpdateShadowsFromViewNode();

  /// Number of samples per pixel of the ambient shadows (320, as in qMRMLThreeDView). Fewer samples are much faster
  /// (most of the time of a frame with shadows goes to them on a phone) but make the shadows noisier, which is
  /// acceptable while the camera is moving (slicerweb.volume_quality).
  void SetShadowsKernelSize(int kernelSize);
  int GetShadowsKernelSize();

protected:
  vtkSlicerWebThreeDView();
  ~vtkSlicerWebThreeDView() override;

  bool InitializeView(vtkMRMLApplicationLogic* appLogic, vtkMRMLScene* scene, const char* layoutName) override;
  void FinalizeView() override;

  class vtkThreeDInternal;
  vtkThreeDInternal* ThreeDInternal;

private:
  vtkSlicerWebThreeDView(const vtkSlicerWebThreeDView&) = delete;
  void operator=(const vtkSlicerWebThreeDView&) = delete;
};

#endif

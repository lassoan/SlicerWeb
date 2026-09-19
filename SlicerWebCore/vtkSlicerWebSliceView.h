/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

  Qt-free equivalent of qMRMLSliceWidget (view part): slice logic, 2D image display,
  slice view displayable managers and Slicer's slice view interactor style.

==============================================================================*/

#ifndef vtkSlicerWebSliceView_h
#define vtkSlicerWebSliceView_h

#include "vtkSlicerWebView.h"

class vtkMRMLSliceLogic;
class vtkMRMLSliceNode;
class vtkMRMLSliceViewInteractorStyle;

class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebSliceView : public vtkSlicerWebView
{
public:
  static vtkSlicerWebSliceView* New();
  vtkTypeMacro(vtkSlicerWebSliceView, vtkSlicerWebView);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  vtkMRMLSliceLogic* GetSliceLogic();
  vtkMRMLSliceNode* GetSliceNode();
  vtkMRMLSliceViewInteractorStyle* GetSliceViewInteractorStyle();

  /// Displayable managers instantiated in each slice view (in addition to those registered
  /// by modules, e.g. vtkMRMLMarkupsDisplayableManager).
  static void RegisterDefaultDisplayableManagers();

protected:
  vtkSlicerWebSliceView();
  ~vtkSlicerWebSliceView() override;

  bool InitializeView(vtkMRMLApplicationLogic* appLogic, vtkMRMLScene* scene, const char* layoutName) override;
  void FinalizeView() override;
  void OnSizeChanged(int width, int height) override;

  void UpdateImageDataConnection();
  static void OnSliceLogicModified(vtkObject* caller, unsigned long eid, void* clientData, void* callData);

  class vtkSliceInternal;
  vtkSliceInternal* SliceInternal;

private:
  vtkSlicerWebSliceView(const vtkSlicerWebSliceView&) = delete;
  void operator=(const vtkSlicerWebSliceView&) = delete;
};

#endif

/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

==============================================================================*/

#include "vtkSlicerWebThreeDView.h"

// MRML includes
#include <vtkMRMLApplicationLogic.h>
#include <vtkMRMLCameraDisplayableManager.h>
#include <vtkMRMLCameraNode.h>
#include <vtkMRMLCrosshairDisplayableManager.h>
#include <vtkMRMLCrosshairNode.h>
#include <vtkMRMLDisplayableManagerGroup.h>
#include <vtkMRMLScene.h>
#include <vtkMRMLThreeDViewDisplayableManagerFactory.h>
#include <vtkMRMLThreeDViewInteractorStyle.h>
#include <vtkMRMLViewLogic.h>
#include <vtkMRMLViewNode.h>

// VTK includes
#include <vtkCamera.h>
#include <vtkCollection.h>
#include <vtkInteractorStyle3D.h>
#include <vtkMath.h>
#include <vtkNew.h>
#include <vtkObjectFactory.h>
#include <vtkRenderWindowInteractor.h>
#include <vtkRenderer.h>
#include <vtkWeakPointer.h>

#include <string>
#include <vector>

//----------------------------------------------------------------------------
class vtkSlicerWebThreeDView::vtkThreeDInternal
{
public:
  vtkSmartPointer<vtkMRMLViewLogic> ViewLogic;
  vtkWeakPointer<vtkMRMLApplicationLogic> AppLogic;
};

vtkStandardNewMacro(vtkSlicerWebThreeDView);

//----------------------------------------------------------------------------
vtkSlicerWebThreeDView::vtkSlicerWebThreeDView()
  : ThreeDInternal(new vtkThreeDInternal)
{
}

//----------------------------------------------------------------------------
vtkSlicerWebThreeDView::~vtkSlicerWebThreeDView()
{
  this->Finalize();
  delete this->ThreeDInternal;
}

//----------------------------------------------------------------------------
void vtkSlicerWebThreeDView::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
}

//----------------------------------------------------------------------------
void vtkSlicerWebThreeDView::RegisterDefaultDisplayableManagers()
{
  // Same list as qMRMLThreeDViewPrivate::initDisplayableManagers()
  const std::vector<std::string> displayableManagers = {
    "vtkMRMLCameraDisplayableManager",
    "vtkMRMLViewDisplayableManager",
    "vtkMRMLModelDisplayableManager",
    "vtkMRMLThreeDReformatDisplayableManager",
    "vtkMRMLThreeDSliceEdgeDisplayableManager",
    "vtkMRMLCrosshairDisplayableManager3D",
    "vtkMRMLOrientationMarkerDisplayableManager",
    "vtkMRMLRulerDisplayableManager",
  };
  vtkMRMLThreeDViewDisplayableManagerFactory* factory = vtkMRMLThreeDViewDisplayableManagerFactory::GetInstance();
  for (const std::string& name : displayableManagers)
  {
    if (!factory->IsDisplayableManagerRegistered(name.c_str()))
    {
      factory->RegisterDisplayableManager(name.c_str());
    }
  }
}

//----------------------------------------------------------------------------
bool vtkSlicerWebThreeDView::InitializeView(vtkMRMLApplicationLogic* appLogic, vtkMRMLScene* scene, const char* layoutName)
{
  vtkThreeDInternal* d = this->ThreeDInternal;
  vtkRenderer* renderer = this->GetRenderer();

  // Same rendering settings as ctkVTKRenderView / qMRMLThreeDView
  renderer->SetUseDepthPeeling(true);
  renderer->SetUseDepthPeelingForVolumes(true);
  double* defaultBackground = vtkMRMLViewNode::defaultBackgroundColor();
  double* defaultBackground2 = vtkMRMLViewNode::defaultBackgroundColor2();
  renderer->SetBackground(defaultBackground);
  renderer->SetBackground2(defaultBackground2);
  renderer->SetGradientBackground(true);

  d->AppLogic = appLogic;
  d->ViewLogic = vtkSmartPointer<vtkMRMLViewLogic>::New();
  d->ViewLogic->SetMRMLApplicationLogic(appLogic);
  d->ViewLogic->SetMRMLScene(scene);
  if (appLogic->GetViewLogics())
  {
    appLogic->GetViewLogics()->AddItem(d->ViewLogic);
  }
  // Use the view node of the layout (a singleton identified by the layout name), see
  // vtkSlicerWebSliceView::InitializeView().
  vtkMRMLViewNode* viewNode = vtkMRMLViewNode::SafeDownCast(scene->GetSingletonNode(layoutName, "vtkMRMLViewNode"));
  if (viewNode)
  {
    // the view logic finds the view (and camera) node by layout name
    d->ViewLogic->SetName(layoutName);
    viewNode = d->ViewLogic->GetViewNode();
  }
  else
  {
    viewNode = d->ViewLogic->AddViewNode(layoutName);
  }
  if (!viewNode)
  {
    vtkErrorMacro("InitializeView: failed to create view node for layout name " << layoutName);
    return false;
  }

  vtkNew<vtkInteractorStyle3D> interactorStyle;
  this->GetInteractor()->SetInteractorStyle(interactorStyle);
  vtkNew<vtkMRMLThreeDViewInteractorStyle> interactorObserver;
  this->SetInteractorObserverInternal(interactorObserver);

  vtkSlicerWebThreeDView::RegisterDefaultDisplayableManagers();
  vtkMRMLThreeDViewDisplayableManagerFactory* factory = vtkMRMLThreeDViewDisplayableManagerFactory::GetInstance();
  factory->SetMRMLApplicationLogic(appLogic);
  vtkSmartPointer<vtkMRMLDisplayableManagerGroup> group;
  group.TakeReference(factory->InstantiateDisplayableManagers(renderer));
  this->SetDisplayableManagerGroupInternal(group);
  this->SetViewNode(viewNode);
  return true;
}

//----------------------------------------------------------------------------
void vtkSlicerWebThreeDView::FinalizeView()
{
  vtkThreeDInternal* d = this->ThreeDInternal;
  if (d->ViewLogic)
  {
    if (d->AppLogic && d->AppLogic->GetViewLogics())
    {
      d->AppLogic->GetViewLogics()->RemoveItem(d->ViewLogic);
    }
    d->ViewLogic->SetMRMLScene(nullptr);
    d->ViewLogic->SetMRMLApplicationLogic(nullptr);
  }
  d->ViewLogic = nullptr;
  d->AppLogic = nullptr;
}

//----------------------------------------------------------------------------
vtkMRMLViewLogic* vtkSlicerWebThreeDView::GetViewLogic()
{
  return this->ThreeDInternal->ViewLogic;
}

//----------------------------------------------------------------------------
vtkMRMLViewNode* vtkSlicerWebThreeDView::GetMRMLViewNode()
{
  return vtkMRMLViewNode::SafeDownCast(this->GetViewNode());
}

//----------------------------------------------------------------------------
vtkMRMLCameraNode* vtkSlicerWebThreeDView::GetCameraNode()
{
  vtkMRMLDisplayableManagerGroup* group = this->GetDisplayableManagerGroup();
  if (!group)
  {
    return nullptr;
  }
  vtkMRMLCameraDisplayableManager* cameraDM =
    vtkMRMLCameraDisplayableManager::SafeDownCast(group->GetDisplayableManagerByClassName("vtkMRMLCameraDisplayableManager"));
  return cameraDM ? cameraDM->GetCameraNode() : nullptr;
}

//----------------------------------------------------------------------------
vtkMRMLThreeDViewInteractorStyle* vtkSlicerWebThreeDView::GetThreeDViewInteractorStyle()
{
  return vtkMRMLThreeDViewInteractorStyle::SafeDownCast(this->GetInteractorObserver());
}

//----------------------------------------------------------------------------
void vtkSlicerWebThreeDView::ResetFocalPoint()
{
  if (!this->GetInitialized())
  {
    return;
  }
  vtkMRMLViewNode* viewNode = this->GetMRMLViewNode();
  bool savedBoxVisible = true;
  bool savedAxisLabelsVisible = true;
  if (viewNode)
  {
    savedBoxVisible = viewNode->GetBoxVisible();
    savedAxisLabelsVisible = viewNode->GetAxisLabelsVisible();
    int wasModifying = viewNode->StartModify();
    viewNode->SetBoxVisible(0);
    viewNode->SetAxisLabelsVisible(0);
    viewNode->EndModify(wasModifying);
  }
  vtkMRMLCrosshairNode* crosshairNode = vtkMRMLCrosshairDisplayableManager::FindCrosshairNode(this->GetMRMLScene());
  int crosshairMode = vtkMRMLCrosshairNode::NoCrosshair;
  if (crosshairNode)
  {
    crosshairMode = crosshairNode->GetCrosshairMode();
    crosshairNode->SetCrosshairMode(vtkMRMLCrosshairNode::NoCrosshair);
  }

  // Same as ctkVTKRenderView::resetFocalPoint
  vtkRenderer* renderer = this->GetRenderer();
  double bounds[6];
  renderer->ComputeVisiblePropBounds(bounds);
  if (vtkMath::AreBoundsInitialized(bounds))
  {
    double center[3] = { (bounds[0] + bounds[1]) / 2.0, (bounds[2] + bounds[3]) / 2.0, (bounds[4] + bounds[5]) / 2.0 };
    renderer->GetActiveCamera()->SetFocalPoint(center);
    renderer->ResetCameraClippingRange();
  }

  if (viewNode)
  {
    int wasModifying = viewNode->StartModify();
    viewNode->SetBoxVisible(savedBoxVisible);
    viewNode->SetAxisLabelsVisible(savedAxisLabelsVisible);
    viewNode->EndModify(wasModifying);
  }
  if (crosshairNode)
  {
    crosshairNode->SetCrosshairMode(crosshairMode);
  }
  this->ScheduleRender();
}

//----------------------------------------------------------------------------
void vtkSlicerWebThreeDView::ResetCamera(int direction)
{
  if (!this->GetInitialized())
  {
    return;
  }
  vtkMRMLCameraNode* cameraNode = this->GetCameraNode();
  if (cameraNode && direction >= 0)
  {
    cameraNode->RotateTo(static_cast<vtkMRMLCameraNode::Direction>(direction));
  }
  this->ResetFocalPoint();
  if (cameraNode)
  {
    cameraNode->Reset(/*resetRotation=*/false, /*resetTranslation=*/true, /*resetDistance=*/true, this->GetRenderer());
  }
  else
  {
    this->GetRenderer()->ResetCamera();
  }
  this->ScheduleRender();
}

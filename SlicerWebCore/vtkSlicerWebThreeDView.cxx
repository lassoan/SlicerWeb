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
#include <vtkCallbackCommand.h>
#include <vtkCamera.h>
#include <vtkCollection.h>
#include <vtkInteractorStyle3D.h>
#include <vtkMath.h>
#include <vtkNew.h>
#include <vtkObjectFactory.h>
#include <vtkRenderStepsPass.h>
#include <vtkRenderWindow.h>
#include <vtkRenderWindowInteractor.h>
#include <vtkRenderer.h>
#include <vtkSSAOPass.h>
#include <vtkTextureObject.h>
#include <vtkWeakPointer.h>

#include <cmath>

#include <string>
#include <vector>

//----------------------------------------------------------------------------
class vtkSlicerWebThreeDView::vtkThreeDInternal
{
public:
  vtkSmartPointer<vtkMRMLViewLogic> ViewLogic;
  vtkWeakPointer<vtkMRMLApplicationLogic> AppLogic;

  // Ambient shadows (screen-space ambient occlusion), set up as qMRMLThreeDView does
  vtkNew<vtkSSAOPass> ShadowsRenderPass;
  vtkNew<vtkRenderStepsPass> BasicRenderPass;
  vtkNew<vtkCallbackCommand> ViewNodeCallback;
  vtkWeakPointer<vtkMRMLViewNode> ObservedViewNode;
  unsigned long ViewNodeObserverTag{ 0 };
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

  // Translucent geometry: desktop Slicer uses (dual) depth peeling, which VTK does not support on
  // OpenGL ES 3 / WebGL 2 ("Built in Dual Depth Peeling is not supported on ES3"). Without depth
  // peeling, VTK renders translucent geometry with its order-independent translucency pass.
  renderer->SetUseDepthPeeling(false);
  renderer->SetUseDepthPeelingForVolumes(false);
  renderer->SetUseOIT(true);
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

  // Ambient shadows, set up as in qMRMLThreeDView: the depth format must be Fixed32 for the volume mapper to copy the
  // depth texture. Translucent geometry is rendered with the translucent pass of the delegate, as on desktop: the
  // order-independent translucency pass used otherwise (see above) copies the depth buffer of the framebuffer it draws
  // into, which WebGL does not allow from the depth format of the shadows pass.
  d->ShadowsRenderPass->SetDepthFormat(vtkTextureObject::Fixed32);
  d->ShadowsRenderPass->SetDelegatePass(d->BasicRenderPass);
  d->ViewNodeCallback->SetClientData(this);
  d->ViewNodeCallback->SetCallback(
    [](vtkObject*, unsigned long, void* clientData, void*) { static_cast<vtkSlicerWebThreeDView*>(clientData)->UpdateShadowsFromViewNode(); });
  d->ObservedViewNode = viewNode;
  d->ViewNodeObserverTag = viewNode->AddObserver(vtkCommand::ModifiedEvent, d->ViewNodeCallback);

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
  // The displayable managers were created with the camera the renderer had before the camera
  // displayable manager put the one of the camera node in its place.
  this->SyncLayerCameras();
  this->UpdateShadowsFromViewNode();
  return true;
}

//----------------------------------------------------------------------------
void vtkSlicerWebThreeDView::UpdateShadowsFromViewNode()
{
  vtkThreeDInternal* d = this->ThreeDInternal;
  vtkMRMLViewNode* viewNode = d->ObservedViewNode;
  vtkRenderer* renderer = this->GetRenderer();
  if (!viewNode || !renderer)
  {
    return;
  }
  vtkRenderPass* pass = viewNode->GetShadowsVisibility() ? d->ShadowsRenderPass.GetPointer() : nullptr;
  bool changed = (renderer->GetPass() != pass);
  renderer->SetPass(pass);
  // Same as qMRMLThreeDView::setAmbientShadowsSizeScale: size scale 0 corresponds to 100 mm scene size
  double sceneSize = 100.0 * std::pow(10.0, viewNode->GetAmbientShadowsSizeScale());
  vtkSSAOPass* ssao = d->ShadowsRenderPass;
  if (ssao->GetBias() != 0.001 * sceneSize || ssao->GetRadius() != 0.1 * sceneSize
      || ssao->GetVolumeOpacityThreshold() != viewNode->GetAmbientShadowsVolumeOpacityThreshold()
      || ssao->GetIntensityScale() != viewNode->GetAmbientShadowsIntensityScale()
      || ssao->GetIntensityShift() != viewNode->GetAmbientShadowsIntensityShift())
  {
    changed = true;
  }
  ssao->SetBias(0.001 * sceneSize); // how much distance difference will be made visible
  ssao->SetRadius(0.1 * sceneSize); // determines the spread of shadows cast by ambient occlusion
  ssao->SetBlur(true);              // reduce noise
  ssao->SetKernelSize(320);         // larger kernel size reduces noise pattern in the darkened region
  ssao->SetVolumeOpacityThreshold(viewNode->GetAmbientShadowsVolumeOpacityThreshold());
  ssao->SetIntensityScale(viewNode->GetAmbientShadowsIntensityScale());
  ssao->SetIntensityShift(viewNode->GetAmbientShadowsIntensityShift());
  if (changed)
  {
    this->ScheduleRender();
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebThreeDView::FinalizeView()
{
  vtkThreeDInternal* d = this->ThreeDInternal;
  if (d->ObservedViewNode)
  {
    d->ObservedViewNode->RemoveObserver(d->ViewNodeObserverTag);
  }
  d->ObservedViewNode = nullptr;
  if (this->GetRenderer())
  {
    this->GetRenderer()->SetPass(nullptr);
    if (this->GetRenderer()->GetRenderWindow())
    {
      d->ShadowsRenderPass->ReleaseGraphicsResources(this->GetRenderer()->GetRenderWindow());
    }
  }
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
    // Tell the view displayable manager that the view was reset, so that the box around the scene
    // and its axis labels are fitted to what is visible now (qMRMLThreeDView does the same).
    viewNode->InvokeEvent(vtkMRMLViewNode::ResetFocalPointRequestedEvent);
  }
  if (crosshairNode)
  {
    crosshairNode->SetCrosshairMode(crosshairMode);
  }
  renderer->ResetCameraClippingRange();
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

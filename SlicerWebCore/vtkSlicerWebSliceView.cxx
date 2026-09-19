/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

==============================================================================*/

#include "vtkSlicerWebSliceView.h"

// MRML includes
#include <vtkMRMLApplicationLogic.h>
#include <vtkMRMLDisplayableManagerGroup.h>
#include <vtkMRMLScene.h>
#include <vtkMRMLSliceLogic.h>
#include <vtkMRMLSliceNode.h>
#include <vtkMRMLSliceViewDisplayableManagerFactory.h>
#include <vtkMRMLSliceViewInteractorStyle.h>

// VTK includes
#include <vtkActor2D.h>
#include <vtkCallbackCommand.h>
#include <vtkCamera.h>
#include <vtkCollection.h>
#include <vtkImageMapper.h>
#include <vtkInteractorStyleUser.h>
#include <vtkNew.h>
#include <vtkObjectFactory.h>
#include <vtkProperty2D.h>
#include <vtkRenderWindow.h>
#include <vtkRenderWindowInteractor.h>
#include <vtkRenderer.h>
#include <vtkWeakPointer.h>

#include <string>
#include <vector>

//----------------------------------------------------------------------------
class vtkSlicerWebSliceView::vtkSliceInternal
{
public:
  vtkSmartPointer<vtkMRMLSliceLogic> SliceLogic;
  vtkWeakPointer<vtkMRMLApplicationLogic> AppLogic;
  vtkSmartPointer<vtkImageMapper> ImageMapper;
  vtkSmartPointer<vtkActor2D> ImageActor;
  vtkNew<vtkCallbackCommand> SliceLogicCallback;
};

vtkStandardNewMacro(vtkSlicerWebSliceView);

//----------------------------------------------------------------------------
vtkSlicerWebSliceView::vtkSlicerWebSliceView()
  : SliceInternal(new vtkSliceInternal)
{
  this->SliceInternal->SliceLogicCallback->SetClientData(this);
  this->SliceInternal->SliceLogicCallback->SetCallback(&vtkSlicerWebSliceView::OnSliceLogicModified);
}

//----------------------------------------------------------------------------
vtkSlicerWebSliceView::~vtkSlicerWebSliceView()
{
  this->Finalize();
  delete this->SliceInternal;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSliceView::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
}

//----------------------------------------------------------------------------
void vtkSlicerWebSliceView::RegisterDefaultDisplayableManagers()
{
  // Same list as qMRMLSliceViewPrivate::initDisplayableManagers()
  const std::vector<std::string> displayableManagers = {
    "vtkMRMLVolumeGlyphSliceDisplayableManager",
    "vtkMRMLModelSliceDisplayableManager",
    "vtkMRMLCrosshairDisplayableManager",
    "vtkMRMLOrientationMarkerDisplayableManager",
    "vtkMRMLRulerDisplayableManager",
    "vtkMRMLScalarBarDisplayableManager",
  };
  vtkMRMLSliceViewDisplayableManagerFactory* factory = vtkMRMLSliceViewDisplayableManagerFactory::GetInstance();
  for (const std::string& name : displayableManagers)
  {
    if (!factory->IsDisplayableManagerRegistered(name.c_str()))
    {
      factory->RegisterDisplayableManager(name.c_str());
    }
  }
}

//----------------------------------------------------------------------------
bool vtkSlicerWebSliceView::InitializeView(vtkMRMLApplicationLogic* appLogic, vtkMRMLScene* scene, const char* layoutName)
{
  vtkSliceInternal* d = this->SliceInternal;
  vtkRenderer* renderer = this->GetRenderer();

  // Slice views use parallel projection (see ctkVTKSliceView / vtkLightBoxRendererManager)
  renderer->GetActiveCamera()->ParallelProjectionOn();
  renderer->SetBackground(0.0, 0.0, 0.0);

  // Reslice/blend output of the slice logic is displayed as a 2D image in the background
  // (same as vtkLightBoxRendererManager with a single pane).
  d->ImageMapper = vtkSmartPointer<vtkImageMapper>::New();
  d->ImageMapper->SetColorWindow(255);
  d->ImageMapper->SetColorLevel(127.5);
  d->ImageActor = vtkSmartPointer<vtkActor2D>::New();
  d->ImageActor->SetMapper(d->ImageMapper);
  d->ImageActor->GetProperty()->SetDisplayLocationToBackground();
  d->ImageActor->SetVisibility(false);
  renderer->AddViewProp(d->ImageActor);

  // Slice logic
  d->AppLogic = appLogic;
  d->SliceLogic = vtkSmartPointer<vtkMRMLSliceLogic>::New();
  d->SliceLogic->SetMRMLApplicationLogic(appLogic);
  d->SliceLogic->SetMRMLScene(scene);
  if (appLogic->GetSliceLogics())
  {
    appLogic->GetSliceLogics()->AddItem(d->SliceLogic);
  }
  // Use the slice node of the layout (a singleton identified by the layout name). AddSliceNode()
  // would replace its content with a new default node and keep the logic on the unused copy.
  vtkMRMLSliceNode* sliceNode = vtkMRMLSliceNode::SafeDownCast(scene->GetSingletonNode(layoutName, "vtkMRMLSliceNode"));
  if (sliceNode)
  {
    d->SliceLogic->SetSliceNode(sliceNode);
  }
  else
  {
    sliceNode = d->SliceLogic->AddSliceNode(layoutName);
  }
  if (!sliceNode)
  {
    vtkErrorMacro("InitializeView: failed to create slice node for layout name " << layoutName);
    return false;
  }
  d->SliceLogic->AddObserver(vtkCommand::ModifiedEvent, d->SliceLogicCallback);

  // Interaction: events are routed to displayable managers by Slicer's slice view interactor style.
  vtkNew<vtkInteractorStyleUser> interactorStyle;
  this->GetInteractor()->SetInteractorStyle(interactorStyle);
  vtkNew<vtkMRMLSliceViewInteractorStyle> interactorObserver;
  interactorObserver->SetSliceLogic(d->SliceLogic);
  this->SetInteractorObserverInternal(interactorObserver);

  // Displayable managers
  vtkSlicerWebSliceView::RegisterDefaultDisplayableManagers();
  vtkMRMLSliceViewDisplayableManagerFactory* factory = vtkMRMLSliceViewDisplayableManagerFactory::GetInstance();
  factory->SetMRMLApplicationLogic(appLogic);
  vtkSmartPointer<vtkMRMLDisplayableManagerGroup> group;
  group.TakeReference(factory->InstantiateDisplayableManagers(renderer));
  this->SetDisplayableManagerGroupInternal(group);
  this->SetViewNode(sliceNode);

  this->UpdateImageDataConnection();
  return true;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSliceView::FinalizeView()
{
  vtkSliceInternal* d = this->SliceInternal;
  if (d->SliceLogic)
  {
    d->SliceLogic->RemoveObserver(d->SliceLogicCallback);
    if (d->AppLogic && d->AppLogic->GetSliceLogics())
    {
      d->AppLogic->GetSliceLogics()->RemoveItem(d->SliceLogic);
    }
    d->SliceLogic->SetMRMLScene(nullptr);
    d->SliceLogic->SetMRMLApplicationLogic(nullptr);
  }
  if (d->ImageMapper)
  {
    d->ImageMapper->SetInputConnection(nullptr);
  }
  d->SliceLogic = nullptr;
  d->ImageMapper = nullptr;
  d->ImageActor = nullptr;
  d->AppLogic = nullptr;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSliceView::OnSizeChanged(int width, int height)
{
  if (this->SliceInternal->SliceLogic)
  {
    this->SliceInternal->SliceLogic->ResizeSliceNode(width, height);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebSliceView::UpdateImageDataConnection()
{
  vtkSliceInternal* d = this->SliceInternal;
  if (!d->SliceLogic || !d->ImageMapper)
  {
    return;
  }
  vtkAlgorithmOutput* connection = d->SliceLogic->GetImageDataConnection();
  if (d->ImageMapper->GetNumberOfInputConnections(0) > 0 && d->ImageMapper->GetInputConnection(0, 0) == connection)
  {
    return;
  }
  d->ImageMapper->SetInputConnection(connection);
  d->ImageActor->SetVisibility(connection != nullptr);
}

//----------------------------------------------------------------------------
void vtkSlicerWebSliceView::OnSliceLogicModified(vtkObject* vtkNotUsed(caller), unsigned long vtkNotUsed(eid), void* clientData, void* vtkNotUsed(callData))
{
  vtkSlicerWebSliceView* self = static_cast<vtkSlicerWebSliceView*>(clientData);
  self->UpdateImageDataConnection();
  self->ScheduleRender();
}

//----------------------------------------------------------------------------
vtkMRMLSliceLogic* vtkSlicerWebSliceView::GetSliceLogic()
{
  return this->SliceInternal->SliceLogic;
}

//----------------------------------------------------------------------------
vtkMRMLSliceNode* vtkSlicerWebSliceView::GetSliceNode()
{
  return vtkMRMLSliceNode::SafeDownCast(this->GetViewNode());
}

//----------------------------------------------------------------------------
vtkMRMLSliceViewInteractorStyle* vtkSlicerWebSliceView::GetSliceViewInteractorStyle()
{
  return vtkMRMLSliceViewInteractorStyle::SafeDownCast(this->GetInteractorObserver());
}

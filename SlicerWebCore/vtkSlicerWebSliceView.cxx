/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

==============================================================================*/

#include "vtkSlicerWebSliceView.h"

// MRML includes
#include <vtkMRMLApplicationLogic.h>
#include <vtkMRMLCrosshairNode.h>
#include <vtkMRMLCrosshairDisplayableManager.h>
#include "vtkSlicerWebSegmentEditorDisplayableManager.h"

#include <vtkMRMLDisplayableManagerGroup.h>
#include <vtkMRMLInteractionNode.h>
#include <vtkMRMLScene.h>
#include <vtkMRMLSliceIntersectionWidget.h>
#include <vtkMRMLSliceLogic.h>
#include <vtkMRMLSliceNode.h>
#include <vtkMRMLSliceViewDisplayableManagerFactory.h>
#include <vtkMRMLSliceViewInteractorStyle.h>

// VTK includes
#include <vtkActor2D.h>
#include <vtkCallbackCommand.h>
#include <vtkCamera.h>
#include <vtkCollection.h>
#include <vtkEvent.h>
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

  /// A plain left-click-and-drag pans the slice in the rotate/pan/zoom mouse mode, or moves the
  /// crosshair while it is shown (see UpdateLeftButtonDrag)
  vtkWeakPointer<vtkMRMLSliceIntersectionWidget> SliceIntersectionWidget;
  vtkWeakPointer<vtkMRMLInteractionNode> InteractionNode;
  vtkWeakPointer<vtkMRMLCrosshairNode> CrosshairNode;
  vtkNew<vtkCallbackCommand> InteractionModeCallback;
  /// What the left drag was last set up for: -1 not yet, 0 Slicer's own, 1 pan, 2 move the crosshair
  int LeftButtonDrag{ -1 };
  void UpdateLeftButtonDrag();
  static void OnInteractionModeChanged(vtkObject*, unsigned long, void* clientData, void*)
  {
    static_cast<vtkSliceInternal*>(clientData)->UpdateLeftButtonDrag();
  }
};

//----------------------------------------------------------------------------
void vtkSlicerWebSliceView::vtkSliceInternal::UpdateLeftButtonDrag()
{
  vtkMRMLSliceIntersectionWidget* widget = this->SliceIntersectionWidget;
  if (!widget)
  {
    return;
  }
  // Slicer's own mapping, where a plain left drag is kept for the Scroll mouse mode
  int drag = 0;
  if (this->InteractionNode && this->InteractionNode->GetCurrentInteractionMode() == vtkMRMLInteractionNode::ViewTransform)
  {
    const bool crosshairShown = this->CrosshairNode && this->CrosshairNode->GetCrosshairMode() != vtkMRMLCrosshairNode::NoCrosshair;
    drag = crosshairShown ? 2 : 1;
  }
  if (drag == this->LeftButtonDrag)
  {
    return; // the crosshair node is modified at every move of the crosshair: nothing to do then
  }
  this->LeftButtonDrag = drag;
  widget->UpdateInteractionEventMapping();
  if (drag == 0)
  {
    return;
  }
  // In the rotate/pan/zoom mode a plain left drag pans the slice, as it rotates a 3D view - a
  // trackpad or a finger has no middle button, and the shift key is out of reach on a phone -
  // or, while the crosshair is shown, moves the crosshair.
  // (The first translation that matches is used: the one for scrolling is taken out first.)
  widget->SetEventTranslation(vtkMRMLSliceIntersectionWidget::WidgetStateIdle, vtkCommand::LeftButtonPressEvent, vtkEvent::NoModifier,
                              vtkMRMLSliceIntersectionWidget::WidgetEventNone);
  if (drag == 2)
  {
    widget->SetEventTranslationClickAndDrag(vtkMRMLSliceIntersectionWidget::WidgetStateIdle,
                                            vtkCommand::LeftButtonPressEvent,
                                            vtkEvent::NoModifier,
                                            vtkMRMLSliceIntersectionWidget::WidgetStateMoveCrosshair,
                                            vtkMRMLSliceIntersectionWidget::WidgetEventMoveCrosshairStart,
                                            vtkMRMLSliceIntersectionWidget::WidgetEventMoveCrosshairEnd);
  }
  else
  {
    widget->SetEventTranslationClickAndDrag(vtkMRMLSliceIntersectionWidget::WidgetStateIdle,
                                            vtkCommand::LeftButtonPressEvent,
                                            vtkEvent::NoModifier,
                                            vtkMRMLSliceIntersectionWidget::WidgetStateTranslateSlice,
                                            vtkMRMLSliceIntersectionWidget::WidgetEventTranslateSliceStart,
                                            vtkMRMLSliceIntersectionWidget::WidgetEventTranslateSliceEnd);
  }
}

vtkStandardNewMacro(vtkSlicerWebSliceView);

//----------------------------------------------------------------------------
vtkSlicerWebSliceView::vtkSlicerWebSliceView()
  : SliceInternal(new vtkSliceInternal)
{
  this->SliceInternal->SliceLogicCallback->SetClientData(this);
  this->SliceInternal->SliceLogicCallback->SetCallback(&vtkSlicerWebSliceView::OnSliceLogicModified);
  this->SliceInternal->InteractionModeCallback->SetClientData(this->SliceInternal);
  this->SliceInternal->InteractionModeCallback->SetCallback(&vtkSliceInternal::OnInteractionModeChanged);
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
  // The brush of the Segment Editor (the effects of desktop Slicer draw it themselves, from Qt
  // code). Added here rather than registered with the factory, which builds a displayable manager
  // from its class name through a VTK object factory that only generated module libraries have.
  vtkNew<vtkSlicerWebSegmentEditorDisplayableManager> segmentEditorManager;
  group->AddDisplayableManager(segmentEditorManager);
  // Two fingers on a slice view zoom and pan it; they turn a little with every pinch, and turning
  // the slice is rarely what is meant, so the slice only turns once they have turned well past
  // that (Slicer's own threshold, 10 degrees, is for a desktop touch screen).
  if (auto* crosshairManager = vtkMRMLCrosshairDisplayableManager::SafeDownCast(
        group->GetDisplayableManagerByClassName("vtkMRMLCrosshairDisplayableManager")))
  {
    if (vtkMRMLSliceIntersectionWidget* sliceWidget = crosshairManager->GetSliceIntersectionWidget())
    {
      sliceWidget->SetTouchRotationThreshold(30.0);
      d->SliceIntersectionWidget = sliceWidget;
      d->InteractionNode = appLogic->GetInteractionNode();
      if (d->InteractionNode)
      {
        d->InteractionNode->AddObserver(vtkMRMLInteractionNode::InteractionModeChangedEvent, d->InteractionModeCallback);
      }
      d->CrosshairNode = vtkMRMLCrosshairNode::SafeDownCast(scene->GetFirstNodeByClass("vtkMRMLCrosshairNode"));
      if (d->CrosshairNode)
      {
        d->CrosshairNode->AddObserver(vtkCommand::ModifiedEvent, d->InteractionModeCallback);
      }
      d->LeftButtonDrag = -1;
      d->UpdateLeftButtonDrag();
    }
  }
  this->SetDisplayableManagerGroupInternal(group);
  this->SetViewNode(sliceNode);

  this->UpdateImageDataConnection();
  return true;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSliceView::FinalizeView()
{
  vtkSliceInternal* d = this->SliceInternal;
  if (d->InteractionNode)
  {
    d->InteractionNode->RemoveObserver(d->InteractionModeCallback);
  }
  if (d->CrosshairNode)
  {
    d->CrosshairNode->RemoveObserver(d->InteractionModeCallback);
  }
  d->InteractionNode = nullptr;
  d->CrosshairNode = nullptr;
  d->SliceIntersectionWidget = nullptr;
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

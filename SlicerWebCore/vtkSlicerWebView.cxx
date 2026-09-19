/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

==============================================================================*/

#include "vtkSlicerWebView.h"

// MRML includes
#include <vtkMRMLAbstractViewNode.h>
#include <vtkMRMLApplicationLogic.h>
#include <vtkMRMLDisplayableManagerGroup.h>
#include <vtkMRMLScene.h>
#include <vtkMRMLViewInteractorStyle.h>

// VTK includes
#include <vtkCallbackCommand.h>
#include <vtkCommand.h>
#include <vtkNew.h>
#include <vtkObjectFactory.h>
#include <vtkRenderWindow.h>
#include <vtkRenderWindowInteractor.h>
#include <vtkRenderer.h>
#include <vtkWeakPointer.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/html5.h>
#include <vtkWebAssemblyOpenGLRenderWindow.h>
#include <vtkWebAssemblyRenderWindowInteractor.h>
#endif

//----------------------------------------------------------------------------
class vtkSlicerWebView::vtkInternal
{
public:
  vtkSmartPointer<vtkRenderWindow> RenderWindow;
  vtkSmartPointer<vtkRenderer> Renderer;
  vtkSmartPointer<vtkRenderWindowInteractor> Interactor;
  vtkSmartPointer<vtkMRMLDisplayableManagerGroup> DisplayableManagerGroup;
  vtkSmartPointer<vtkMRMLViewInteractorStyle> InteractorObserver;
  vtkWeakPointer<vtkMRMLAbstractViewNode> ViewNode;
  vtkWeakPointer<vtkMRMLScene> Scene;
  vtkWeakPointer<vtkMRMLApplicationLogic> AppLogic;
  int PauseRenderCount{ 0 };
  vtkNew<vtkCallbackCommand> SceneCallback;
  vtkNew<vtkCallbackCommand> RenderRequestCallback;
  bool Started{ false };
};

#ifdef __EMSCRIPTEN__
namespace
{
bool vtkSlicerWebViewAnimationFrame(double /*time*/, void* userData)
{
  vtkSlicerWebView* self = static_cast<vtkSlicerWebView*>(userData);
  self->ProcessScheduledRender();
  self->UnRegister(nullptr); // reference taken in ScheduleRender()
  return false;              // one-shot
}

bool vtkSlicerWebViewEventLoopTick(double /*time*/, void* userData)
{
  vtkSlicerWebView* self = static_cast<vtkSlicerWebView*>(userData);
  if (self->ProcessInteractorEvents())
  {
    return true; // keep processing events in the next animation frame
  }
  self->UnRegister(nullptr); // reference taken in Start()
  return false;
}
}
#endif

//----------------------------------------------------------------------------
vtkSlicerWebView::vtkSlicerWebView()
  : Internal(new vtkInternal)
{
  this->Internal->SceneCallback->SetClientData(this);
  this->Internal->SceneCallback->SetCallback(&vtkSlicerWebView::OnSceneEvent);
  this->Internal->RenderRequestCallback->SetClientData(this);
  this->Internal->RenderRequestCallback->SetCallback(&vtkSlicerWebView::OnRenderRequest);
}

//----------------------------------------------------------------------------
vtkSlicerWebView::~vtkSlicerWebView()
{
  // Subclass resources are released in their destructors (FinalizeView is virtual and
  // cannot be dispatched from here), so only release the common pipeline.
  if (this->Initialized)
  {
    this->Finalize();
  }
  this->SetCanvasSelector(nullptr);
  delete this->Internal;
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "CanvasSelector: " << (this->CanvasSelector ? this->CanvasSelector : "(none)") << "\n";
  os << indent << "Initialized: " << this->Initialized << "\n";
  os << indent << "RenderEnabled: " << this->RenderEnabled << "\n";
  os << indent << "RenderCount: " << this->RenderCount << "\n";
}

//----------------------------------------------------------------------------
bool vtkSlicerWebView::Initialize(vtkMRMLApplicationLogic* appLogic, vtkMRMLScene* scene, const char* layoutName)
{
  if (this->Initialized)
  {
    vtkWarningMacro("Initialize: view is already initialized");
    return true;
  }
  if (!appLogic || !scene || !layoutName)
  {
    vtkErrorMacro("Initialize: application logic, scene, and layout name are required");
    return false;
  }

  vtkInternal* d = this->Internal;
  d->RenderWindow = vtkSmartPointer<vtkRenderWindow>::New();
  d->Interactor = vtkSmartPointer<vtkRenderWindowInteractor>::New();
  d->Renderer = vtkSmartPointer<vtkRenderer>::New();

#ifdef __EMSCRIPTEN__
  if (!this->CanvasSelector)
  {
    vtkErrorMacro("Initialize: CanvasSelector must be set before Initialize");
    return false;
  }
  if (auto* glWindow = vtkWebAssemblyOpenGLRenderWindow::SafeDownCast(d->RenderWindow))
  {
    glWindow->SetCanvasSelector(this->CanvasSelector);
  }
  if (auto* wasmInteractor = vtkWebAssemblyRenderWindowInteractor::SafeDownCast(d->Interactor))
  {
    wasmInteractor->SetCanvasSelector(this->CanvasSelector);
    // The web application owns canvas layout and resizing (see SetSize()).
    wasmInteractor->SetExpandCanvasToContainer(false);
    wasmInteractor->SetInstallHTMLResizeObserver(false);
  }
#endif

  d->RenderWindow->SetMultiSamples(0);
  d->RenderWindow->SetAlphaBitPlanes(1);
  d->RenderWindow->AddRenderer(d->Renderer);
  d->Interactor->SetRenderWindow(d->RenderWindow);

  d->Scene = scene;
  scene->AddObserver(vtkMRMLScene::StartBatchProcessEvent, d->SceneCallback);
  scene->AddObserver(vtkMRMLScene::EndBatchProcessEvent, d->SceneCallback);
  d->AppLogic = appLogic;
  appLogic->AddObserver(vtkMRMLApplicationLogic::PauseRenderEvent, d->SceneCallback);
  appLogic->AddObserver(vtkMRMLApplicationLogic::ResumeRenderEvent, d->SceneCallback);

  if (!this->InitializeView(appLogic, scene, layoutName))
  {
    vtkErrorMacro("Initialize: failed to initialize view " << layoutName);
    scene->RemoveObserver(d->SceneCallback);
    appLogic->RemoveObserver(d->SceneCallback);
    return false;
  }

  if (d->DisplayableManagerGroup)
  {
    d->DisplayableManagerGroup->AddObserver(vtkCommand::UpdateEvent, d->RenderRequestCallback);
  }
  if (d->InteractorObserver)
  {
    d->InteractorObserver->SetInteractor(d->Interactor);
  }

  this->Initialized = true;
  this->RenderEnabled = !scene->IsBatchProcessing();

  // Create the WebGL context now: hardware picking and other operations fail without a context.
  d->Interactor->Initialize();
  this->Render();
  return true;
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::Start()
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized || d->Started)
  {
    return;
  }
  d->Started = true;
#ifdef __EMSCRIPTEN__
  // Each view processes its queued input events in its own requestAnimationFrame loop.
  // (vtkRenderWindowInteractor::Start() would use Emscripten's single global main loop, which
  // cannot be shared by several views, and blocks when Asyncify is not available.)
  this->Register(nullptr);
  emscripten_request_animation_frame_loop(vtkSlicerWebViewEventLoopTick, this);
#endif
}

//----------------------------------------------------------------------------
bool vtkSlicerWebView::ProcessInteractorEvents()
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized || !d->Started || !d->Interactor)
  {
    return false;
  }
  d->Interactor->ProcessEvents();
  return true;
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::Finalize()
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized)
  {
    return;
  }
  this->Initialized = false;
  if (d->Scene)
  {
    d->Scene->RemoveObserver(d->SceneCallback);
  }
  if (d->AppLogic)
  {
    d->AppLogic->RemoveObserver(d->SceneCallback);
  }
  if (d->DisplayableManagerGroup)
  {
    d->DisplayableManagerGroup->RemoveObserver(d->RenderRequestCallback);
    d->DisplayableManagerGroup->SetMRMLDisplayableNode(nullptr);
  }
  if (d->InteractorObserver)
  {
    d->InteractorObserver->SetInteractor(nullptr);
    d->InteractorObserver->SetDisplayableManagers(nullptr);
  }
  this->FinalizeView();
  d->DisplayableManagerGroup = nullptr;
  d->InteractorObserver = nullptr;
  if (d->Interactor)
  {
    if (d->Started)
    {
      d->Interactor->TerminateApp();
    }
    d->Interactor->SetRenderWindow(nullptr);
  }
  if (d->RenderWindow)
  {
    d->RenderWindow->Finalize(); // releases the WebGL context
  }
  d->Started = false;
  d->Interactor = nullptr;
  d->Renderer = nullptr;
  d->RenderWindow = nullptr;
  d->ViewNode = nullptr;
  d->Scene = nullptr;
  d->AppLogic = nullptr;
  d->PauseRenderCount = 0;
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::SetSize(int width, int height)
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized || width <= 0 || height <= 0)
  {
    return;
  }
  // The render window may already have the canvas size (it is read from the canvas when the window
  // is initialized), but the views must still update for it (e.g. slice node dimensions).
  const int* current = d->RenderWindow->GetSize();
  if (current[0] != width || current[1] != height)
  {
    d->Interactor->UpdateSize(width, height);
  }
  this->OnSizeChanged(width, height);
  this->ScheduleRender();
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::ScheduleRender()
{
  if (!this->Initialized)
  {
    return;
  }
  if (!this->RenderEnabled)
  {
    this->RenderPendingWhileDisabled = true;
    return;
  }
#ifdef __EMSCRIPTEN__
  if (this->RenderScheduled)
  {
    return;
  }
  this->RenderScheduled = true;
  this->Register(nullptr); // keep alive until the frame callback runs
  emscripten_request_animation_frame(vtkSlicerWebViewAnimationFrame, this);
#else
  this->Render();
#endif
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::ProcessScheduledRender()
{
  this->RenderScheduled = false;
  if (this->Initialized && this->RenderEnabled)
  {
    this->Render();
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::Render()
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized || !d->RenderWindow)
  {
    return;
  }
  d->RenderWindow->Render();
  ++this->RenderCount;
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::SetRenderEnabled(bool enabled)
{
  if (this->RenderEnabled == enabled)
  {
    return;
  }
  this->RenderEnabled = enabled;
  if (enabled && this->RenderPendingWhileDisabled)
  {
    this->RenderPendingWhileDisabled = false;
    this->ScheduleRender();
  }
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::OnSceneEvent(vtkObject* vtkNotUsed(caller), unsigned long eid, void* clientData, void* vtkNotUsed(callData))
{
  vtkSlicerWebView* self = static_cast<vtkSlicerWebView*>(clientData);
  if (eid == vtkMRMLScene::StartBatchProcessEvent)
  {
    self->SetRenderEnabled(false);
  }
  else if (eid == vtkMRMLScene::EndBatchProcessEvent)
  {
    self->RenderPendingWhileDisabled = true;
    self->SetRenderEnabled(self->Internal->PauseRenderCount == 0);
  }
  else if (eid == vtkMRMLApplicationLogic::PauseRenderEvent)
  {
    ++self->Internal->PauseRenderCount;
    self->SetRenderEnabled(false);
  }
  else if (eid == vtkMRMLApplicationLogic::ResumeRenderEvent)
  {
    if (self->Internal->PauseRenderCount > 0)
    {
      --self->Internal->PauseRenderCount;
    }
    if (self->Internal->PauseRenderCount == 0)
    {
      self->RenderPendingWhileDisabled = true;
      vtkMRMLScene* scene = self->Internal->Scene;
      self->SetRenderEnabled(!scene || !scene->IsBatchProcessing());
    }
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::OnRenderRequest(vtkObject* vtkNotUsed(caller), unsigned long vtkNotUsed(eid), void* clientData, void* vtkNotUsed(callData))
{
  static_cast<vtkSlicerWebView*>(clientData)->ScheduleRender();
}

//----------------------------------------------------------------------------
vtkRenderWindow* vtkSlicerWebView::GetRenderWindow()
{
  return this->Internal->RenderWindow;
}

//----------------------------------------------------------------------------
vtkRenderer* vtkSlicerWebView::GetRenderer()
{
  return this->Internal->Renderer;
}

//----------------------------------------------------------------------------
vtkRenderWindowInteractor* vtkSlicerWebView::GetInteractor()
{
  return this->Internal->Interactor;
}

//----------------------------------------------------------------------------
vtkMRMLDisplayableManagerGroup* vtkSlicerWebView::GetDisplayableManagerGroup()
{
  return this->Internal->DisplayableManagerGroup;
}

//----------------------------------------------------------------------------
vtkMRMLViewInteractorStyle* vtkSlicerWebView::GetInteractorObserver()
{
  return this->Internal->InteractorObserver;
}

//----------------------------------------------------------------------------
vtkMRMLAbstractViewNode* vtkSlicerWebView::GetViewNode()
{
  return this->Internal->ViewNode;
}

//----------------------------------------------------------------------------
vtkMRMLScene* vtkSlicerWebView::GetMRMLScene()
{
  return this->Internal->Scene;
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::SetViewNode(vtkMRMLAbstractViewNode* viewNode)
{
  this->Internal->ViewNode = viewNode;
  if (this->Internal->DisplayableManagerGroup)
  {
    this->Internal->DisplayableManagerGroup->SetMRMLDisplayableNode(viewNode);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::SetInteractorObserverInternal(vtkMRMLViewInteractorStyle* style)
{
  this->Internal->InteractorObserver = style;
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::SetDisplayableManagerGroupInternal(vtkMRMLDisplayableManagerGroup* group)
{
  this->Internal->DisplayableManagerGroup = group;
  if (this->Internal->InteractorObserver)
  {
    this->Internal->InteractorObserver->SetDisplayableManagers(group);
  }
}

/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

==============================================================================*/

#include "vtkSlicerWebView.h"
#include "vtkSlicerWebCanvas.h"
#include "vtkSlicerWebRenderWindowInteractor.h"

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
#include <vtkCamera.h>
#include <vtkRendererCollection.h>
#include <vtkRenderer.h>
#include <vtkWeakPointer.h>

#ifdef __EMSCRIPTEN__
#include "vtkSlicerWebSharedRenderWindow.h"
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
  /// The canvas this view shares with others, or none: then it has a canvas of its own
  vtkWeakPointer<vtkSlicerWebCanvas> Canvas;
  int PauseRenderCount{ 0 };
  vtkNew<vtkCallbackCommand> SceneCallback;
  vtkNew<vtkCallbackCommand> RenderRequestCallback;
  vtkNew<vtkCallbackCommand> GestureCallback;
  vtkNew<vtkCallbackCommand> ButtonPressCallback;
  bool InButtonPressHandler = false;
  /// Pan translation of the current touch gesture accumulated so far (see OnGestureEvent)
  double PanTranslation[2] = { 0.0, 0.0 };
  bool Started{ false };
  /// The size given before the view was initialized: it is made at that size
  int InitialSize[2] = { 0, 0 };
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
  this->Internal->GestureCallback->SetClientData(this->Internal);
  this->Internal->GestureCallback->SetCallback(&vtkSlicerWebView::OnGestureEvent);
  this->Internal->ButtonPressCallback->SetClientData(this->Internal);
  this->Internal->ButtonPressCallback->SetCallback(&vtkSlicerWebView::OnButtonPressEvent);
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
  d->Renderer = vtkSmartPointer<vtkRenderer>::New();
  d->Interactor.TakeReference(vtkSlicerWebRenderWindowInteractor::New());
#ifdef __EMSCRIPTEN__
  if (d->Canvas)
  {
    // A render window of the view's own, drawing with the shared canvas's context: to the view
    // and everything in it, it is a window of the view's size as on a canvas of its own. The
    // canvas shows what it renders, and sends it the input meant for it.
    if (!d->Canvas->GetInitialized() || !d->Canvas->GetContextId())
    {
      vtkErrorMacro("Initialize: the shared canvas is not initialized");
      return false;
    }
    vtkNew<vtkSlicerWebSharedRenderWindow> window;
    window->AdoptContext(d->Canvas->GetContextId());
    // The cursor is set on the canvas the view is shown on
    window->SetCanvasSelector(d->Canvas->GetCanvasSelector());
    d->RenderWindow = window;
    // Listens to nothing on the page: the canvas passes the events on
    if (auto* wasmInteractor = vtkWebAssemblyRenderWindowInteractor::SafeDownCast(d->Interactor))
    {
      wasmInteractor->SetCanvasSelector(nullptr);
    }
  }
  else
#endif
  {
    d->RenderWindow = vtkSmartPointer<vtkRenderWindow>::New();
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
  }

  d->RenderWindow->SetMultiSamples(0);
  d->RenderWindow->SetAlphaBitPlanes(1);
  if (d->InitialSize[0] > 0 && d->InitialSize[1] > 0)
  {
    // What the displayable managers build as the view is initialized - labels placed in
    // normalized viewport coordinates, for one - is built for the view's size, not a default one
    d->RenderWindow->SetSize(d->InitialSize[0], d->InitialSize[1]);
  }
  d->RenderWindow->AddRenderer(d->Renderer);
  d->Interactor->SetRenderWindow(d->RenderWindow);
  // Runs before the interactor style (priority 0), so that the widgets know what is under the pointer
  d->Interactor->AddObserver(vtkCommand::LeftButtonPressEvent, d->ButtonPressCallback, 100.0);
  d->Interactor->AddObserver(vtkCommand::StartPanEvent, d->GestureCallback, 100.0);
  d->Interactor->AddObserver(vtkCommand::PanEvent, d->GestureCallback, 100.0);

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

  if (d->Canvas)
  {
    // Set the window up in the shared context now: hardware picking and other operations fail
    // without one. The interactor only takes what the canvas sends it.
    d->RenderWindow->Initialize();
    static_cast<vtkSlicerWebRenderWindowInteractor*>(d->Interactor.GetPointer())->InitializeWithoutRendering();
    d->Canvas->AddView(this);
  }
  else
  {
    // Create the WebGL context now: hardware picking and other operations fail without a context.
    d->Interactor->Initialize();
  }
  if (d->InitialSize[0] > 0 && d->InitialSize[1] > 0)
  {
    const int width = d->InitialSize[0];
    const int height = d->InitialSize[1];
    d->InitialSize[0] = d->InitialSize[1] = 0;
    this->SetSize(width, height); // the views update for it (e.g. slice node dimensions)
  }
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
  if (d->Canvas)
  {
    d->Canvas->Start();   // one event loop for every view of the canvas
    return;
  }
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
  if (!this->Initialized || !d->Started || !d->Interactor || d->Canvas)
  {
    return false; // on a shared canvas, the canvas processes the events
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
  if (d->Canvas)
  {
    d->Canvas->RemoveView(this); // the canvas keeps its context for the other views
  }
  if (d->Interactor)
  {
    if (d->Started && !d->Canvas)
    {
      d->Interactor->TerminateApp();
    }
    d->Interactor->SetRenderWindow(nullptr);
  }
  if (d->RenderWindow)
  {
    // Releases the WebGL context, or on a shared canvas what the window made in the canvas's
    d->RenderWindow->Finalize();
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
  if (width <= 0 || height <= 0)
  {
    return;
  }
  if (!this->Initialized)
  {
    d->InitialSize[0] = width;
    d->InitialSize[1] = height;
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
  if (this->Internal->Canvas)
  {
    this->Internal->Canvas->ScheduleRender(this); // rendered and shown in the canvas's next frame
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
  // On a shared canvas, the canvas shows the frame once the window has rendered it
  d->RenderWindow->Render();
  ++this->RenderCount;
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::SetCanvas(vtkSlicerWebCanvas* canvas)
{
  if (this->Initialized)
  {
    vtkErrorMacro("SetCanvas: the canvas must be set before the view is initialized");
    return;
  }
  this->Internal->Canvas = canvas;
}

//----------------------------------------------------------------------------
vtkSlicerWebCanvas* vtkSlicerWebView::GetCanvas()
{
  return this->Internal->Canvas;
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
    // A scene that was closed and read again brings a new camera node, and with it a new camera
    // for the main renderer; the layers are pointed at it too.
    self->SyncLayerCameras();
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
void vtkSlicerWebView::SyncLayerCameras()
{
  vtkInternal* d = this->Internal;
  if (!d->RenderWindow || !d->Renderer)
  {
    return;
  }
  vtkCamera* camera = d->Renderer->GetActiveCamera();
  if (!camera)
  {
    return;
  }
  vtkRendererCollection* renderers = d->RenderWindow->GetRenderers();
  vtkCollectionSimpleIterator it;
  renderers->InitTraversal(it);
  while (vtkRenderer* renderer = renderers->GetNextRenderer(it))
  {
    if (renderer != d->Renderer && renderer->IsActiveCameraCreated() && renderer->GetActiveCamera() != camera)
    {
      renderer->SetActiveCamera(camera);
    }
  }
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

//----------------------------------------------------------------------------
void vtkSlicerWebView::OnGestureEvent(vtkObject* caller, unsigned long eid, void* clientData, void* vtkNotUsed(callData))
{
  // VTK's multi-touch gesture recognizer (vtkRenderWindowInteractor::RecognizeGesture) reports the
  // pan translation since the start of the gesture, while Slicer widgets (e.g.
  // vtkMRMLSliceIntersectionWidget::ProcessTouchTranslate, vtkMRMLCameraWidget) expect the
  // translation since the previous event, as Qt pan gestures provide it. Convert to increments.
  // (Scale and rotation are already used as differences of consecutive values.)
  vtkRenderWindowInteractor* interactor = vtkRenderWindowInteractor::SafeDownCast(caller);
  vtkInternal* d = static_cast<vtkInternal*>(clientData);
  if (!interactor || !d)
  {
    return;
  }
  if (eid == vtkCommand::StartPanEvent)
  {
    // The gesture's translation so far (vtkSlicerWebRenderWindowInteractor starts a gesture from
    // where the fingers are, not from where they touched)
    d->PanTranslation[0] = interactor->GetTranslation()[0];
    d->PanTranslation[1] = interactor->GetTranslation()[1];
    return;
  }
  const double* total = interactor->GetTranslation();
  double increment[2] = { total[0] - d->PanTranslation[0], total[1] - d->PanTranslation[1] };
  d->PanTranslation[0] = total[0];
  d->PanTranslation[1] = total[1];
  interactor->SetTranslation(increment);
}

//----------------------------------------------------------------------------
void vtkSlicerWebView::OnButtonPressEvent(vtkObject* caller, unsigned long vtkNotUsed(eid), void* clientData,
                                          void* vtkNotUsed(callData))
{
  // A touch screen has no pointer that moves before the press, while Slicer widgets act on what is
  // under the pointer (e.g. dragging the control point of a markup starts on a press on a control
  // point that the pointer is already over). A move event at the position of the press is sent
  // first, so that touch behaves like a mouse. (For a mouse, the pointer is already there.)
  vtkRenderWindowInteractor* interactor = vtkRenderWindowInteractor::SafeDownCast(caller);
  vtkInternal* d = static_cast<vtkInternal*>(clientData);
  if (!interactor || !d || d->InButtonPressHandler)
  {
    return;
  }
  d->InButtonPressHandler = true;
  interactor->InvokeEvent(vtkCommand::MouseMoveEvent);
  d->InButtonPressHandler = false;
}

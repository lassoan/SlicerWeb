/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

==============================================================================*/

#include "vtkSlicerWebCanvas.h"
#include "vtkSlicerWebRenderWindowInteractor.h"
#include "vtkSlicerWebView.h"

// MRML includes
#include <vtkMRMLViewInteractorStyle.h>

// VTK includes
#include <vtkCallbackCommand.h>
#include <vtkCommand.h>
#include <vtkInteractorStyleUser.h>
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

#include <algorithm>
#include <vector>

//----------------------------------------------------------------------------
namespace
{
struct ViewEntry
{
  vtkWeakPointer<vtkSlicerWebView> View;
  int Rect[4] = { 0, 0, 0, 0 }; // x, y, width, height in device pixels, from the top left
};
}

class vtkSlicerWebCanvas::vtkInternal
{
public:
  vtkSmartPointer<vtkRenderWindow> RenderWindow;
  vtkSmartPointer<vtkRenderWindowInteractor> Interactor;
  /// Clears the whole canvas, so that the gaps between the views do not keep what was drawn there
  vtkSmartPointer<vtkRenderer> BackgroundRenderer;
  std::vector<ViewEntry> Views;
  vtkWeakPointer<vtkSlicerWebView> ActiveView;
  vtkNew<vtkCallbackCommand> InteractorCallback;
  /// While a button is held the view that was pressed keeps the input, wherever the pointer goes
  bool PointerDown{ false };
  bool InButtonPressHandler{ false };
  /// Pan translation of the current touch gesture so far (see vtkSlicerWebView::OnGestureEvent)
  double PanTranslation[2] = { 0.0, 0.0 };
  int Size[2] = { 0, 0 };

  ViewEntry* Entry(vtkSlicerWebView* view)
  {
    for (auto& entry : this->Views)
    {
      if (entry.View == view)
      {
        return &entry;
      }
    }
    return nullptr;
  }
};

#ifdef __EMSCRIPTEN__
namespace
{
bool vtkSlicerWebCanvasAnimationFrame(double /*time*/, void* userData)
{
  vtkSlicerWebCanvas* self = static_cast<vtkSlicerWebCanvas*>(userData);
  self->ProcessScheduledRender();
  self->UnRegister(nullptr); // reference taken in ScheduleRender()
  return false;              // one-shot
}

bool vtkSlicerWebCanvasEventLoopTick(double /*time*/, void* userData)
{
  vtkSlicerWebCanvas* self = static_cast<vtkSlicerWebCanvas*>(userData);
  if (self->ProcessInteractorEvents())
  {
    return true;
  }
  self->UnRegister(nullptr); // reference taken in Start()
  return false;
}
}
#endif

vtkStandardNewMacro(vtkSlicerWebCanvas);

//----------------------------------------------------------------------------
vtkSlicerWebCanvas::vtkSlicerWebCanvas()
  : Internal(new vtkInternal)
{
  this->Internal->InteractorCallback->SetClientData(this);
  this->Internal->InteractorCallback->SetCallback(&vtkSlicerWebCanvas::OnInteractorEvent);
}

//----------------------------------------------------------------------------
vtkSlicerWebCanvas::~vtkSlicerWebCanvas()
{
  if (this->Initialized)
  {
    this->Finalize();
  }
  this->SetCanvasSelector(nullptr);
  delete this->Internal;
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "CanvasSelector: " << (this->CanvasSelector ? this->CanvasSelector : "(none)") << "\n";
  os << indent << "Initialized: " << this->Initialized << "\n";
  os << indent << "Views: " << this->Internal->Views.size() << "\n";
  os << indent << "RenderCount: " << this->RenderCount << "\n";
}

//----------------------------------------------------------------------------
bool vtkSlicerWebCanvas::Initialize()
{
  if (this->Initialized)
  {
    return true;
  }
  vtkInternal* d = this->Internal;
  d->RenderWindow = vtkSmartPointer<vtkRenderWindow>::New();
  d->Interactor.TakeReference(vtkSlicerWebRenderWindowInteractor::New());

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

  // Behind the views: clears the whole canvas, so the gaps between them are not left with
  // whatever the last frame put there (a renderer only clears its own viewport).
  d->BackgroundRenderer = vtkSmartPointer<vtkRenderer>::New();
  d->BackgroundRenderer->SetBackground(0.0, 0.0, 0.0);
  d->BackgroundRenderer->SetViewport(0.0, 0.0, 1.0, 1.0);
  d->BackgroundRenderer->InteractiveOff();
  d->RenderWindow->AddRenderer(d->BackgroundRenderer);

  d->Interactor->SetRenderWindow(d->RenderWindow);
  vtkNew<vtkInteractorStyleUser> interactorStyle;
  d->Interactor->SetInteractorStyle(interactorStyle);
  // Before the views' own styles (priority 0): what the event is, and which view it belongs to,
  // is settled first.
  for (unsigned long event : { static_cast<unsigned long>(vtkCommand::MouseMoveEvent),
                               static_cast<unsigned long>(vtkCommand::LeftButtonPressEvent),
                               static_cast<unsigned long>(vtkCommand::MiddleButtonPressEvent),
                               static_cast<unsigned long>(vtkCommand::RightButtonPressEvent),
                               static_cast<unsigned long>(vtkCommand::LeftButtonReleaseEvent),
                               static_cast<unsigned long>(vtkCommand::MiddleButtonReleaseEvent),
                               static_cast<unsigned long>(vtkCommand::RightButtonReleaseEvent),
                               static_cast<unsigned long>(vtkCommand::MouseWheelForwardEvent),
                               static_cast<unsigned long>(vtkCommand::MouseWheelBackwardEvent),
                               static_cast<unsigned long>(vtkCommand::StartPanEvent),
                               static_cast<unsigned long>(vtkCommand::PanEvent) })
  {
    d->Interactor->AddObserver(event, d->InteractorCallback, 100.0);
  }

  this->Initialized = true;
  d->Interactor->Initialize(); // creates the WebGL context
  return true;
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::Finalize()
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized)
  {
    return;
  }
  this->Initialized = false;
  this->SetActiveView(nullptr);
  d->Views.clear();
  if (d->Interactor)
  {
    d->Interactor->RemoveObserver(d->InteractorCallback);
    if (this->Started)
    {
      d->Interactor->TerminateApp();
    }
    d->Interactor->SetRenderWindow(nullptr);
  }
  if (d->RenderWindow)
  {
    d->RenderWindow->Finalize(); // releases the WebGL context
  }
  this->Started = false;
  d->BackgroundRenderer = nullptr;
  d->Interactor = nullptr;
  d->RenderWindow = nullptr;
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::Start()
{
  if (!this->Initialized || this->Started)
  {
    return;
  }
  this->Started = true;
#ifdef __EMSCRIPTEN__
  this->Register(nullptr);
  emscripten_request_animation_frame_loop(vtkSlicerWebCanvasEventLoopTick, this);
#endif
}

//----------------------------------------------------------------------------
bool vtkSlicerWebCanvas::ProcessInteractorEvents()
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized || !this->Started || !d->Interactor)
  {
    return false;
  }
  d->Interactor->ProcessEvents();
  return true;
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::SetSize(int width, int height)
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized || width <= 0 || height <= 0)
  {
    return;
  }
  d->Size[0] = width;
  d->Size[1] = height;
  const int* current = d->RenderWindow->GetSize();
  if (current[0] != width || current[1] != height)
  {
    d->Interactor->UpdateSize(width, height);
  }
  // Every view keeps the same rectangle of the canvas, which is now a different part of it
  for (auto& entry : d->Views)
  {
    if (entry.View)
    {
      this->SetViewRect(entry.View, entry.Rect[0], entry.Rect[1], entry.Rect[2], entry.Rect[3]);
    }
  }
  this->ScheduleRender();
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::SetViewRect(vtkSlicerWebView* view, int x, int y, int width, int height)
{
  vtkInternal* d = this->Internal;
  ViewEntry* entry = d->Entry(view);
  if (!entry || width <= 0 || height <= 0)
  {
    return;
  }
  entry->Rect[0] = x;
  entry->Rect[1] = y;
  entry->Rect[2] = width;
  entry->Rect[3] = height;
  const double canvasWidth = d->Size[0] > 0 ? d->Size[0] : (d->RenderWindow ? d->RenderWindow->GetSize()[0] : 0);
  const double canvasHeight = d->Size[1] > 0 ? d->Size[1] : (d->RenderWindow ? d->RenderWindow->GetSize()[1] : 0);
  if (canvasWidth <= 0 || canvasHeight <= 0)
  {
    return;
  }
  vtkRenderer* renderer = view->GetRenderer();
  if (renderer)
  {
    // The page measures from the top left, a viewport from the bottom left
    renderer->SetViewport(x / canvasWidth, 1.0 - (y + height) / canvasHeight, (x + width) / canvasWidth, 1.0 - y / canvasHeight);
  }
  view->SetSize(width, height);
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::AddView(vtkSlicerWebView* view)
{
  vtkInternal* d = this->Internal;
  if (!view || d->Entry(view))
  {
    return;
  }
  ViewEntry entry;
  entry.View = view;
  d->Views.push_back(entry);
  if (d->RenderWindow && view->GetRenderer())
  {
    d->RenderWindow->AddRenderer(view->GetRenderer());
  }
  // Until the pointer says otherwise, the first view takes the input
  if (!d->ActiveView)
  {
    this->SetActiveView(view);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::RemoveView(vtkSlicerWebView* view)
{
  vtkInternal* d = this->Internal;
  if (!view)
  {
    return;
  }
  if (d->ActiveView == view)
  {
    this->SetActiveView(nullptr);
  }
  if (d->RenderWindow && view->GetRenderer())
  {
    d->RenderWindow->RemoveRenderer(view->GetRenderer());
  }
  d->Views.erase(std::remove_if(d->Views.begin(), d->Views.end(),
                                [view](const ViewEntry& entry) { return entry.View == view || entry.View == nullptr; }),
                 d->Views.end());
  if (!d->ActiveView && !d->Views.empty())
  {
    this->SetActiveView(d->Views.front().View);
  }
  this->ScheduleRender();
}

//----------------------------------------------------------------------------
int vtkSlicerWebCanvas::GetNumberOfViews()
{
  return static_cast<int>(this->Internal->Views.size());
}

//----------------------------------------------------------------------------
vtkSlicerWebView* vtkSlicerWebCanvas::GetViewAt(int x, int y)
{
  vtkInternal* d = this->Internal;
  // The interactor reports positions from the bottom left, the rectangles are kept as the page
  // measures them
  const int fromTop = d->Size[1] > 0 ? d->Size[1] - y : y;
  for (auto& entry : d->Views)
  {
    if (!entry.View)
    {
      continue;
    }
    if (x >= entry.Rect[0] && x < entry.Rect[0] + entry.Rect[2] && //
        fromTop >= entry.Rect[1] && fromTop < entry.Rect[1] + entry.Rect[3])
    {
      return entry.View;
    }
  }
  return nullptr;
}

//----------------------------------------------------------------------------
vtkSlicerWebView* vtkSlicerWebCanvas::GetActiveView()
{
  return this->Internal->ActiveView;
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::SetActiveView(vtkSlicerWebView* view)
{
  vtkInternal* d = this->Internal;
  // A view's interactor style observes the interactor while the view has the input, and not
  // otherwise: every style of the canvas would answer every event, and a widget of another view
  // would take what was meant for this one.
  if (d->ActiveView != view)
  {
    if (d->ActiveView && d->ActiveView->GetInteractorObserver())
    {
      d->ActiveView->GetInteractorObserver()->SetInteractor(nullptr);
    }
    d->ActiveView = view;
  }
  // Also when the view was already the active one: a view joins the canvas before it has built
  // its interactor style (the style is made while the view initializes), so the style of the
  // first view is attached here, at the first event it is meant to answer.
  if (view && view->GetInteractorObserver())
  {
    view->GetInteractorObserver()->SetInteractor(d->Interactor);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::UpdateActiveView()
{
  vtkInternal* d = this->Internal;
  if (d->PointerDown)
  {
    return; // a drag belongs to the view it started in
  }
  const int* position = d->Interactor ? d->Interactor->GetEventPosition() : nullptr;
  if (!position)
  {
    return;
  }
  vtkSlicerWebView* view = this->GetViewAt(position[0], position[1]);
  if (view)
  {
    this->SetActiveView(view);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::OnInteractorEvent(vtkObject* caller, unsigned long eid, void* clientData, void* vtkNotUsed(callData))
{
  vtkSlicerWebCanvas* self = static_cast<vtkSlicerWebCanvas*>(clientData);
  vtkRenderWindowInteractor* interactor = vtkRenderWindowInteractor::SafeDownCast(caller);
  vtkInternal* d = self->Internal;
  if (!interactor)
  {
    return;
  }
  if (eid == vtkCommand::StartPanEvent || eid == vtkCommand::PanEvent)
  {
    // The pan of a touch gesture is reported from where the fingers touched, while the widgets
    // expect the change since the previous event (see vtkSlicerWebView::OnGestureEvent).
    if (eid == vtkCommand::StartPanEvent)
    {
      d->PanTranslation[0] = interactor->GetTranslation()[0];
      d->PanTranslation[1] = interactor->GetTranslation()[1];
      return;
    }
    const double* total = interactor->GetTranslation();
    double increment[2] = { total[0] - d->PanTranslation[0], total[1] - d->PanTranslation[1] };
    d->PanTranslation[0] = total[0];
    d->PanTranslation[1] = total[1];
    interactor->SetTranslation(increment);
    return;
  }

  const bool press = eid == vtkCommand::LeftButtonPressEvent || eid == vtkCommand::MiddleButtonPressEvent || //
                     eid == vtkCommand::RightButtonPressEvent;
  const bool release = eid == vtkCommand::LeftButtonReleaseEvent || eid == vtkCommand::MiddleButtonReleaseEvent || //
                       eid == vtkCommand::RightButtonReleaseEvent;
  if (release)
  {
    d->PointerDown = false;
  }
  self->UpdateActiveView();
  if (press)
  {
    d->PointerDown = true;
    // A touch screen has no pointer that moves before the press, while the widgets act on what is
    // under the pointer: a move at the position of the press is sent first, so that touch behaves
    // like a mouse (see vtkSlicerWebView::OnButtonPressEvent).
    if (!d->InButtonPressHandler)
    {
      d->InButtonPressHandler = true;
      interactor->InvokeEvent(vtkCommand::MouseMoveEvent);
      d->InButtonPressHandler = false;
    }
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::ScheduleRender()
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
  emscripten_request_animation_frame(vtkSlicerWebCanvasAnimationFrame, this);
#else
  this->Render();
#endif
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::ProcessScheduledRender()
{
  this->RenderScheduled = false;
  if (this->Initialized && this->RenderEnabled)
  {
    this->Render();
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::Render()
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
void vtkSlicerWebCanvas::SetRenderEnabled(bool enabled)
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
vtkRenderWindow* vtkSlicerWebCanvas::GetRenderWindow()
{
  return this->Internal->RenderWindow;
}

//----------------------------------------------------------------------------
vtkRenderWindowInteractor* vtkSlicerWebCanvas::GetInteractor()
{
  return this->Internal->Interactor;
}

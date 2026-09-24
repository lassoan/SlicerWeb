/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

==============================================================================*/

#include "vtkSlicerWebCanvas.h"
#include "vtkSlicerWebRenderWindowInteractor.h"
#include "vtkSlicerWebView.h"

// VTK includes
#include <vtkCallbackCommand.h>
#include <vtkCommand.h>
#include <vtkNew.h>
#include <vtkObjectFactory.h>
#include <vtkRenderWindow.h>
#include <vtkRenderWindowInteractor.h>
#include <vtkWeakPointer.h>

#ifdef __EMSCRIPTEN__
#include "vtkSlicerWebSharedRenderWindow.h"
#include <emscripten/html5.h>
#include <vtkWebAssemblyOpenGLRenderWindow.h>
#include <vtkWebAssemblyRenderWindowInteractor.h>
#endif

#include <algorithm>
#include <cstdint>
#include <vector>

//----------------------------------------------------------------------------
namespace
{
struct ViewEntry
{
  vtkWeakPointer<vtkSlicerWebView> View;
  int Rect[4] = { 0, 0, 0, 0 }; // x, y, width, height in device pixels, from the top left
  /// The view is to be rendered in the next animation frame
  bool RenderRequested{ false };
};

bool IsButtonPress(unsigned long eid)
{
  return eid == vtkCommand::LeftButtonPressEvent || eid == vtkCommand::MiddleButtonPressEvent ||
         eid == vtkCommand::RightButtonPressEvent;
}

bool IsButtonRelease(unsigned long eid)
{
  return eid == vtkCommand::LeftButtonReleaseEvent || eid == vtkCommand::MiddleButtonReleaseEvent ||
         eid == vtkCommand::RightButtonReleaseEvent;
}

bool IsKey(unsigned long eid)
{
  return eid == vtkCommand::KeyPressEvent || eid == vtkCommand::KeyReleaseEvent || eid == vtkCommand::CharEvent;
}
}

class vtkSlicerWebCanvas::vtkInternal
{
public:
  /// Holds the context; nothing is rendered with it
  vtkSmartPointer<vtkRenderWindow> RenderWindow;
  /// Listens to the page
  vtkSmartPointer<vtkRenderWindowInteractor> Interactor;
  std::vector<ViewEntry> Views;
  /// The view input goes to: the one under the pointer, or the one a drag started in
  vtkWeakPointer<vtkSlicerWebView> ActiveView;
  vtkNew<vtkCallbackCommand> InteractorCallback;
  vtkNew<vtkCallbackCommand> ViewRenderedCallback;
  /// Buttons (or fingers) held down: while any is, the view that was pressed keeps the input
  int ButtonsDown{ 0 };
  /// A view rendered since the canvas last showed them
  bool PresentRequested{ false };
  /// In the animation frame callback: the views' renders are shown at its end
  bool InFrame{ false };
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

  /// Where the view's window has its origin on the canvas, from the bottom left
  void Origin(const ViewEntry& entry, int origin[2])
  {
    origin[0] = entry.Rect[0];
    origin[1] = this->Size[1] - (entry.Rect[1] + entry.Rect[3]);
  }
};

#ifdef __EMSCRIPTEN__
namespace
{
bool vtkSlicerWebCanvasAnimationFrame(double /*time*/, void* userData)
{
  vtkSlicerWebCanvas* self = static_cast<vtkSlicerWebCanvas*>(userData);
  self->ProcessScheduledRender();
  self->UnRegister(nullptr); // reference taken in RequestAnimationFrame()
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
  this->Internal->ViewRenderedCallback->SetClientData(this);
  this->Internal->ViewRenderedCallback->SetCallback(&vtkSlicerWebCanvas::OnViewRendered);
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
#ifdef __EMSCRIPTEN__
  vtkInternal* d = this->Internal;
  if (!this->CanvasSelector)
  {
    vtkErrorMacro("Initialize: CanvasSelector must be set before Initialize");
    return false;
  }
  vtkNew<vtkWebAssemblyOpenGLRenderWindow> window;
  window->SetCanvasSelector(this->CanvasSelector);
  window->SetMultiSamples(0);
  window->Initialize(); // creates the WebGL context
  if (!window->GetGenericDisplayId())
  {
    vtkErrorMacro("Initialize: could not create a WebGL context on " << this->CanvasSelector);
    return false;
  }
  // The window has just set the state of the context up: the views' windows take it afresh
  vtkSlicerWebSharedRenderWindow::ContextUsedElsewhere();
  d->RenderWindow = window;

  vtkNew<vtkSlicerWebRenderWindowInteractor> interactor;
  interactor->SetCanvasSelector(this->CanvasSelector);
  // The web application owns canvas layout and resizing (see SetSize()).
  interactor->SetExpandCanvasToContainer(false);
  interactor->SetInstallHTMLResizeObserver(false);
  // Only passes the events on: the views' interactors make gestures of touches, and their
  // styles act on them
  interactor->SetRecognizeGestures(false);
  interactor->SetInteractorStyle(nullptr);
  interactor->SetRenderWindow(window);
  interactor->InitializeWithoutRendering();
  d->Interactor = interactor;
  for (unsigned long event : { static_cast<unsigned long>(vtkCommand::MouseMoveEvent),
                               static_cast<unsigned long>(vtkCommand::LeftButtonPressEvent),
                               static_cast<unsigned long>(vtkCommand::MiddleButtonPressEvent),
                               static_cast<unsigned long>(vtkCommand::RightButtonPressEvent),
                               static_cast<unsigned long>(vtkCommand::LeftButtonReleaseEvent),
                               static_cast<unsigned long>(vtkCommand::MiddleButtonReleaseEvent),
                               static_cast<unsigned long>(vtkCommand::RightButtonReleaseEvent),
                               static_cast<unsigned long>(vtkCommand::LeftButtonDoubleClickEvent),
                               static_cast<unsigned long>(vtkCommand::MiddleButtonDoubleClickEvent),
                               static_cast<unsigned long>(vtkCommand::RightButtonDoubleClickEvent),
                               static_cast<unsigned long>(vtkCommand::MouseWheelForwardEvent),
                               static_cast<unsigned long>(vtkCommand::MouseWheelBackwardEvent),
                               static_cast<unsigned long>(vtkCommand::MouseWheelLeftEvent),
                               static_cast<unsigned long>(vtkCommand::MouseWheelRightEvent),
                               static_cast<unsigned long>(vtkCommand::KeyPressEvent),
                               static_cast<unsigned long>(vtkCommand::KeyReleaseEvent),
                               static_cast<unsigned long>(vtkCommand::CharEvent),
                               static_cast<unsigned long>(vtkCommand::EnterEvent),
                               static_cast<unsigned long>(vtkCommand::LeaveEvent) })
  {
    d->Interactor->AddObserver(event, d->InteractorCallback);
  }
  this->Initialized = true;
  return true;
#else
  vtkErrorMacro("Initialize: a shared canvas is only available in the browser");
  return false;
#endif
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
  d->ActiveView = nullptr;
  for (auto& entry : d->Views)
  {
    if (entry.View && entry.View->GetRenderWindow())
    {
      entry.View->GetRenderWindow()->RemoveObserver(d->ViewRenderedCallback);
    }
  }
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
  // Sizes the canvas element's drawing buffer, and tells the interactor how tall it is (positions
  // are reported from the bottom)
  d->Interactor->UpdateSize(width, height);
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
  view->SetSize(width, height); // the size of the view's own window
  // The view may be the same size in another place: the canvas is drawn again either way
  this->ScheduleRender(view);
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
  if (view->GetRenderWindow())
  {
    view->GetRenderWindow()->AddObserver(vtkCommand::EndEvent, d->ViewRenderedCallback);
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
    d->ActiveView = nullptr;
    d->ButtonsDown = 0;
  }
  if (view->GetRenderWindow())
  {
    view->GetRenderWindow()->RemoveObserver(d->ViewRenderedCallback);
  }
  d->Views.erase(std::remove_if(d->Views.begin(), d->Views.end(),
                                [view](const ViewEntry& entry) { return entry.View == view || entry.View == nullptr; }),
                 d->Views.end());
  // What the view showed is cleared from the canvas
  d->PresentRequested = true;
  this->RequestAnimationFrame();
}

//----------------------------------------------------------------------------
int vtkSlicerWebCanvas::GetNumberOfViews()
{
  return static_cast<int>(this->Internal->Views.size());
}

//----------------------------------------------------------------------------
unsigned long vtkSlicerWebCanvas::GetContextId()
{
  vtkInternal* d = this->Internal;
  if (!d->RenderWindow)
  {
    return 0;
  }
  return static_cast<unsigned long>(reinterpret_cast<std::uintptr_t>(d->RenderWindow->GetGenericDisplayId()));
}

//----------------------------------------------------------------------------
vtkSlicerWebView* vtkSlicerWebCanvas::GetViewAt(int x, int y)
{
  vtkInternal* d = this->Internal;
  // The interactor reports positions from the bottom left, the rectangles are kept as the page
  // measures them
  const int fromTop = d->Size[1] - y;
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
  if (d->ActiveView == view)
  {
    return;
  }
  // The pointer leaves one view and enters another, as it would pass from one canvas to the next
  if (d->ActiveView)
  {
    this->ForwardEvent(d->ActiveView, vtkCommand::LeaveEvent);
  }
  d->ActiveView = view;
  if (view)
  {
    this->ForwardEvent(view, vtkCommand::EnterEvent);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::ForwardEvent(vtkSlicerWebView* view, unsigned long eid)
{
  vtkInternal* d = this->Internal;
  ViewEntry* entry = d->Entry(view);
  vtkRenderWindowInteractor* from = d->Interactor;
  vtkRenderWindowInteractor* to = view ? view->GetInteractor() : nullptr;
  if (!entry || !from || !to)
  {
    return;
  }
  // Every pointer (finger) at its position in the view's window, which starts at the view's
  // corner of the canvas: outside of the view, during a drag, the position is outside the window,
  // as it would be for a canvas that has captured the pointer.
  int origin[2];
  d->Origin(*entry, origin);
  const int lastPointer = std::max(0, std::min(from->GetPointerIndex(), VTKI_MAX_POINTERS - 1));
  for (int i = 0; i <= lastPointer; ++i)
  {
    const int* position = from->GetEventPositions(i);
    to->SetEventInformation(position[0] - origin[0], position[1] - origin[1], from->GetControlKey(), from->GetShiftKey(),
                            from->GetKeyCode(), from->GetRepeatCount(), from->GetKeySym(), i);
  }
  to->SetAltKey(from->GetAltKey());

  switch (eid)
  {
    // As the page's events come to an interactor of a canvas of the view's own: through the
    // methods that make gestures of touches
    case vtkCommand::MouseMoveEvent:
      to->MouseMoveEvent();
      break;
    case vtkCommand::LeftButtonPressEvent:
      to->LeftButtonPressEvent();
      break;
    case vtkCommand::LeftButtonReleaseEvent:
      to->LeftButtonReleaseEvent();
      break;
    case vtkCommand::MiddleButtonPressEvent:
      to->MiddleButtonPressEvent();
      break;
    case vtkCommand::MiddleButtonReleaseEvent:
      to->MiddleButtonReleaseEvent();
      break;
    case vtkCommand::RightButtonPressEvent:
      to->RightButtonPressEvent();
      break;
    case vtkCommand::RightButtonReleaseEvent:
      to->RightButtonReleaseEvent();
      break;
    default:
      to->InvokeEvent(eid, nullptr);
      break;
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::OnInteractorEvent(vtkObject* vtkNotUsed(caller), unsigned long eid, void* clientData,
                                           void* vtkNotUsed(callData))
{
  vtkSlicerWebCanvas* self = static_cast<vtkSlicerWebCanvas*>(clientData);
  vtkInternal* d = self->Internal;
  if (!d->Interactor)
  {
    return;
  }
  if (eid == vtkCommand::EnterEvent)
  {
    return; // the view the pointer is over is entered when the pointer moves
  }
  if (eid == vtkCommand::LeaveEvent)
  {
    if (d->ButtonsDown == 0)
    {
      self->SetActiveView(nullptr);
    }
    return;
  }
  if (IsKey(eid))
  {
    // Keys go to the view the pointer was last over
    if (d->ActiveView)
    {
      self->ForwardEvent(d->ActiveView, eid);
    }
    return;
  }

  if (d->ButtonsDown == 0)
  {
    // Nothing held: the input goes to the view under the pointer. (While a button is held, the
    // view it was pressed in keeps the input, wherever the pointer goes.)
    const int* position = d->Interactor->GetEventPosition();
    self->SetActiveView(self->GetViewAt(position[0], position[1]));
  }
  vtkSlicerWebView* view = d->ActiveView;
  if (IsButtonPress(eid))
  {
    ++d->ButtonsDown;
  }
  else if (IsButtonRelease(eid))
  {
    d->ButtonsDown = std::max(0, d->ButtonsDown - 1);
  }
  if (view)
  {
    self->ForwardEvent(view, eid);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::OnViewRendered(vtkObject* vtkNotUsed(caller), unsigned long vtkNotUsed(eid), void* clientData,
                                        void* vtkNotUsed(callData))
{
  // A view has rendered (whoever asked it to): the canvas shows it in the next animation frame, or
  // at the end of this one.
  vtkSlicerWebCanvas* self = static_cast<vtkSlicerWebCanvas*>(clientData);
  self->Internal->PresentRequested = true;
  if (!self->Internal->InFrame)
  {
    self->RequestAnimationFrame();
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::ScheduleRender(vtkSlicerWebView* view)
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized)
  {
    return;
  }
  for (auto& entry : d->Views)
  {
    if (!view || entry.View == view)
    {
      entry.RenderRequested = true;
    }
  }
  d->PresentRequested = true;
  this->RequestAnimationFrame();
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::RequestAnimationFrame()
{
  if (!this->Initialized || this->RenderScheduled)
  {
    return;
  }
#ifdef __EMSCRIPTEN__
  this->RenderScheduled = true;
  this->Register(nullptr); // keep alive until the frame callback runs
  emscripten_request_animation_frame(vtkSlicerWebCanvasAnimationFrame, this);
#else
  this->ProcessScheduledRender();
#endif
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::ProcessScheduledRender()
{
  vtkInternal* d = this->Internal;
  this->RenderScheduled = false;
  if (!this->Initialized)
  {
    return;
  }
  d->InFrame = true;
  // Views may leave (and the list change) while one renders
  std::vector<vtkWeakPointer<vtkSlicerWebView>> toRender;
  for (auto& entry : d->Views)
  {
    if (entry.RenderRequested && entry.View)
    {
      toRender.push_back(entry.View);
    }
    entry.RenderRequested = false;
  }
  for (auto& view : toRender)
  {
    if (view)
    {
      view->ProcessScheduledRender();
    }
  }
  d->InFrame = false;
  if (d->PresentRequested)
  {
    this->Present();
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::Render()
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized)
  {
    return;
  }
  for (auto& entry : d->Views)
  {
    entry.RenderRequested = true;
  }
  this->ProcessScheduledRender();
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::Present()
{
  vtkInternal* d = this->Internal;
  if (!this->Initialized || !this->RenderEnabled)
  {
    return;
  }
  d->PresentRequested = false;
#ifdef __EMSCRIPTEN__
  // A WebGL canvas keeps a frame only until it is shown on the page: every view is copied into it
  // each time, not only the one that rendered.
  bool cleared = false;
  for (auto& entry : d->Views)
  {
    auto* window = entry.View ? vtkSlicerWebSharedRenderWindow::SafeDownCast(entry.View->GetRenderWindow()) : nullptr;
    if (!window)
    {
      continue;
    }
    if (!cleared)
    {
      window->ClearCanvas(d->Size[0], d->Size[1]);
      cleared = true;
    }
    int origin[2];
    d->Origin(entry, origin);
    window->BlitToCanvas(origin[0], origin[1]);
  }
  ++this->RenderCount;
#endif
}

//----------------------------------------------------------------------------
void vtkSlicerWebCanvas::SetRenderEnabled(bool enabled)
{
  if (this->RenderEnabled == enabled)
  {
    return;
  }
  this->RenderEnabled = enabled;
  if (enabled)
  {
    this->Internal->PresentRequested = true;
    this->RequestAnimationFrame();
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

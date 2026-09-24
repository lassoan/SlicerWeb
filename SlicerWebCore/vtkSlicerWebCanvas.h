/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

  One <canvas> and one WebGL context shared by several views.

==============================================================================*/

#ifndef vtkSlicerWebCanvas_h
#define vtkSlicerWebCanvas_h

#include "vtkSlicerWebCoreExport.h"

#include <vtkObject.h>
#include <vtkSmartPointer.h>

class vtkRenderWindow;
class vtkRenderWindowInteractor;
class vtkSlicerWebView;

/// \brief A canvas that several views are shown in, each in its own rectangle of it.
///
/// A browser allows only so many WebGL contexts at a time - about eight on a phone - and a view
/// of its own canvas costs one each, so a layout of nine slice views cannot be shown. Views that
/// share a canvas share its context, and its cost is paid once rather than once per view.
///
/// Only the context is shared. Every view keeps a render window of its own, the size of its
/// rectangle, with its own renderers, interactor, interactor style and displayable managers -
/// exactly what it has on a canvas of its own, since Slicer takes a view to be a whole window
/// (display coordinates, layer renderers, widgets sized by the window all rely on it). The view's
/// window renders into framebuffers of its own in the shared context
/// (vtkSlicerWebSharedRenderWindow), and the canvas copies each view's last frame into its
/// rectangle.
///
/// The canvas listens to the page: what the pointer and the keyboard do is sent to the view the
/// pointer is over, in that view's coordinates, and a drag stays with the view it started in
/// wherever the pointer goes, as if the view had captured the pointer.
///
/// Typical use (from Python, through slicerweb.layout):
///   canvas = slicer.vtkSlicerWebCanvas()
///   canvas.SetCanvasSelector("#slicer-views")
///   canvas.Initialize()
///   view.SetCanvas(canvas)                     # before Initialize()
///   view.Initialize(appLogic, scene, "Red")
///   canvas.SetViewRect(view, x, y, width, height)   # device pixels, from the top left
class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebCanvas : public vtkObject
{
public:
  static vtkSlicerWebCanvas* New();
  vtkTypeMacro(vtkSlicerWebCanvas, vtkObject);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// CSS selector of the <canvas> element drawn into. Must be set before Initialize().
  vtkSetStringMacro(CanvasSelector);
  vtkGetStringMacro(CanvasSelector);

  /// Create the context and start listening to the page. Returns false on failure.
  bool Initialize();
  vtkGetMacro(Initialized, bool);

  /// Release the context. The views are finalized by their owner first.
  void Finalize();

  /// Start processing input events (non-blocking; driven by requestAnimationFrame).
  void Start();

  /// The whole canvas, in device pixels (canvas.width/height).
  void SetSize(int width, int height);

  /// Where a view sits on the canvas, in device pixels from the top left corner, as the page
  /// measures it. The view is told its new size.
  void SetViewRect(vtkSlicerWebView* view, int x, int y, int width, int height);

  /// Views join and leave as they are initialized and finalized (called by vtkSlicerWebView).
  void AddView(vtkSlicerWebView* view);
  void RemoveView(vtkSlicerWebView* view);
  int GetNumberOfViews();

  /// The WebGL context that the views' windows draw with.
  unsigned long GetContextId();

  /// Render the view (none: every view) in the next animation frame, and show it.
  void ScheduleRender(vtkSlicerWebView* view = nullptr);
  /// Render every view now, and show them.
  void Render();

  /// Copy the views' last frames into the canvas (after any of them rendered).
  void Present();

  /// Showing frames is off while the scene is being loaded or a batch is running.
  void SetRenderEnabled(bool enabled);
  vtkGetMacro(RenderEnabled, bool);

  /// The window holding the context (it has no renderers: nothing is drawn with it).
  vtkRenderWindow* GetRenderWindow();
  /// The interactor listening to the page.
  vtkRenderWindowInteractor* GetInteractor();

  /// The view at this position of the canvas (device pixels, from the bottom left, as the
  /// interactor reports positions), and the one input is being sent to.
  vtkSlicerWebView* GetViewAt(int x, int y);
  vtkSlicerWebView* GetActiveView();

  /// Number of times the views were shown on the canvas (for diagnostics and tests).
  vtkGetMacro(RenderCount, int);

  /// Internal: called from the animation frame callbacks.
  void ProcessScheduledRender();
  bool ProcessInteractorEvents();

protected:
  vtkSlicerWebCanvas();
  ~vtkSlicerWebCanvas() override;

  void RequestAnimationFrame();
  void SetActiveView(vtkSlicerWebView* view);
  /// Send the event the page's interactor has just received to the view's own interactor.
  void ForwardEvent(vtkSlicerWebView* view, unsigned long eid);
  static void OnInteractorEvent(vtkObject* caller, unsigned long eid, void* clientData, void* callData);
  static void OnViewRendered(vtkObject* caller, unsigned long eid, void* clientData, void* callData);

  char* CanvasSelector{ nullptr };
  bool Initialized{ false };
  bool RenderEnabled{ true };
  bool RenderScheduled{ false };
  bool Started{ false };
  int RenderCount{ 0 };

  class vtkInternal;
  vtkInternal* Internal;

private:
  vtkSlicerWebCanvas(const vtkSlicerWebCanvas&) = delete;
  void operator=(const vtkSlicerWebCanvas&) = delete;
};

#endif

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
class vtkRenderer;
class vtkSlicerWebView;

/// \brief A canvas that several views draw into, each in its own rectangle of it.
///
/// A browser allows only so many WebGL contexts at a time - about eight on a phone - and a view
/// of its own canvas costs one each, so a layout of nine slice views cannot be shown. Views that
/// share a canvas share its context: they are renderers of one render window, each with its own
/// viewport, which is what a displayable manager group is bound to anyway. The context, its
/// command buffers and its compiled shaders are then paid for once rather than once per view.
///
/// What a view keeps is its renderer, its displayable managers, its interactor style and its view
/// node; what the canvas keeps is the render window, the interactor, the rendering of frames, and
/// the routing of input to the view the pointer is over.
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

  /// Create the render window, its context and the interactor. Returns false on failure.
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

  /// One render of every view, at most one per animation frame.
  void ScheduleRender();
  void Render();

  /// Rendering is off while the scene is being loaded or a batch is running.
  void SetRenderEnabled(bool enabled);
  vtkGetMacro(RenderEnabled, bool);

  vtkRenderWindow* GetRenderWindow();
  vtkRenderWindowInteractor* GetInteractor();

  /// The view the pointer is over, and the one input is being sent to.
  vtkSlicerWebView* GetViewAt(int x, int y);
  vtkSlicerWebView* GetActiveView();

  /// Number of renders performed (for diagnostics and tests).
  vtkGetMacro(RenderCount, int);

  /// Internal: called from the animation frame callbacks.
  void ProcessScheduledRender();
  bool ProcessInteractorEvents();

protected:
  vtkSlicerWebCanvas();
  ~vtkSlicerWebCanvas() override;

  /// Input goes to one view at a time: the one under the pointer, or the one a drag started in.
  void UpdateActiveView();
  void SetActiveView(vtkSlicerWebView* view);
  static void OnInteractorEvent(vtkObject* caller, unsigned long eid, void* clientData, void* callData);

  char* CanvasSelector{ nullptr };
  bool Initialized{ false };
  bool RenderEnabled{ true };
  bool RenderScheduled{ false };
  bool RenderPendingWhileDisabled{ false };
  bool Started{ false };
  int RenderCount{ 0 };

  class vtkInternal;
  vtkInternal* Internal;

private:
  vtkSlicerWebCanvas(const vtkSlicerWebCanvas&) = delete;
  void operator=(const vtkSlicerWebCanvas&) = delete;
};

#endif

/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

  Qt-free equivalent of ctkVTKAbstractView / qMRMLSliceView / qMRMLThreeDView:
  a render window bound to an HTML <canvas>, with a displayable manager group.

==============================================================================*/

#ifndef vtkSlicerWebView_h
#define vtkSlicerWebView_h

#include "vtkSlicerWebCoreExport.h"

#include <vtkObject.h>
#include <vtkSmartPointer.h>

class vtkMRMLAbstractViewNode;
class vtkMRMLApplicationLogic;
class vtkMRMLDisplayableManagerGroup;
class vtkMRMLScene;
class vtkMRMLViewInteractorStyle;
class vtkRenderWindow;
class vtkRenderWindowInteractor;
class vtkRenderer;
class vtkSlicerWebCanvas;

/// \brief Base class of browser views: render window + renderer + interactor + displayable managers.
///
/// Typical use (from Python):
///   view = slicer.vtkSlicerWebSliceView()
///   view.SetCanvasSelector("#slicer-view-Red")
///   view.Initialize(appLogic, scene, "Red")
///   view.Start()
///
/// Rendering requests (from displayable managers, MRML changes) are coalesced
/// into at most one render per browser animation frame.
class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebView : public vtkObject
{
public:
  vtkTypeMacro(vtkSlicerWebView, vtkObject);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// CSS selector of the <canvas> element used for rendering (e.g. "#slicer-view-Red").
  /// Must be set before Initialize().
  vtkSetStringMacro(CanvasSelector);
  vtkGetStringMacro(CanvasSelector);

  /// Draw into a canvas shared with other views (one WebGL context for all of them) instead of
  /// one of this view's own. Set before Initialize(); the canvas then gives the view its
  /// rectangle (vtkSlicerWebCanvas::SetViewRect) and sends it the input meant for it.
  void SetCanvas(vtkSlicerWebCanvas* canvas);
  vtkSlicerWebCanvas* GetCanvas();

  /// Create rendering pipeline, instantiate displayable managers and create/get the view node
  /// with the given layout name (e.g. "Red", "1").
  /// Returns false on failure.
  virtual bool Initialize(vtkMRMLApplicationLogic* appLogic, vtkMRMLScene* scene, const char* layoutName);

  /// True after successful Initialize() and before Finalize().
  vtkGetMacro(Initialized, bool);

  /// Start processing user input events (non-blocking; driven by requestAnimationFrame).
  void Start();

  /// Stop event processing, remove displayable managers and release the WebGL context.
  virtual void Finalize();

  /// Set the size of the drawing buffer in device pixels (canvas.width/height).
  /// Call from a ResizeObserver of the canvas container. Before Initialize(): the size the view
  /// is made at.
  virtual void SetSize(int width, int height);

  /// Request a render. Multiple requests within one animation frame result in a single render.
  void ScheduleRender();

  /// Render immediately.
  void Render();

  /// Enable/disable rendering (e.g. while the scene is batch processing).
  void SetRenderEnabled(bool enabled);
  vtkGetMacro(RenderEnabled, bool);
  vtkBooleanMacro(RenderEnabled, bool);

  vtkRenderWindow* GetRenderWindow();
  vtkRenderer* GetRenderer();
  vtkRenderWindowInteractor* GetInteractor();
  vtkMRMLDisplayableManagerGroup* GetDisplayableManagerGroup();
  vtkMRMLViewInteractorStyle* GetInteractorObserver();
  vtkMRMLAbstractViewNode* GetViewNode();
  vtkMRMLScene* GetMRMLScene();

  /// Number of renders performed (for diagnostics/tests).
  vtkGetMacro(RenderCount, int);

  /// Show how fast the view renders, in its top right corner: the renders of the last second, and
  /// how long the last one took (Application settings > Developer).
  void SetFPSVisible(bool visible);
  bool GetFPSVisible();
  /// The renders of the last second, and the time the last one took in milliseconds.
  int GetFramesPerSecond();
  double GetLastRenderTime();

  /// Internal: called from the animation frame callback.
  void ProcessScheduledRender();

  /// Internal: process queued user input events (called once per animation frame after Start()).
  /// Returns false when the view is finalized, which ends the event loop.
  bool ProcessInteractorEvents();

protected:
  vtkSlicerWebView();
  ~vtkSlicerWebView() override;

  /// Subclasses create logic, register displayable managers, set up view node.
  virtual bool InitializeView(vtkMRMLApplicationLogic* appLogic, vtkMRMLScene* scene, const char* layoutName) = 0;
  /// Subclasses release logic.
  virtual void FinalizeView() {}
  /// Called after the render window size changed (device pixels).
  virtual void OnSizeChanged(int vtkNotUsed(width), int vtkNotUsed(height)) {}

  /// Point every renderer of this view's window at the camera the main renderer ended up with.
  ///
  /// Displayable managers that draw in a layer of their own (the interaction handles of markups,
  /// for one) take the camera of the main renderer when they are created, and the camera
  /// displayable manager then replaces that camera with the one of the camera node. The layers are
  /// left looking through a camera that never moves again, so what they draw is sized and placed
  /// for a view that is not the one on the screen.
  void SyncLayerCameras();
  /// The layer of the orientation marker's renderer (RENDERER_LAYER of
  /// vtkMRMLOrientationMarkerDisplayableManager), which keeps a camera of its own
  static constexpr int OrientationMarkerLayer = 2;

  void SetViewNode(vtkMRMLAbstractViewNode* viewNode);
  void SetInteractorObserverInternal(vtkMRMLViewInteractorStyle* style);
  void SetDisplayableManagerGroupInternal(vtkMRMLDisplayableManagerGroup* group);

  static void OnButtonPressEvent(vtkObject* caller, unsigned long eid, void* clientData, void* callData);
  static void OnGestureEvent(vtkObject* caller, unsigned long eid, void* clientData, void* callData);
  static void OnSceneEvent(vtkObject* caller, unsigned long eid, void* clientData, void* callData);
  static void OnRenderRequest(vtkObject* caller, unsigned long eid, void* clientData, void* callData);
  static void OnRenderTiming(vtkObject* caller, unsigned long eid, void* clientData, void* callData);

  char* CanvasSelector{ nullptr };
  bool Initialized{ false };
  bool RenderEnabled{ true };
  bool RenderScheduled{ false };
  bool RenderPendingWhileDisabled{ false };
  int RenderCount{ 0 };

  class vtkInternal;
  vtkInternal* Internal;

private:
  vtkSlicerWebView(const vtkSlicerWebView&) = delete;
  void operator=(const vtkSlicerWebView&) = delete;
};

#endif

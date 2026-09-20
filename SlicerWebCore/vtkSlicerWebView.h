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
  /// Call from a ResizeObserver of the canvas container.
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

  void SetViewNode(vtkMRMLAbstractViewNode* viewNode);
  void SetInteractorObserverInternal(vtkMRMLViewInteractorStyle* style);
  void SetDisplayableManagerGroupInternal(vtkMRMLDisplayableManagerGroup* group);

  static void OnButtonPressEvent(vtkObject* caller, unsigned long eid, void* clientData, void* callData);
  static void OnGestureEvent(vtkObject* caller, unsigned long eid, void* clientData, void* callData);
  static void OnSceneEvent(vtkObject* caller, unsigned long eid, void* clientData, void* callData);
  static void OnRenderRequest(vtkObject* caller, unsigned long eid, void* clientData, void* callData);

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

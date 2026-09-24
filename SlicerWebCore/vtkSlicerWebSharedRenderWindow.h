/*==============================================================================

  SlicerWeb - 3D Slicer core running in the web browser

  The render window of one view, drawing with the WebGL context of a shared canvas.

==============================================================================*/

#ifndef vtkSlicerWebSharedRenderWindow_h
#define vtkSlicerWebSharedRenderWindow_h

#include "vtkSlicerWebCoreExport.h"

#include <vtkWebAssemblyOpenGLRenderWindow.h>

/// \brief A view's own render window, drawn with the context of a canvas shared by several views.
///
/// Slicer's views and widgets take a view to be a whole render window: a slice view's XY
/// coordinates are the window's display coordinates, a markup's control points are drawn at them,
/// an event's position is read in them, the orientation marker sits in the window's corner. So a
/// view of a shared canvas keeps a window of its own - the size of the view, with its display
/// coordinates starting at the view's corner - and only the context is shared: the window renders
/// into its own framebuffers of the canvas's context, and the canvas copies what it rendered into
/// the view's rectangle of the canvas (BlitToCanvas). Nothing Slicer draws or computes can tell.
///
/// The context belongs to the canvas: this window neither makes nor destroys it, and since other
/// windows use it too, the GL state is taken afresh whenever this window renders (VTK does that for
/// a context it does not own).
class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebSharedRenderWindow : public vtkWebAssemblyOpenGLRenderWindow
{
public:
  static vtkSlicerWebSharedRenderWindow* New();
  vtkTypeMacro(vtkSlicerWebSharedRenderWindow, vtkWebAssemblyOpenGLRenderWindow);

  /// Draw with this context (the shared canvas's) instead of making one. Before Initialize().
  void AdoptContext(unsigned long contextId);

  /// The window is the size of the view; the canvas element keeps the size the page gives it.
  using Superclass::SetSize;
  void SetSize(int width, int height) override;

  void Initialize() override;

  /// Makes the context current, and takes the GL state afresh if another window used it since.
  void MakeCurrent() override;

  /// Starts a frame; leaves no texture of another window bound where this one's shaders look.
  void Start() override;

  /// Clear the whole canvas (its size in device pixels), before the views are copied into it.
  void ClearCanvas(int width, int height);

  /// Copy what was last rendered into the canvas at this position (device pixels, from the bottom
  /// left of the canvas). Returns false if nothing has been rendered yet.
  bool BlitToCanvas(int x, int y);

  /// Release what this window made in the shared context; the context itself stays.
  void Finalize() override;

  /// Something other than these windows changed the GL state of the context (the canvas).
  static void ContextUsedElsewhere();

protected:
  vtkSlicerWebSharedRenderWindow();
  ~vtkSlicerWebSharedRenderWindow() override;

private:
  vtkSlicerWebSharedRenderWindow(const vtkSlicerWebSharedRenderWindow&) = delete;
  void operator=(const vtkSlicerWebSharedRenderWindow&) = delete;
};

#endif

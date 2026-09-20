/// \class vtkSlicerWebSegmentEditorWidgetRepresentation
/// \brief Draws the brush of the Segment Editor in a slice view.
///
/// The paint and erase effects work with a round brush of a given size in millimetres, and the
/// circle drawn here is what that brush covers at the position the cursor is at, as in desktop
/// Slicer. The circle is drawn in the overlay of the view, in display coordinates, so it keeps its
/// size on screen while the slice is panned and its size in millimetres while the view is zoomed.

#ifndef __vtkSlicerWebSegmentEditorWidgetRepresentation_h
#define __vtkSlicerWebSegmentEditorWidgetRepresentation_h

#include "vtkSlicerWebCoreExport.h"

#include <vtkMRMLAbstractWidgetRepresentation.h>
#include <vtkSmartPointer.h>

class vtkActor2D;
class vtkPolyData;
class vtkPolyDataMapper2D;

class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebSegmentEditorWidgetRepresentation : public vtkMRMLAbstractWidgetRepresentation
{
public:
  static vtkSlicerWebSegmentEditorWidgetRepresentation* New();
  vtkTypeMacro(vtkSlicerWebSegmentEditorWidgetRepresentation, vtkMRMLAbstractWidgetRepresentation);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// Radius of the brush in millimetres.
  vtkGetMacro(BrushRadius, double);
  void SetBrushRadius(double radiusMm);

  /// Where the brush is, in display coordinates of the view.
  void SetCursorPosition(double x, double y);
  vtkGetVector2Macro(CursorPosition, double);

  /// Whether the cursor is in this view: the brush is drawn only in the view that has it.
  vtkGetMacro(CursorInView, bool);
  void SetCursorInView(bool inView);

  /// Rebuild the circle: its size in pixels follows the zoom of the slice view.
  void UpdateFromMRML(vtkMRMLNode* caller, unsigned long event, void* callData = nullptr) override;

  /// Bounds of the circle in display coordinates (xmin, xmax, ymin, ymax, 0, 0), or an empty box
  /// when the brush is not shown.
  double* GetBounds() VTK_SIZEHINT(6) override;

  void GetActors2D(vtkPropCollection*) override;
  void ReleaseGraphicsResources(vtkWindow*) override;
  int RenderOverlay(vtkViewport* viewport) override;

protected:
  vtkSlicerWebSegmentEditorWidgetRepresentation();
  ~vtkSlicerWebSegmentEditorWidgetRepresentation() override;

  /// Pixels per millimetre in the slice view, from the slice node of the view.
  double GetPixelsPerMillimetre();

  void BuildCircle(double radiusPixels);

  double BrushRadius{ 5.0 };
  double CursorPosition[2]{ 0.0, 0.0 };
  bool CursorInView{ false };

  vtkSmartPointer<vtkPolyData> Circle;
  vtkSmartPointer<vtkPolyDataMapper2D> Mapper;
  vtkSmartPointer<vtkActor2D> Actor;

private:
  vtkSlicerWebSegmentEditorWidgetRepresentation(const vtkSlicerWebSegmentEditorWidgetRepresentation&) = delete;
  void operator=(const vtkSlicerWebSegmentEditorWidgetRepresentation&) = delete;
};

#endif

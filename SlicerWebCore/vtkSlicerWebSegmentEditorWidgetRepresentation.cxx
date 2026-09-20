#include "vtkSlicerWebSegmentEditorWidgetRepresentation.h"

#include <vtkActor2D.h>
#include <vtkCellArray.h>
#include <vtkMRMLSliceNode.h>
#include <vtkMatrix4x4.h>
#include <vtkObjectFactory.h>
#include <vtkPoints.h>
#include <vtkPolyData.h>
#include <vtkPolyDataMapper2D.h>
#include <vtkProperty2D.h>
#include <vtkMath.h>
#include <vtkRenderer.h>

#include <cmath>

namespace
{
const int CirclePointCount = 72;
}

vtkStandardNewMacro(vtkSlicerWebSegmentEditorWidgetRepresentation);

//----------------------------------------------------------------------------
vtkSlicerWebSegmentEditorWidgetRepresentation::vtkSlicerWebSegmentEditorWidgetRepresentation()
{
  this->Circle = vtkSmartPointer<vtkPolyData>::New();
  this->Mapper = vtkSmartPointer<vtkPolyDataMapper2D>::New();
  this->Mapper->SetInputData(this->Circle);
  this->Actor = vtkSmartPointer<vtkActor2D>::New();
  this->Actor->SetMapper(this->Mapper);
  this->Actor->SetVisibility(false);
  // Same look as the brush outline of desktop Slicer: a thin bright outline, which stays visible
  // over both the image and the segments painted on it.
  this->Actor->GetProperty()->SetColor(1.0, 1.0, 0.2);
  this->Actor->GetProperty()->SetLineWidth(1.0);
  this->Actor->GetProperty()->SetOpacity(0.8);
}

//----------------------------------------------------------------------------
vtkSlicerWebSegmentEditorWidgetRepresentation::~vtkSlicerWebSegmentEditorWidgetRepresentation() = default;

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidgetRepresentation::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "BrushRadius: " << this->BrushRadius << " mm\n";
  os << indent << "CursorPosition: " << this->CursorPosition[0] << ", " << this->CursorPosition[1] << "\n";
  os << indent << "CursorInView: " << (this->CursorInView ? "true" : "false") << "\n";
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidgetRepresentation::SetBrushRadius(double radiusMm)
{
  if (this->BrushRadius == radiusMm)
  {
    return;
  }
  this->BrushRadius = radiusMm;
  this->NeedToRenderOn();
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidgetRepresentation::SetCursorPosition(double x, double y)
{
  if (this->CursorPosition[0] == x && this->CursorPosition[1] == y)
  {
    return;
  }
  this->CursorPosition[0] = x;
  this->CursorPosition[1] = y;
  this->NeedToRenderOn();
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidgetRepresentation::SetCursorInView(bool inView)
{
  if (this->CursorInView == inView)
  {
    return;
  }
  this->CursorInView = inView;
  this->NeedToRenderOn();
  this->Modified();
}

//----------------------------------------------------------------------------
double vtkSlicerWebSegmentEditorWidgetRepresentation::GetPixelsPerMillimetre()
{
  vtkMRMLSliceNode* sliceNode = vtkMRMLSliceNode::SafeDownCast(this->GetViewNode());
  if (!sliceNode)
  {
    return 1.0;
  }
  // A step of one pixel in the view is the length of the first column of XYToRAS in millimetres.
  vtkMatrix4x4* xyToRAS = sliceNode->GetXYToRAS();
  double millimetresPerPixel = std::sqrt(xyToRAS->GetElement(0, 0) * xyToRAS->GetElement(0, 0) +
                                         xyToRAS->GetElement(1, 0) * xyToRAS->GetElement(1, 0) +
                                         xyToRAS->GetElement(2, 0) * xyToRAS->GetElement(2, 0));
  return millimetresPerPixel > 0.0 ? 1.0 / millimetresPerPixel : 1.0;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidgetRepresentation::BuildCircle(double radiusPixels)
{
  vtkNew<vtkPoints> points;
  vtkNew<vtkCellArray> lines;
  points->SetNumberOfPoints(CirclePointCount);
  lines->InsertNextCell(CirclePointCount + 1);
  for (int i = 0; i < CirclePointCount; ++i)
  {
    const double angle = 2.0 * vtkMath::Pi() * i / CirclePointCount;
    points->SetPoint(i,
                     this->CursorPosition[0] + radiusPixels * std::cos(angle),
                     this->CursorPosition[1] + radiusPixels * std::sin(angle),
                     0.0);
    lines->InsertCellPoint(i);
  }
  lines->InsertCellPoint(0);
  this->Circle->SetPoints(points);
  this->Circle->SetLines(lines);
  this->Circle->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidgetRepresentation::UpdateFromMRML(vtkMRMLNode* caller, unsigned long event, void* callData)
{
  this->Superclass::UpdateFromMRML(caller, event, callData);

  const bool visible = this->CursorInView && this->BrushRadius > 0.0;
  this->Actor->SetVisibility(visible);
  if (!visible)
  {
    return;
  }
  this->BuildCircle(this->BrushRadius * this->GetPixelsPerMillimetre());
}

//----------------------------------------------------------------------------
double* vtkSlicerWebSegmentEditorWidgetRepresentation::GetBounds()
{
  if (!this->Actor->GetVisibility() || this->Circle->GetNumberOfPoints() == 0)
  {
    vtkMath::UninitializeBounds(this->Bounds);
    return this->Bounds;
  }
  this->Circle->GetBounds(this->Bounds);
  return this->Bounds;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidgetRepresentation::GetActors2D(vtkPropCollection* pc)
{
  this->Actor->GetActors2D(pc);
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidgetRepresentation::ReleaseGraphicsResources(vtkWindow* window)
{
  this->Actor->ReleaseGraphicsResources(window);
}

//----------------------------------------------------------------------------
int vtkSlicerWebSegmentEditorWidgetRepresentation::RenderOverlay(vtkViewport* viewport)
{
  if (!this->Actor->GetVisibility())
  {
    return 0;
  }
  return this->Actor->RenderOverlay(viewport);
}

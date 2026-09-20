#include "vtkSlicerWebSegmentEditorWidget.h"
#include "vtkSlicerWebSegmentEditorWidgetRepresentation.h"

#include <vtkMRMLAbstractViewNode.h>
#include <vtkNew.h>
#include <vtkObjectFactory.h>

vtkStandardNewMacro(vtkSlicerWebSegmentEditorWidget);

//----------------------------------------------------------------------------
vtkSlicerWebSegmentEditorWidget::vtkSlicerWebSegmentEditorWidget() = default;

//----------------------------------------------------------------------------
vtkSlicerWebSegmentEditorWidget::~vtkSlicerWebSegmentEditorWidget() = default;

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidget::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidget::CreateDefaultRepresentation(vtkMRMLAbstractViewNode* viewNode, vtkRenderer* renderer)
{
  vtkNew<vtkSlicerWebSegmentEditorWidgetRepresentation> representation;
  this->SetRenderer(renderer);
  representation->SetViewNode(viewNode);
  representation->SetRenderer(renderer);
  this->SetRepresentation(representation);
}

//----------------------------------------------------------------------------
vtkSlicerWebSegmentEditorWidgetRepresentation* vtkSlicerWebSegmentEditorWidget::GetBrushRepresentation()
{
  return vtkSlicerWebSegmentEditorWidgetRepresentation::SafeDownCast(this->WidgetRep);
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidget::SetBrushRadius(double radiusMm)
{
  vtkSlicerWebSegmentEditorWidgetRepresentation* representation = this->GetBrushRepresentation();
  if (representation)
  {
    representation->SetBrushRadius(radiusMm);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidget::SetCursorPosition(double x, double y)
{
  vtkSlicerWebSegmentEditorWidgetRepresentation* representation = this->GetBrushRepresentation();
  if (representation)
  {
    representation->SetCursorPosition(x, y);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorWidget::SetCursorInView(bool inView)
{
  vtkSlicerWebSegmentEditorWidgetRepresentation* representation = this->GetBrushRepresentation();
  if (representation)
  {
    representation->SetCursorInView(inView);
  }
}

//----------------------------------------------------------------------------
bool vtkSlicerWebSegmentEditorWidget::CanProcessInteractionEvent(vtkMRMLInteractionEventData* vtkNotUsed(eventData),
                                                                 double& vtkNotUsed(distance2))
{
  return false;
}

/// \class vtkSlicerWebSegmentEditorWidget
/// \brief Widget that shows the brush of the Segment Editor in a view.
///
/// The widget owns the representation that draws the brush (a circle of the brush size at the
/// cursor). It does not take part in interaction: painting is handled where the strokes are made,
/// and a widget that answered for the events under the cursor would take them from it.

#ifndef vtkSlicerWebSegmentEditorWidget_h
#define vtkSlicerWebSegmentEditorWidget_h

#include "vtkSlicerWebCoreExport.h"

#include <vtkMRMLAbstractWidget.h>

class vtkMRMLAbstractViewNode;
class vtkRenderer;
class vtkSlicerWebSegmentEditorWidgetRepresentation;

class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebSegmentEditorWidget : public vtkMRMLAbstractWidget
{
public:
  static vtkSlicerWebSegmentEditorWidget* New();
  vtkTypeMacro(vtkSlicerWebSegmentEditorWidget, vtkMRMLAbstractWidget);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// Create the representation that draws the brush in this view.
  void CreateDefaultRepresentation(vtkMRMLAbstractViewNode* viewNode, vtkRenderer* renderer);

  vtkSlicerWebSegmentEditorWidgetRepresentation* GetBrushRepresentation();

  /// Brush size in millimetres, where the cursor is (display coordinates), and whether it is in
  /// this view. Set by the displayable manager from the segment editor node and the interactor.
  void SetBrushRadius(double radiusMm);
  void SetCursorPosition(double x, double y);
  void SetCursorInView(bool inView);

  /// The brush is shown, not used: interaction belongs to whatever else is under the cursor.
  bool CanProcessInteractionEvent(vtkMRMLInteractionEventData* eventData, double& distance2) override;

protected:
  vtkSlicerWebSegmentEditorWidget();
  ~vtkSlicerWebSegmentEditorWidget() override;

private:
  vtkSlicerWebSegmentEditorWidget(const vtkSlicerWebSegmentEditorWidget&) = delete;
  void operator=(const vtkSlicerWebSegmentEditorWidget&) = delete;
};

#endif

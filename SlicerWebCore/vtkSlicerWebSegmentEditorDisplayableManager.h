/// \class vtkSlicerWebSegmentEditorDisplayableManager
/// \brief Shows the brush of the Segment Editor in the slice views.
///
/// Follows the segment editor node of the scene: while a brush effect (Paint, Erase) is active, the
/// brush is drawn at the cursor in the view it is over, in the size the effect works with. The
/// drawing itself is the job of vtkSlicerWebSegmentEditorWidget and its representation.
///
/// The brush size is read from the same node attribute as in desktop Slicer
/// ("SegmentEditorEffect.<effect>.BrushAbsoluteDiameter", in millimetres).

#ifndef vtkSlicerWebSegmentEditorDisplayableManager_h
#define vtkSlicerWebSegmentEditorDisplayableManager_h

#include "vtkSlicerWebCoreExport.h"

#include <vtkMRMLAbstractSliceViewDisplayableManager.h>

class vtkSlicerWebSegmentEditorWidget;
class vtkSlicerWebSegmentEditorWidgetRepresentation;

class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebSegmentEditorDisplayableManager : public vtkMRMLAbstractSliceViewDisplayableManager
{
public:
  static vtkSlicerWebSegmentEditorDisplayableManager* New();
  vtkTypeMacro(vtkSlicerWebSegmentEditorDisplayableManager, vtkMRMLAbstractSliceViewDisplayableManager);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// Representation that draws the brush in this view.
  vtkSlicerWebSegmentEditorWidgetRepresentation* GetBrushRepresentation();

  /// Names of the node attributes the brush is read from. The segment editor node belongs to the
  /// Segmentations module, whose library this one cannot link against (it is installed later), so
  /// the state is read through attributes rather than through the node's own API.
  static const char* GetActiveEffectAttributeName();
  static const char* GetBrushDiameterAttributeName(const char* effectName);

protected:
  vtkSlicerWebSegmentEditorDisplayableManager();
  ~vtkSlicerWebSegmentEditorDisplayableManager() override;

  void Create() override;
  void UpdateFromMRML() override;
  void UpdateFromMRMLScene() override;
  void OnMRMLSceneNodeAdded(vtkMRMLNode* node) override;
  void OnMRMLSceneNodeRemoved(vtkMRMLNode* node) override;
  void ProcessMRMLNodesEvents(vtkObject* caller, unsigned long event, void* callData) override;
  void OnMRMLDisplayableNodeModifiedEvent(vtkObject* caller) override;
  void SetMRMLSceneInternal(vtkMRMLScene* scene) override;

  /// The cursor is followed with an observer of its own rather than through the widget framework:
  /// the brush is drawn where the cursor is, and must not take the events from what is under it.
  void ObserveInteractor();
  static void OnInteractorEvent(vtkObject* caller, unsigned long event, void* clientData, void* callData);

  void UpdateBrush();
  vtkMRMLNode* GetSegmentEditorNode();

  class vtkInternal;
  vtkInternal* Internal;

private:
  vtkSlicerWebSegmentEditorDisplayableManager(const vtkSlicerWebSegmentEditorDisplayableManager&) = delete;
  void operator=(const vtkSlicerWebSegmentEditorDisplayableManager&) = delete;
};

#endif

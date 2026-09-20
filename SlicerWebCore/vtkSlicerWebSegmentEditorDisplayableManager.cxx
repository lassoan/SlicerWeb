#include "vtkSlicerWebSegmentEditorDisplayableManager.h"
#include "vtkSlicerWebSegmentEditorWidget.h"
#include "vtkSlicerWebSegmentEditorWidgetRepresentation.h"

#include <vtkMRMLScene.h>
#include <vtkMRMLSliceNode.h>

#include <vtkCallbackCommand.h>
#include <vtkCommand.h>
#include <vtkNew.h>
#include <vtkObjectFactory.h>
#include <vtkProp.h>
#include <vtkPropCollection.h>
#include <vtkRenderWindowInteractor.h>
#include <vtkRenderer.h>
#include <vtkSmartPointer.h>

#include <string>

vtkStandardNewMacro(vtkSlicerWebSegmentEditorDisplayableManager);

//----------------------------------------------------------------------------
class vtkSlicerWebSegmentEditorDisplayableManager::vtkInternal
{
public:
  vtkSmartPointer<vtkSlicerWebSegmentEditorWidget> Widget;
  vtkSmartPointer<vtkCallbackCommand> InteractorCallback;
  vtkWeakPointer<vtkMRMLNode> EditorNode;
  vtkWeakPointer<vtkRenderWindowInteractor> ObservedInteractor;
  std::vector<unsigned long> InteractorTags;
  bool Updating{ false };
  std::vector<vtkSmartPointer<vtkProp>> Actors;
};

//----------------------------------------------------------------------------
vtkSlicerWebSegmentEditorDisplayableManager::vtkSlicerWebSegmentEditorDisplayableManager()
{
  this->Internal = new vtkInternal;
  this->Internal->InteractorCallback = vtkSmartPointer<vtkCallbackCommand>::New();
  this->Internal->InteractorCallback->SetClientData(this);
  this->Internal->InteractorCallback->SetCallback(vtkSlicerWebSegmentEditorDisplayableManager::OnInteractorEvent);
}

//----------------------------------------------------------------------------
vtkSlicerWebSegmentEditorDisplayableManager::~vtkSlicerWebSegmentEditorDisplayableManager()
{
  if (this->Internal->ObservedInteractor)
  {
    for (unsigned long tag : this->Internal->InteractorTags)
    {
      this->Internal->ObservedInteractor->RemoveObserver(tag);
    }
  }
  if (this->Internal->Widget)
  {
    if (this->GetRenderer())
    {
      for (vtkProp* actor : this->Internal->Actors)
      {
        this->GetRenderer()->RemoveViewProp(actor);
      }
    }
    this->Internal->Actors.clear();
    this->Internal->Widget->SetRenderer(nullptr);
    this->Internal->Widget->SetRepresentation(nullptr);
  }
  delete this->Internal;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
}

//----------------------------------------------------------------------------
const char* vtkSlicerWebSegmentEditorDisplayableManager::GetActiveEffectAttributeName()
{
  return "SegmentEditorEffect.ActiveEffect";
}

//----------------------------------------------------------------------------
const char* vtkSlicerWebSegmentEditorDisplayableManager::GetBrushDiameterAttributeName(const char* effectName)
{
  static std::string name;
  name = std::string("SegmentEditorEffect.") + (effectName ? effectName : "") + ".BrushAbsoluteDiameter";
  return name.c_str();
}

//----------------------------------------------------------------------------
vtkSlicerWebSegmentEditorWidgetRepresentation* vtkSlicerWebSegmentEditorDisplayableManager::GetBrushRepresentation()
{
  return this->Internal->Widget ? this->Internal->Widget->GetBrushRepresentation() : nullptr;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::Create()
{
  if (!this->Internal->Widget)
  {
    this->Internal->Widget = vtkSmartPointer<vtkSlicerWebSegmentEditorWidget>::New();
    this->Internal->Widget->SetMRMLApplicationLogic(this->GetMRMLApplicationLogic());
    this->Internal->Widget->CreateDefaultRepresentation(this->GetMRMLDisplayableNode()
                                                          ? vtkMRMLAbstractViewNode::SafeDownCast(this->GetMRMLDisplayableNode())
                                                          : nullptr,
                                                        this->GetRenderer());
  }
  // The actors of the representation go into the view (the representation itself is a prop, but
  // props are drawn in the overlay pass only through their actors here).
  if (this->GetRenderer() && this->Internal->Widget->GetRepresentation())
  {
    vtkNew<vtkPropCollection> actors;
    this->Internal->Widget->GetRepresentation()->GetActors2D(actors);
    actors->InitTraversal();
    while (vtkProp* actor = actors->GetNextProp())
    {
      this->GetRenderer()->AddViewProp(actor);
      this->Internal->Actors.push_back(actor);
    }
  }
  this->ObserveInteractor();
  this->UpdateFromMRMLScene();
  this->Superclass::Create();
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::SetMRMLSceneInternal(vtkMRMLScene* scene)
{
  vtkNew<vtkIntArray> events;
  events->InsertNextValue(vtkMRMLScene::NodeAddedEvent);
  events->InsertNextValue(vtkMRMLScene::NodeRemovedEvent);
  events->InsertNextValue(vtkMRMLScene::EndBatchProcessEvent);
  this->SetAndObserveMRMLSceneEventsInternal(scene, events.GetPointer());
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::ObserveInteractor()
{
  vtkRenderWindowInteractor* interactor = this->GetInteractor();
  if (!interactor || interactor == this->Internal->ObservedInteractor)
  {
    return;
  }
  this->Internal->ObservedInteractor = interactor;
  // Watched before the interactor style, which stops the events it handles from going further, and
  // passed on: the brush is drawn where the cursor is and takes nothing from what is under it.
  for (unsigned long event : { static_cast<unsigned long>(vtkCommand::MouseMoveEvent),
                               static_cast<unsigned long>(vtkCommand::LeaveEvent),
                               static_cast<unsigned long>(vtkCommand::EnterEvent) })
  {
    this->Internal->InteractorTags.push_back(
      interactor->AddObserver(event, this->Internal->InteractorCallback, 10.0));
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::OnInteractorEvent(vtkObject* caller,
                                                                    unsigned long event,
                                                                    void* clientData,
                                                                    void* vtkNotUsed(callData))
{
  vtkSlicerWebSegmentEditorDisplayableManager* self =
    reinterpret_cast<vtkSlicerWebSegmentEditorDisplayableManager*>(clientData);
  vtkRenderWindowInteractor* interactor = vtkRenderWindowInteractor::SafeDownCast(caller);
  if (!self || !interactor || !self->Internal->Widget)
  {
    return;
  }
  if (event == vtkCommand::LeaveEvent)
  {
    self->Internal->Widget->SetCursorInView(false);
  }
  else
  {
    int* position = interactor->GetEventPosition();
    self->Internal->Widget->SetCursorPosition(position[0], position[1]);
    self->Internal->Widget->SetCursorInView(true);
  }
  self->UpdateBrush();
}

//----------------------------------------------------------------------------
vtkMRMLNode* vtkSlicerWebSegmentEditorDisplayableManager::GetSegmentEditorNode()
{
  if (this->Internal->EditorNode)
  {
    return this->Internal->EditorNode;
  }
  vtkMRMLScene* scene = this->GetMRMLScene();
  if (!scene)
  {
    return nullptr;
  }
  // Found by class name and read through attributes: the node belongs to the Segmentations module,
  // whose library is installed after this one and cannot be linked against here.
  vtkMRMLNode* node = scene->GetFirstNodeByClass("vtkMRMLSegmentEditorNode");
  if (node)
  {
    this->Internal->EditorNode = node;
    vtkObserveMRMLNodeMacro(node);
  }
  return node;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::UpdateBrush()
{
  // Asking for a render can bring the view's nodes back here through their modified events, so an
  // update that is already under way is left to finish rather than started again.
  if (!this->Internal->Widget || this->Internal->Updating)
  {
    return;
  }
  this->Internal->Updating = true;
  this->ObserveInteractor();   // the view may have been given its interactor after Create()
  vtkMRMLNode* editorNode = this->GetSegmentEditorNode();
  const char* effect = editorNode ? editorNode->GetAttribute(GetActiveEffectAttributeName()) : nullptr;
  const std::string effectName = effect ? effect : "";
  // A brush is shown for the effects that paint with one; other effects (and no effect) have none.
  const bool brushEffect = (effectName == "Paint" || effectName == "Erase");
  double radius = 0.0;
  if (brushEffect)
  {
    const char* diameter = editorNode->GetAttribute(GetBrushDiameterAttributeName(effectName.c_str()));
    radius = diameter ? 0.5 * atof(diameter) : 0.0;
  }
  this->Internal->Widget->SetBrushRadius(radius);

  vtkSlicerWebSegmentEditorWidgetRepresentation* representation = this->Internal->Widget->GetBrushRepresentation();
  if (representation)
  {
    representation->UpdateFromMRML(nullptr, 0);
    if (representation->GetNeedToRender())
    {
      representation->NeedToRenderOff();
      this->RequestRender();
    }
  }
  this->Internal->Updating = false;
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::UpdateFromMRML()
{
  this->UpdateBrush();
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::UpdateFromMRMLScene()
{
  this->GetSegmentEditorNode();
  this->UpdateBrush();
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::OnMRMLSceneNodeAdded(vtkMRMLNode* node)
{
  if (node && node->IsA("vtkMRMLSegmentEditorNode"))
  {
    this->Internal->EditorNode = nullptr;
    this->UpdateFromMRMLScene();
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::OnMRMLSceneNodeRemoved(vtkMRMLNode* node)
{
  if (node && node->IsA("vtkMRMLSegmentEditorNode"))
  {
    this->Internal->EditorNode = nullptr;
    this->UpdateBrush();
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::ProcessMRMLNodesEvents(vtkObject* caller,
                                                                          unsigned long event,
                                                                          void* callData)
{
  vtkMRMLNode* node = vtkMRMLNode::SafeDownCast(caller);
  if (node && node->IsA("vtkMRMLSegmentEditorNode"))
  {
    this->UpdateBrush();
    return;
  }
  this->Superclass::ProcessMRMLNodesEvents(caller, event, callData);
}

//----------------------------------------------------------------------------
void vtkSlicerWebSegmentEditorDisplayableManager::OnMRMLDisplayableNodeModifiedEvent(vtkObject* caller)
{
  // The slice node changed (zoom, pan): the brush keeps its size in millimetres, so the circle is
  // rebuilt at the new scale.
  this->UpdateBrush();
  this->Superclass::OnMRMLDisplayableNodeModifiedEvent(caller);
}

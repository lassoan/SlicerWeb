/*==============================================================================

  SlicerWeb: 3D Slicer in the browser.
  See the LICENSE file.

==============================================================================*/

#include "vtkSlicerWebRenderWindowInteractor.h"

// VTK includes
#include <vtkCommand.h>
#include <vtkMath.h>
#include <vtkObjectFactory.h>
#include <vtkRenderWindow.h>

// STD includes
#include <algorithm>
#include <cmath>

vtkStandardNewMacro(vtkSlicerWebRenderWindowInteractor);

//----------------------------------------------------------------------------
void vtkSlicerWebRenderWindowInteractor::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "GestureStarted: " << this->GestureStarted << "\n";
}

//----------------------------------------------------------------------------
void vtkSlicerWebRenderWindowInteractor::InitializeWithoutRendering()
{
  if (this->Initialized)
  {
    return;
  }
  this->Initialized = 1;
  this->Enable();
  if (this->RenderWindow)
  {
    this->Size[0] = this->RenderWindow->GetSize()[0];
    this->Size[1] = this->RenderWindow->GetSize()[1];
  }
}

//----------------------------------------------------------------------------
void vtkSlicerWebRenderWindowInteractor::RecognizeGesture(vtkCommand::EventIds event)
{
  // As in vtkRenderWindowInteractor: a third finger is ignored (the gesture ends when it lifts).
  if (this->PointersDownCount > 2)
  {
    return;
  }

  if (event == vtkCommand::LeftButtonPressEvent)
  {
    // The second finger has touched: the gesture is measured from here.
    for (int i = 0; i < VTKI_MAX_POINTERS; i++)
    {
      if (this->PointersDown[i])
      {
        this->StartingEventPositions[i][0] = this->EventPositions[i][0];
        this->StartingEventPositions[i][1] = this->EventPositions[i][1];
      }
    }
    this->EndGesture();
    return;
  }
  if (event == vtkCommand::LeftButtonReleaseEvent)
  {
    this->EndGesture();
    return;
  }
  if (event != vtkCommand::MouseMoveEvent)
  {
    return;
  }

  // The two fingers
  int count = 0;
  int* pos[2] = { nullptr, nullptr };
  int* start[2] = { nullptr, nullptr };
  for (int i = 0; i < VTKI_MAX_POINTERS && count < 2; i++)
  {
    if (this->PointersDown[i])
    {
      pos[count] = this->EventPositions[i];
      start[count] = this->StartingEventPositions[i];
      count++;
    }
  }
  if (count != 2)
  {
    return;
  }

  const double originalDistance = std::hypot(double(start[1][0] - start[0][0]), double(start[1][1] - start[0][1]));
  const double newDistance = std::hypot(double(pos[1][0] - pos[0][0]), double(pos[1][1] - pos[0][1]));
  if (originalDistance < 1.0)
  {
    return; // the fingers touched at the same spot: no scale to speak of
  }
  const double originalAngle =
    vtkMath::DegreesFromRadians(std::atan2(double(start[1][1] - start[0][1]), double(start[1][0] - start[0][0])));
  const double newAngle = vtkMath::DegreesFromRadians(std::atan2(double(pos[1][1] - pos[0][1]), double(pos[1][0] - pos[0][0])));
  double rotation = newAngle - originalAngle;
  while (rotation > 180.0)
  {
    rotation -= 360.0;
  }
  while (rotation < -180.0)
  {
    rotation += 360.0;
  }
  double translation[2] = { (pos[0][0] - start[0][0] + pos[1][0] - start[1][0]) / 2.0,
                            (pos[0][1] - start[0][1] + pos[1][1] - start[1][1]) / 2.0 };

  if (!this->GestureStarted)
  {
    // The gesture starts once the fingers have moved a little (as much as vtkRenderWindowInteractor
    // asks for), so that two fingers put down and lifted again do nothing.
    double threshold = 0.01 * std::sqrt(double(this->Size[0]) * this->Size[0] + double(this->Size[1]) * this->Size[1]);
    threshold = std::max(threshold, 15.0);
    const double pinchDistance = std::fabs(newDistance - originalDistance);
    const double rotateDistance = newDistance * vtkMath::Pi() * std::fabs(rotation) / 360.0;
    const double panDistance = std::hypot(translation[0], translation[1]);
    if (pinchDistance < threshold && rotateDistance < threshold && panDistance < threshold)
    {
      return;
    }
    this->GestureStarted = true;
    this->SetCurrentGesture(vtkCommand::PinchEvent);
    // The gesture starts from where the fingers are now, not from where they touched: the
    // widgets apply the change since the previous event, and there is none yet.
    this->Scale = this->LastScale = newDistance / originalDistance;
    this->Rotation = this->LastRotation = rotation;
    this->Translation[0] = this->LastTranslation[0] = translation[0];
    this->Translation[1] = this->LastTranslation[1] = translation[1];
    this->StartPinchEvent();
    this->StartRotateEvent();
    this->StartPanEvent();
  }

  this->SetScale(newDistance / originalDistance);
  this->PinchEvent();
  this->SetRotation(rotation);
  this->RotateEvent();
  this->SetTranslation(translation);
  this->PanEvent();
}

//----------------------------------------------------------------------------
void vtkSlicerWebRenderWindowInteractor::EndGesture()
{
  if (this->GestureStarted)
  {
    this->EndPanEvent();
    this->EndRotateEvent();
    this->EndPinchEvent();
  }
  this->GestureStarted = false;
  this->SetCurrentGesture(vtkCommand::StartEvent);
}

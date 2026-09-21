/*==============================================================================

  Program: 3D Slicer

  Copyright (c) Kitware Inc.

  See COPYRIGHT.txt
  or http://www.slicer.org/copyright/copyright.txt for details.

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.

==============================================================================*/

#include "vtkSlicerFileWriter.h"

#include "vtkSlicerIOProperties.h"

#include <vtkObjectFactory.h>
#include <vtkStringArray.h>

vtkStandardNewMacro(vtkSlicerFileWriter);

//----------------------------------------------------------------------------
vtkSlicerFileWriter::vtkSlicerFileWriter()
{
  this->WrittenNodeIDs = vtkSmartPointer<vtkStringArray>::New();
}

//----------------------------------------------------------------------------
vtkSlicerFileWriter::~vtkSlicerFileWriter()
{
  this->SetNodeClassName(nullptr);
}

//----------------------------------------------------------------------------
void vtkSlicerFileWriter::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "NodeClassName: " << (this->NodeClassName ? this->NodeClassName : "(any)") << "\n";
  os << indent << "ConfidenceForMatchingClass: " << this->ConfidenceForMatchingClass << "\n";
}

//----------------------------------------------------------------------------
double vtkSlicerFileWriter::CanWriteObjectConfidence(vtkObject* object)
{
  if (!object || !this->NodeClassName)
  {
    return 0.0;
  }
  return object->IsA(this->NodeClassName) ? this->ConfidenceForMatchingClass : 0.0;
}

//----------------------------------------------------------------------------
bool vtkSlicerFileWriter::CanWriteObject(vtkObject* object)
{
  return this->CanWriteObjectConfidence(object) > 0.0;
}

//----------------------------------------------------------------------------
bool vtkSlicerFileWriter::Write(vtkSlicerIOProperties* vtkNotUsed(properties))
{
  // A writer that does its writing elsewhere (in Python, say) is called through its owner.
  return false;
}

//----------------------------------------------------------------------------
vtkStringArray* vtkSlicerFileWriter::GetWrittenNodeIDs() const
{
  return this->WrittenNodeIDs;
}

//----------------------------------------------------------------------------
void vtkSlicerFileWriter::SetWrittenNodeIDs(vtkStringArray* nodeIDs)
{
  this->WrittenNodeIDs->Reset();
  for (vtkIdType i = 0; nodeIDs && i < nodeIDs->GetNumberOfValues(); ++i)
  {
    this->WrittenNodeIDs->InsertNextValue(nodeIDs->GetValue(i));
  }
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerFileWriter::AddWrittenNodeID(const char* nodeID)
{
  if (!nodeID)
  {
    return;
  }
  this->WrittenNodeIDs->InsertNextValue(nodeID);
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerFileWriter::ClearWrittenNodeIDs()
{
  if (this->WrittenNodeIDs->GetNumberOfValues() == 0)
  {
    return;
  }
  this->WrittenNodeIDs->Reset();
  this->Modified();
}

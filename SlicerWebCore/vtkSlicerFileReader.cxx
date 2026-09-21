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

#include "vtkSlicerFileReader.h"

#include "vtkSlicerIOProperties.h"

#include <vtkObjectFactory.h>
#include <vtkStringArray.h>

vtkStandardNewMacro(vtkSlicerFileReader);

//----------------------------------------------------------------------------
vtkSlicerFileReader::vtkSlicerFileReader()
{
  this->LoadedNodeIDs = vtkSmartPointer<vtkStringArray>::New();
}

//----------------------------------------------------------------------------
vtkSlicerFileReader::~vtkSlicerFileReader() = default;

//----------------------------------------------------------------------------
void vtkSlicerFileReader::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "ConfidenceForMatchingExtension: " << this->ConfidenceForMatchingExtension << "\n";
  os << indent << "LoadedNodeIDs: " << this->LoadedNodeIDs->GetNumberOfValues() << "\n";
}

//----------------------------------------------------------------------------
double vtkSlicerFileReader::CanLoadFileConfidence(const char* filePath)
{
  return this->MatchesExtension(filePath) ? this->ConfidenceForMatchingExtension : 0.0;
}

//----------------------------------------------------------------------------
bool vtkSlicerFileReader::CanLoadFile(const char* filePath)
{
  return this->CanLoadFileConfidence(filePath) > 0.0;
}

//----------------------------------------------------------------------------
bool vtkSlicerFileReader::Load(vtkSlicerIOProperties* vtkNotUsed(properties))
{
  // A reader that does its reading elsewhere (in Python, say) is called through its owner; see
  // vtkSlicerFileIOManager::GetReadersForFile and slicerweb.io_scripted.
  return false;
}

//----------------------------------------------------------------------------
vtkStringArray* vtkSlicerFileReader::GetLoadedNodeIDs() const
{
  return this->LoadedNodeIDs;
}

//----------------------------------------------------------------------------
void vtkSlicerFileReader::SetLoadedNodeIDs(vtkStringArray* nodeIDs)
{
  this->LoadedNodeIDs->Reset();
  for (vtkIdType i = 0; nodeIDs && i < nodeIDs->GetNumberOfValues(); ++i)
  {
    this->LoadedNodeIDs->InsertNextValue(nodeIDs->GetValue(i));
  }
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerFileReader::AddLoadedNodeID(const char* nodeID)
{
  if (!nodeID)
  {
    return;
  }
  this->LoadedNodeIDs->InsertNextValue(nodeID);
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerFileReader::ClearLoadedNodeIDs()
{
  if (this->LoadedNodeIDs->GetNumberOfValues() == 0)
  {
    return;
  }
  this->LoadedNodeIDs->Reset();
  this->Modified();
}

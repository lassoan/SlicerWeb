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

#include "vtkSlicerFileIOHandler.h"

#include <vtkMRMLMessageCollection.h>

#include <vtkNew.h>
#include <vtkObjectFactory.h>
#include <vtkStringArray.h>

#include <algorithm>
#include <sstream>

vtkStandardNewMacro(vtkSlicerFileIOHandler);

//----------------------------------------------------------------------------
vtkSlicerFileIOHandler::vtkSlicerFileIOHandler() = default;

//----------------------------------------------------------------------------
vtkSlicerFileIOHandler::~vtkSlicerFileIOHandler()
{
  this->SetFileType(nullptr);
  this->SetDescription(nullptr);
  this->SetOwner(nullptr);
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOHandler::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "FileType: " << (this->FileType ? this->FileType : "(none)") << "\n";
  os << indent << "Description: " << (this->Description ? this->Description : "(none)") << "\n";
  os << indent << "Owner: " << (this->Owner ? this->Owner : "(none)") << "\n";
  os << indent << "NameFilters:";
  for (const std::string& filter : this->NameFilters)
  {
    os << " " << filter;
  }
  os << "\n";
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOHandler::SetNameFilters(const std::vector<std::string>& filters)
{
  this->NameFilters = filters;
  this->Extensions.clear();
  for (const std::string& filter : filters)
  {
    for (const std::string& extension : vtkSlicerFileIOHandler::ExtensionsFromNameFilter(filter))
    {
      if (std::find(this->Extensions.begin(), this->Extensions.end(), extension) == this->Extensions.end())
      {
        this->Extensions.push_back(extension);
      }
    }
  }
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOHandler::SetNameFilters(vtkStringArray* filters)
{
  std::vector<std::string> values;
  for (vtkIdType i = 0; filters && i < filters->GetNumberOfValues(); ++i)
  {
    values.push_back(filters->GetValue(i));
  }
  this->SetNameFilters(values);
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOHandler::GetNameFilters(vtkStringArray* filters) const
{
  if (!filters)
  {
    return;
  }
  filters->Reset();
  for (const std::string& filter : this->NameFilters)
  {
    filters->InsertNextValue(filter);
  }
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOHandler::GetExtensions(vtkStringArray* extensions) const
{
  if (!extensions)
  {
    return;
  }
  extensions->Reset();
  for (const std::string& extension : this->Extensions)
  {
    extensions->InsertNextValue(extension);
  }
}

//----------------------------------------------------------------------------
bool vtkSlicerFileIOHandler::MatchesExtension(const char* filePath) const
{
  return !this->GetMatchedExtension(filePath).empty();
}

//----------------------------------------------------------------------------
std::string vtkSlicerFileIOHandler::GetMatchedExtension(const char* filePath) const
{
  if (!filePath)
  {
    return std::string();
  }
  return vtkSlicerFileIOHandler::LongestMatchingExtension(filePath, this->Extensions);
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOHandler::SetScene(vtkMRMLScene* scene)
{
  if (this->Scene == scene)
  {
    return;
  }
  this->Scene = scene;
  this->Modified();
}

//----------------------------------------------------------------------------
vtkMRMLMessageCollection* vtkSlicerFileIOHandler::GetUserMessages() const
{
  if (!this->UserMessages)
  {
    this->UserMessages = vtkSmartPointer<vtkMRMLMessageCollection>::New();
  }
  return this->UserMessages;
}

//----------------------------------------------------------------------------
std::string vtkSlicerFileIOHandler::LongestMatchingExtension(const std::string& filePath,
                                                             const std::vector<std::string>& extensions)
{
  std::string name = filePath;
  const std::string::size_type slash = name.find_last_of("/\\");
  if (slash != std::string::npos)
  {
    name = name.substr(slash + 1);
  }
  std::transform(name.begin(), name.end(), name.begin(), ::tolower);

  // The longest match wins, so that ".seg.nrrd" is preferred over ".nrrd"
  std::string matched;
  for (const std::string& extension : extensions)
  {
    if (extension.empty() || extension.size() > name.size())
    {
      continue;
    }
    if (name.compare(name.size() - extension.size(), extension.size(), extension) == 0
        && extension.size() > matched.size())
    {
      matched = extension;
    }
  }
  return matched;
}

//----------------------------------------------------------------------------
std::vector<std::string> vtkSlicerFileIOHandler::ExtensionsFromNameFilter(const std::string& nameFilter)
{
  // "Mimics project (*.mcs *.mcs.gz)" -> ".mcs", ".mcs.gz"; a filter without brackets is taken as
  // the patterns themselves ("*.mcs").
  std::string patterns = nameFilter;
  const std::string::size_type open = nameFilter.find('(');
  const std::string::size_type close = nameFilter.rfind(')');
  if (open != std::string::npos && close != std::string::npos && close > open)
  {
    patterns = nameFilter.substr(open + 1, close - open - 1);
  }

  std::vector<std::string> extensions;
  std::istringstream stream(patterns);
  std::string pattern;
  while (stream >> pattern)
  {
    if (pattern == "*" || pattern == "*.*")
    {
      continue;   // takes any file: nothing to match on
    }
    if (!pattern.empty() && pattern[0] == '*')
    {
      pattern = pattern.substr(1);
    }
    if (pattern.empty() || pattern[0] != '.')
    {
      continue;
    }
    std::transform(pattern.begin(), pattern.end(), pattern.begin(), ::tolower);
    extensions.push_back(pattern);
  }
  return extensions;
}

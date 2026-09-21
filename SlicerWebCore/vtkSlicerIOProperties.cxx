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

#include "vtkSlicerIOProperties.h"

#include <vtkObjectFactory.h>
#include <vtkStringArray.h>

#include <algorithm>

vtkStandardNewMacro(vtkSlicerIOProperties);

//----------------------------------------------------------------------------
vtkSlicerIOProperties::vtkSlicerIOProperties() = default;

//----------------------------------------------------------------------------
vtkSlicerIOProperties::~vtkSlicerIOProperties() = default;

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  for (const std::string& name : this->Order)
  {
    os << indent << name << ": " << this->Properties.at(name).ToString() << "\n";
  }
}

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::SetProperty(const char* name, const vtkVariant& value)
{
  if (!name)
  {
    vtkErrorMacro("SetProperty: a property needs a name");
    return;
  }
  if (this->Properties.find(name) == this->Properties.end())
  {
    this->Order.emplace_back(name);
  }
  this->Properties[name] = value;
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::SetStringProperty(const char* name, const char* value)
{
  this->SetProperty(name, vtkVariant(value ? value : ""));
}

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::SetIntProperty(const char* name, int value)
{
  this->SetProperty(name, vtkVariant(value));
}

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::SetDoubleProperty(const char* name, double value)
{
  this->SetProperty(name, vtkVariant(value));
}

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::SetBoolProperty(const char* name, bool value)
{
  this->SetProperty(name, vtkVariant(value ? 1 : 0));
}

//----------------------------------------------------------------------------
vtkVariant vtkSlicerIOProperties::GetProperty(const char* name) const
{
  if (!name)
  {
    return vtkVariant();
  }
  std::map<std::string, vtkVariant>::const_iterator found = this->Properties.find(name);
  return found == this->Properties.end() ? vtkVariant() : found->second;
}

//----------------------------------------------------------------------------
std::string vtkSlicerIOProperties::GetStringProperty(const char* name, const std::string& defaultValue) const
{
  vtkVariant value = this->GetProperty(name);
  return value.IsValid() ? value.ToString() : defaultValue;
}

//----------------------------------------------------------------------------
int vtkSlicerIOProperties::GetIntProperty(const char* name, int defaultValue) const
{
  vtkVariant value = this->GetProperty(name);
  return value.IsValid() ? value.ToInt() : defaultValue;
}

//----------------------------------------------------------------------------
double vtkSlicerIOProperties::GetDoubleProperty(const char* name, double defaultValue) const
{
  vtkVariant value = this->GetProperty(name);
  return value.IsValid() ? value.ToDouble() : defaultValue;
}

//----------------------------------------------------------------------------
bool vtkSlicerIOProperties::GetBoolProperty(const char* name, bool defaultValue) const
{
  vtkVariant value = this->GetProperty(name);
  if (!value.IsValid())
  {
    return defaultValue;
  }
  if (value.IsString())
  {
    std::string text = value.ToString();
    std::transform(text.begin(), text.end(), text.begin(), ::tolower);
    return !(text == "" || text == "0" || text == "false" || text == "no");
  }
  return value.ToInt() != 0;
}

//----------------------------------------------------------------------------
bool vtkSlicerIOProperties::HasProperty(const char* name) const
{
  return name && this->Properties.find(name) != this->Properties.end();
}

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::RemoveProperty(const char* name)
{
  if (!name || !this->HasProperty(name))
  {
    return;
  }
  this->Properties.erase(name);
  this->Order.erase(std::remove(this->Order.begin(), this->Order.end(), std::string(name)), this->Order.end());
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::RemoveAllProperties()
{
  if (this->Properties.empty())
  {
    return;
  }
  this->Properties.clear();
  this->Order.clear();
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::GetPropertyNames(vtkStringArray* names) const
{
  if (!names)
  {
    return;
  }
  names->Reset();
  for (const std::string& name : this->Order)
  {
    names->InsertNextValue(name);
  }
}

//----------------------------------------------------------------------------
std::vector<std::string> vtkSlicerIOProperties::GetPropertyNames() const
{
  return this->Order;
}

//----------------------------------------------------------------------------
void vtkSlicerIOProperties::Copy(vtkSlicerIOProperties* source)
{
  if (!source)
  {
    return;
  }
  this->RemoveAllProperties();
  for (const std::string& name : source->Order)
  {
    this->SetProperty(name.c_str(), source->Properties.at(name));
  }
}

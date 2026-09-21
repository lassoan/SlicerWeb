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

#ifndef __vtkSlicerIOProperties_h
#define __vtkSlicerIOProperties_h

#include "vtkSlicerWebCoreExport.h"

#include <vtkObject.h>
#include <vtkVariant.h>

#include <map>
#include <string>
#include <vector>

class vtkStringArray;

/// What a file reader or writer is asked to do: the file name, the node name, and whatever else
/// the caller wants to say.
///
/// This is qSlicerIO::IOProperties (a QVariantMap) without Qt. The names are the ones Slicer
/// already uses - "fileName", "name", "nodeID", "singleFile", "show" - so that the readers and
/// writers of modules, which are given these as a Python dictionary, are unaffected.
class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerIOProperties : public vtkObject
{
public:
  static vtkSlicerIOProperties* New();
  vtkTypeMacro(vtkSlicerIOProperties, vtkObject);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// Set a property. A value that is already there is replaced.
  void SetProperty(const char* name, const vtkVariant& value);
  void SetStringProperty(const char* name, const char* value);
  void SetIntProperty(const char* name, int value);
  void SetDoubleProperty(const char* name, double value);
  void SetBoolProperty(const char* name, bool value);

  /// The value of a property, or an invalid variant if it is not there.
  vtkVariant GetProperty(const char* name) const;
  /// The value of a property as a string; *defaultValue* if it is not there.
  std::string GetStringProperty(const char* name, const std::string& defaultValue = "") const;
  int GetIntProperty(const char* name, int defaultValue = 0) const;
  double GetDoubleProperty(const char* name, double defaultValue = 0.0) const;
  bool GetBoolProperty(const char* name, bool defaultValue = false) const;

  bool HasProperty(const char* name) const;
  void RemoveProperty(const char* name);
  void RemoveAllProperties();

  /// The names of the properties that are set, in the order they were first set.
  void GetPropertyNames(vtkStringArray* names) const;
  std::vector<std::string> GetPropertyNames() const;

  /// Copy the properties of another set over these.
  void Copy(vtkSlicerIOProperties* source);

protected:
  vtkSlicerIOProperties();
  ~vtkSlicerIOProperties() override;

private:
  vtkSlicerIOProperties(const vtkSlicerIOProperties&) = delete;
  void operator=(const vtkSlicerIOProperties&) = delete;

  std::map<std::string, vtkVariant> Properties;
  std::vector<std::string> Order;
};

#endif

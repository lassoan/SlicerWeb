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

#ifndef __vtkSlicerFileIOHandler_h
#define __vtkSlicerFileIOHandler_h

#include "vtkSlicerWebCoreExport.h"

#include <vtkObject.h>
#include <vtkSmartPointer.h>

#include <string>
#include <vector>

class vtkMRMLMessageCollection;
class vtkMRMLScene;
class vtkStringArray;

/// What something that reads or writes files says about itself: qSlicerIO, without Qt.
///
/// A handler carries the name of the kind of file it deals with (the *file type*, e.g.
/// "VolumeFile"), what to call it in a file dialog (the *description*), and the name filters it
/// accepts, in the form Slicer already writes them: "Mimics project (*.mcs *.mcs.gz)".
///
/// A handler written in C++ reads or writes in its subclass. A handler written in Python registers
/// one of these to say what it can do, and does the work in Python: the *owner* names who that is,
/// so that the caller can find it again (slicerweb.io_scripted keeps the Python objects by owner).
class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerFileIOHandler : public vtkObject
{
public:
  static vtkSlicerFileIOHandler* New();
  vtkTypeMacro(vtkSlicerFileIOHandler, vtkObject);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// The kind of file this handles, as the rest of Slicer names it ("VolumeFile", "ModelFile",
  /// "SceneFile", or whatever a module calls its own).
  vtkGetStringMacro(FileType);
  vtkSetStringMacro(FileType);

  /// What to call this in a file dialog ("Volume", "Mimics project").
  vtkGetStringMacro(Description);
  vtkSetStringMacro(Description);

  /// Who does the work, where it is not this object: "python:ImportMimics", say. Empty for a
  /// handler that reads or writes by itself.
  vtkGetStringMacro(Owner);
  vtkSetStringMacro(Owner);

  /// The name filters, as Slicer writes them: "Mimics project (*.mcs *.mcs.gz)".
  void SetNameFilters(vtkStringArray* filters);
  void SetNameFilters(const std::vector<std::string>& filters);
  void GetNameFilters(vtkStringArray* filters) const;
  const std::vector<std::string>& GetNameFilters() const { return this->NameFilters; }

  /// The extensions of the name filters, lower case and with the dot: ".mcs", ".mcs.gz".
  /// A filter of "*.*" or "*" gives no extension: such a handler takes any file.
  void GetExtensions(vtkStringArray* extensions) const;
  const std::vector<std::string>& GetExtensions() const { return this->Extensions; }

  /// Whether the file name ends in one of the extensions. A handler with no extension of its own
  /// matches nothing here; it has to say what it can do in CanLoadFileConfidence instead.
  virtual bool MatchesExtension(const char* filePath) const;
  /// The longest matching extension of *filePath*, or an empty string.
  virtual std::string GetMatchedExtension(const char* filePath) const;

  /// Where the nodes go, and where messages for the user are collected.
  virtual void SetScene(vtkMRMLScene* scene);
  vtkMRMLScene* GetScene() const { return this->Scene; }

  /// Messages the user should see about the last read or write (a vtkMRMLMessageCollection, as
  /// the readers of Slicer use). Never null.
  vtkMRMLMessageCollection* GetUserMessages() const;

  /// Whether this writes rather than reads.
  virtual bool IsWriter() const { return false; }

  /// The lower-case extension of a file name, taking the compound extensions of Slicer into
  /// account (".seg.nrrd" rather than ".nrrd"), against a list of known extensions.
  static std::string LongestMatchingExtension(const std::string& filePath,
                                              const std::vector<std::string>& extensions);
  /// The extensions named by a filter such as "Mimics project (*.mcs *.mcs.gz)".
  static std::vector<std::string> ExtensionsFromNameFilter(const std::string& nameFilter);

protected:
  vtkSlicerFileIOHandler();
  ~vtkSlicerFileIOHandler() override;

  char* FileType{ nullptr };
  char* Description{ nullptr };
  char* Owner{ nullptr };
  std::vector<std::string> NameFilters;
  std::vector<std::string> Extensions;
  vtkMRMLScene* Scene{ nullptr };   // not owned
  mutable vtkSmartPointer<vtkMRMLMessageCollection> UserMessages;

private:
  vtkSlicerFileIOHandler(const vtkSlicerFileIOHandler&) = delete;
  void operator=(const vtkSlicerFileIOHandler&) = delete;
};

#endif

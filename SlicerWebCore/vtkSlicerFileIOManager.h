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

#ifndef __vtkSlicerFileIOManager_h
#define __vtkSlicerFileIOManager_h

#include "vtkSlicerWebCoreExport.h"

#include <vtkObject.h>
#include <vtkSmartPointer.h>

#include <string>
#include <vector>

class vtkCollection;
class vtkMRMLScene;
class vtkObject;
class vtkSlicerFileIOHandler;
class vtkSlicerFileReader;
class vtkSlicerFileWriter;
class vtkStringArray;

/// Which readers and writers the application has, and which one a file or a node belongs to.
///
/// This is the part of qSlicerCoreIOManager that keeps the list of readers and writers, without
/// Qt: the modules of the application register what they can read and write, and everything that
/// loads or saves asks here which handler to use. A reader written in C++ does its reading in its
/// own subclass of vtkSlicerFileReader; a reader written in Python registers one to say what it
/// can read and is called through its owner (see slicerweb.io_scripted), which is how the reader
/// and writer classes of scripted modules - ImportMimicsFileReader and the like - are used here.
///
/// Registration events are invoked so that a user interface can follow what is available:
/// HandlerRegisteredEvent and HandlerUnregisteredEvent, with the handler as call data.
class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerFileIOManager : public vtkObject
{
public:
  static vtkSlicerFileIOManager* New();
  vtkTypeMacro(vtkSlicerFileIOManager, vtkObject);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  enum
  {
    HandlerRegisteredEvent = 24100,
    HandlerUnregisteredEvent,
  };

  /// The scene the handlers read into and write from.
  virtual void SetScene(vtkMRMLScene* scene);
  vtkMRMLScene* GetScene() const { return this->Scene; }

  //@{
  /// Add a reader or a writer. The manager keeps a reference to it; registering the same object
  /// twice does nothing.
  void RegisterReader(vtkSlicerFileReader* reader);
  void RegisterWriter(vtkSlicerFileWriter* writer);
  void Unregister(vtkSlicerFileIOHandler* handler);
  /// Remove every handler that something registered ("python:ImportMimics"), which is what a
  /// module does when it is unloaded or reloaded.
  void UnregisterOwner(const char* owner);
  //@}

  //@{
  /// What is registered.
  int GetNumberOfReaders() const;
  vtkSlicerFileReader* GetNthReader(int index) const;
  int GetNumberOfWriters() const;
  vtkSlicerFileWriter* GetNthWriter(int index) const;
  //@}

  /// The readers that can read this file, the one that is surest of itself first. Only readers
  /// that answer a confidence above zero are in the list.
  void GetReadersForFile(const char* filePath, vtkCollection* readers);
  /// The reader that is surest it can read this file, or nullptr.
  vtkSlicerFileReader* GetReaderForFile(const char* filePath);
  /// The file type of that reader ("VolumeFile"), or an empty string.
  std::string GetFileTypeForFile(const char* filePath);

  /// The writers that can write this node, the one that is surest of itself first.
  void GetWritersForObject(vtkObject* object, vtkCollection* writers);
  vtkSlicerFileWriter* GetWriterForObject(vtkObject* object);
  std::string GetFileTypeForObject(vtkObject* object);

  //@{
  /// The file types that are registered, and what belongs to each of them.
  void GetReaderFileTypes(vtkStringArray* fileTypes);
  void GetWriterFileTypes(vtkStringArray* fileTypes);
  /// The extensions of every reader (or writer) of a file type: ".mcs", ".mcs.gz".
  void GetExtensionsForFileType(const char* fileType, bool writers, vtkStringArray* extensions);
  /// The name filters of every reader (or writer) of a file type: "Mimics project (*.mcs)".
  void GetNameFiltersForFileType(const char* fileType, bool writers, vtkStringArray* nameFilters);
  /// What a file type is called ("Volume"), from the first handler that has a description.
  std::string GetDescriptionForFileType(const char* fileType, bool writers);
  //@}

  /// The readers of a file type, in the order they were registered.
  void GetReadersForFileType(const char* fileType, vtkCollection* readers);
  /// The writers of a file type, in the order they were registered.
  void GetWritersForFileType(const char* fileType, vtkCollection* writers);

protected:
  vtkSlicerFileIOManager();
  ~vtkSlicerFileIOManager() override;

  /// Handlers with their confidence, highest first; ties keep the order of registration.
  template <typename HandlerType>
  void SortedByConfidence(const std::vector<vtkSmartPointer<HandlerType>>& handlers,
                          const std::vector<double>& confidences,
                          vtkCollection* result);

  vtkMRMLScene* Scene{ nullptr };   // not owned
  std::vector<vtkSmartPointer<vtkSlicerFileReader>> Readers;
  std::vector<vtkSmartPointer<vtkSlicerFileWriter>> Writers;

private:
  vtkSlicerFileIOManager(const vtkSlicerFileIOManager&) = delete;
  void operator=(const vtkSlicerFileIOManager&) = delete;
};

#endif

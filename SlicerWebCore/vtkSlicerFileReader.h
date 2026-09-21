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

#ifndef __vtkSlicerFileReader_h
#define __vtkSlicerFileReader_h

#include "vtkSlicerFileIOHandler.h"

#include <vtkSmartPointer.h>

class vtkSlicerIOProperties;
class vtkStringArray;

/// Something that reads a kind of file into the scene: qSlicerFileReader, without Qt.
///
/// A reader in C++ overrides CanLoadFileConfidence and Load. A reader written in Python registers
/// one of these to say what it can read, and is asked to do the reading itself - the confidence it
/// answers with is kept here (SetConfidenceForOwner), so that the file-type lists and the choice
/// of reader are decided in one place for both.
class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerFileReader : public vtkSlicerFileIOHandler
{
public:
  static vtkSlicerFileReader* New();
  vtkTypeMacro(vtkSlicerFileReader, vtkSlicerFileIOHandler);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// How well this reader thinks it can read the file: 0 for not at all, 0.5 for "the extension is
  /// mine", higher where the reader looked inside the file and is sure. The reader that answers
  /// highest is asked first (qSlicerFileReader::canLoadFileConfidence).
  virtual double CanLoadFileConfidence(const char* filePath);

  /// Whether this reader can read the file at all.
  virtual bool CanLoadFile(const char* filePath);

  /// Read the file named by the "fileName" property into the scene. What it added is then in
  /// GetLoadedNodeIDs. The base class reads nothing: a reader whose work is done elsewhere (in
  /// Python, say) leaves this alone and is called through its owner.
  virtual bool Load(vtkSlicerIOProperties* properties);

  /// The nodes the last Load added, by node ID.
  vtkStringArray* GetLoadedNodeIDs() const;
  void SetLoadedNodeIDs(vtkStringArray* nodeIDs);
  void AddLoadedNodeID(const char* nodeID);
  void ClearLoadedNodeIDs();

  /// What a reader that only knows its own extensions answers when the extension matches. A reader
  /// that looks inside files can say more than this; see CanLoadFileConfidence.
  vtkGetMacro(ConfidenceForMatchingExtension, double);
  vtkSetMacro(ConfidenceForMatchingExtension, double);

protected:
  vtkSlicerFileReader();
  ~vtkSlicerFileReader() override;

  double ConfidenceForMatchingExtension{ 0.5 };
  vtkSmartPointer<vtkStringArray> LoadedNodeIDs;

private:
  vtkSlicerFileReader(const vtkSlicerFileReader&) = delete;
  void operator=(const vtkSlicerFileReader&) = delete;
};

#endif

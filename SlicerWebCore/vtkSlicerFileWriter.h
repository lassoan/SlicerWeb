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

#ifndef __vtkSlicerFileWriter_h
#define __vtkSlicerFileWriter_h

#include "vtkSlicerFileIOHandler.h"

#include <vtkSmartPointer.h>

class vtkSlicerIOProperties;
class vtkStringArray;

/// Something that writes a node to a kind of file: qSlicerFileWriter, without Qt.
///
/// As with vtkSlicerFileReader, a writer in C++ overrides CanWriteObjectConfidence and Write,
/// while a writer written in Python registers one of these to say what it can write and does the
/// writing itself.
class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerFileWriter : public vtkSlicerFileIOHandler
{
public:
  static vtkSlicerFileWriter* New();
  vtkTypeMacro(vtkSlicerFileWriter, vtkSlicerFileIOHandler);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  bool IsWriter() const override { return true; }

  /// How well this writer thinks it can write the object: 0 for not at all, 0.5 for "its class is
  /// one of mine", higher where the writer is the one meant for it. The writer that answers
  /// highest is used (qSlicerFileWriter::canWriteObjectConfidence).
  virtual double CanWriteObjectConfidence(vtkObject* object);
  virtual bool CanWriteObject(vtkObject* object);

  /// Write the node named by the "nodeID" property to the file named by "fileName". What it wrote
  /// is then in GetWrittenNodeIDs. The base class writes nothing: a writer whose work is done
  /// elsewhere is called through its owner.
  virtual bool Write(vtkSlicerIOProperties* properties);

  /// The nodes the last Write wrote, by node ID.
  vtkStringArray* GetWrittenNodeIDs() const;
  void SetWrittenNodeIDs(vtkStringArray* nodeIDs);
  void AddWrittenNodeID(const char* nodeID);
  void ClearWrittenNodeIDs();

  /// The class of node this writer is for ("vtkMRMLTextNode"); empty for a writer that decides for
  /// itself in CanWriteObjectConfidence.
  vtkGetStringMacro(NodeClassName);
  vtkSetStringMacro(NodeClassName);

  /// What a writer that only knows its node class answers for a node of that class.
  vtkGetMacro(ConfidenceForMatchingClass, double);
  vtkSetMacro(ConfidenceForMatchingClass, double);

protected:
  vtkSlicerFileWriter();
  ~vtkSlicerFileWriter() override;

  char* NodeClassName{ nullptr };
  double ConfidenceForMatchingClass{ 0.5 };
  vtkSmartPointer<vtkStringArray> WrittenNodeIDs;

private:
  vtkSlicerFileWriter(const vtkSlicerFileWriter&) = delete;
  void operator=(const vtkSlicerFileWriter&) = delete;
};

#endif

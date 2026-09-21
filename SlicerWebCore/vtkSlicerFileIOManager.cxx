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

#include "vtkSlicerFileIOManager.h"

#include "vtkSlicerFileIOHandler.h"
#include "vtkSlicerFileReader.h"
#include "vtkSlicerFileWriter.h"

#include <vtkCollection.h>
#include <vtkNew.h>
#include <vtkObjectFactory.h>
#include <vtkStringArray.h>

#include <algorithm>
#include <numeric>

vtkStandardNewMacro(vtkSlicerFileIOManager);

namespace
{
/// Add a value to an array of strings unless it is already in it.
void AddOnce(vtkStringArray* values, const std::string& value)
{
  if (!values || value.empty())
  {
    return;
  }
  for (vtkIdType i = 0; i < values->GetNumberOfValues(); ++i)
  {
    if (values->GetValue(i) == value)
    {
      return;
    }
  }
  values->InsertNextValue(value);
}
}

//----------------------------------------------------------------------------
vtkSlicerFileIOManager::vtkSlicerFileIOManager() = default;

//----------------------------------------------------------------------------
vtkSlicerFileIOManager::~vtkSlicerFileIOManager() = default;

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "Readers: " << this->Readers.size() << "\n";
  for (const auto& reader : this->Readers)
  {
    os << indent << "  " << (reader->GetFileType() ? reader->GetFileType() : "?") << " ("
       << (reader->GetDescription() ? reader->GetDescription() : "?") << ")\n";
  }
  os << indent << "Writers: " << this->Writers.size() << "\n";
  for (const auto& writer : this->Writers)
  {
    os << indent << "  " << (writer->GetFileType() ? writer->GetFileType() : "?") << " ("
       << (writer->GetDescription() ? writer->GetDescription() : "?") << ")\n";
  }
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::SetScene(vtkMRMLScene* scene)
{
  if (this->Scene == scene)
  {
    return;
  }
  this->Scene = scene;
  for (const auto& reader : this->Readers)
  {
    reader->SetScene(scene);
  }
  for (const auto& writer : this->Writers)
  {
    writer->SetScene(scene);
  }
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::RegisterReader(vtkSlicerFileReader* reader)
{
  if (!reader)
  {
    vtkErrorMacro("RegisterReader: no reader given");
    return;
  }
  if (std::find(this->Readers.begin(), this->Readers.end(), reader) != this->Readers.end())
  {
    return;
  }
  reader->SetScene(this->Scene);
  this->Readers.emplace_back(reader);
  this->InvokeEvent(HandlerRegisteredEvent, reader);
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::RegisterWriter(vtkSlicerFileWriter* writer)
{
  if (!writer)
  {
    vtkErrorMacro("RegisterWriter: no writer given");
    return;
  }
  if (std::find(this->Writers.begin(), this->Writers.end(), writer) != this->Writers.end())
  {
    return;
  }
  writer->SetScene(this->Scene);
  this->Writers.emplace_back(writer);
  this->InvokeEvent(HandlerRegisteredEvent, writer);
  this->Modified();
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::Unregister(vtkSlicerFileIOHandler* handler)
{
  if (!handler)
  {
    return;
  }
  vtkSmartPointer<vtkSlicerFileIOHandler> kept(handler);   // outlives the removal, for the event
  bool removed = false;

  vtkSlicerFileReader* asReader = vtkSlicerFileReader::SafeDownCast(handler);
  if (asReader)
  {
    auto found = std::find(this->Readers.begin(), this->Readers.end(), asReader);
    if (found != this->Readers.end())
    {
      this->Readers.erase(found);
      removed = true;
    }
  }
  vtkSlicerFileWriter* asWriter = vtkSlicerFileWriter::SafeDownCast(handler);
  if (asWriter)
  {
    auto found = std::find(this->Writers.begin(), this->Writers.end(), asWriter);
    if (found != this->Writers.end())
    {
      this->Writers.erase(found);
      removed = true;
    }
  }
  if (removed)
  {
    this->InvokeEvent(HandlerUnregisteredEvent, kept);
    this->Modified();
  }
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::UnregisterOwner(const char* owner)
{
  if (!owner)
  {
    return;
  }
  const std::string wanted(owner);
  std::vector<vtkSmartPointer<vtkSlicerFileIOHandler>> going;
  for (const auto& reader : this->Readers)
  {
    if (reader->GetOwner() && wanted == reader->GetOwner())
    {
      going.emplace_back(reader.Get());
    }
  }
  for (const auto& writer : this->Writers)
  {
    if (writer->GetOwner() && wanted == writer->GetOwner())
    {
      going.emplace_back(writer.Get());
    }
  }
  for (const auto& handler : going)
  {
    this->Unregister(handler);
  }
}

//----------------------------------------------------------------------------
int vtkSlicerFileIOManager::GetNumberOfReaders() const
{
  return static_cast<int>(this->Readers.size());
}

//----------------------------------------------------------------------------
vtkSlicerFileReader* vtkSlicerFileIOManager::GetNthReader(int index) const
{
  if (index < 0 || index >= static_cast<int>(this->Readers.size()))
  {
    return nullptr;
  }
  return this->Readers[index];
}

//----------------------------------------------------------------------------
int vtkSlicerFileIOManager::GetNumberOfWriters() const
{
  return static_cast<int>(this->Writers.size());
}

//----------------------------------------------------------------------------
vtkSlicerFileWriter* vtkSlicerFileIOManager::GetNthWriter(int index) const
{
  if (index < 0 || index >= static_cast<int>(this->Writers.size()))
  {
    return nullptr;
  }
  return this->Writers[index];
}

//----------------------------------------------------------------------------
template <typename HandlerType>
void vtkSlicerFileIOManager::SortedByConfidence(const std::vector<vtkSmartPointer<HandlerType>>& handlers,
                                                const std::vector<double>& confidences,
                                                vtkCollection* result)
{
  if (!result)
  {
    return;
  }
  result->RemoveAllItems();
  std::vector<size_t> order(handlers.size());
  std::iota(order.begin(), order.end(), 0);
  // A stable sort keeps the order of registration where two handlers are equally sure of themselves
  std::stable_sort(order.begin(), order.end(),
                   [&confidences](size_t a, size_t b) { return confidences[a] > confidences[b]; });
  for (size_t index : order)
  {
    if (confidences[index] > 0.0)
    {
      result->AddItem(handlers[index]);
    }
  }
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::GetReadersForFile(const char* filePath, vtkCollection* readers)
{
  if (!readers)
  {
    return;
  }
  readers->RemoveAllItems();
  if (!filePath)
  {
    return;
  }
  std::vector<double> confidences;
  confidences.reserve(this->Readers.size());
  for (const auto& reader : this->Readers)
  {
    confidences.push_back(reader->CanLoadFileConfidence(filePath));
  }
  this->SortedByConfidence(this->Readers, confidences, readers);
}

//----------------------------------------------------------------------------
vtkSlicerFileReader* vtkSlicerFileIOManager::GetReaderForFile(const char* filePath)
{
  vtkNew<vtkCollection> readers;
  this->GetReadersForFile(filePath, readers);
  return readers->GetNumberOfItems() > 0 ? vtkSlicerFileReader::SafeDownCast(readers->GetItemAsObject(0)) : nullptr;
}

//----------------------------------------------------------------------------
std::string vtkSlicerFileIOManager::GetFileTypeForFile(const char* filePath)
{
  vtkSlicerFileReader* reader = this->GetReaderForFile(filePath);
  return reader && reader->GetFileType() ? reader->GetFileType() : std::string();
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::GetWritersForObject(vtkObject* object, vtkCollection* writers)
{
  if (!writers)
  {
    return;
  }
  writers->RemoveAllItems();
  if (!object)
  {
    return;
  }
  std::vector<double> confidences;
  confidences.reserve(this->Writers.size());
  for (const auto& writer : this->Writers)
  {
    confidences.push_back(writer->CanWriteObjectConfidence(object));
  }
  this->SortedByConfidence(this->Writers, confidences, writers);
}

//----------------------------------------------------------------------------
vtkSlicerFileWriter* vtkSlicerFileIOManager::GetWriterForObject(vtkObject* object)
{
  vtkNew<vtkCollection> writers;
  this->GetWritersForObject(object, writers);
  return writers->GetNumberOfItems() > 0 ? vtkSlicerFileWriter::SafeDownCast(writers->GetItemAsObject(0)) : nullptr;
}

//----------------------------------------------------------------------------
std::string vtkSlicerFileIOManager::GetFileTypeForObject(vtkObject* object)
{
  vtkSlicerFileWriter* writer = this->GetWriterForObject(object);
  return writer && writer->GetFileType() ? writer->GetFileType() : std::string();
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::GetReaderFileTypes(vtkStringArray* fileTypes)
{
  if (!fileTypes)
  {
    return;
  }
  fileTypes->Reset();
  for (const auto& reader : this->Readers)
  {
    AddOnce(fileTypes, reader->GetFileType() ? reader->GetFileType() : "");
  }
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::GetWriterFileTypes(vtkStringArray* fileTypes)
{
  if (!fileTypes)
  {
    return;
  }
  fileTypes->Reset();
  for (const auto& writer : this->Writers)
  {
    AddOnce(fileTypes, writer->GetFileType() ? writer->GetFileType() : "");
  }
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::GetExtensionsForFileType(const char* fileType, bool writers,
                                                      vtkStringArray* extensions)
{
  if (!extensions || !fileType)
  {
    return;
  }
  extensions->Reset();
  vtkNew<vtkCollection> handlers;
  if (writers)
  {
    this->GetWritersForFileType(fileType, handlers);
  }
  else
  {
    this->GetReadersForFileType(fileType, handlers);
  }
  for (int i = 0; i < handlers->GetNumberOfItems(); ++i)
  {
    vtkSlicerFileIOHandler* handler = vtkSlicerFileIOHandler::SafeDownCast(handlers->GetItemAsObject(i));
    for (const std::string& extension : handler->GetExtensions())
    {
      AddOnce(extensions, extension);
    }
  }
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::GetNameFiltersForFileType(const char* fileType, bool writers,
                                                       vtkStringArray* nameFilters)
{
  if (!nameFilters || !fileType)
  {
    return;
  }
  nameFilters->Reset();
  vtkNew<vtkCollection> handlers;
  if (writers)
  {
    this->GetWritersForFileType(fileType, handlers);
  }
  else
  {
    this->GetReadersForFileType(fileType, handlers);
  }
  for (int i = 0; i < handlers->GetNumberOfItems(); ++i)
  {
    vtkSlicerFileIOHandler* handler = vtkSlicerFileIOHandler::SafeDownCast(handlers->GetItemAsObject(i));
    for (const std::string& filter : handler->GetNameFilters())
    {
      AddOnce(nameFilters, filter);
    }
  }
}

//----------------------------------------------------------------------------
std::string vtkSlicerFileIOManager::GetDescriptionForFileType(const char* fileType, bool writers)
{
  if (!fileType)
  {
    return std::string();
  }
  vtkNew<vtkCollection> handlers;
  if (writers)
  {
    this->GetWritersForFileType(fileType, handlers);
  }
  else
  {
    this->GetReadersForFileType(fileType, handlers);
  }
  for (int i = 0; i < handlers->GetNumberOfItems(); ++i)
  {
    vtkSlicerFileIOHandler* handler = vtkSlicerFileIOHandler::SafeDownCast(handlers->GetItemAsObject(i));
    const char* description = handler->GetDescription();
    if (description && description[0])
    {
      return description;
    }
  }
  return std::string();
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::GetReadersForFileType(const char* fileType, vtkCollection* readers)
{
  if (!readers || !fileType)
  {
    return;
  }
  readers->RemoveAllItems();
  const std::string wanted(fileType);
  for (const auto& reader : this->Readers)
  {
    if (reader->GetFileType() && wanted == reader->GetFileType())
    {
      readers->AddItem(reader);
    }
  }
}

//----------------------------------------------------------------------------
void vtkSlicerFileIOManager::GetWritersForFileType(const char* fileType, vtkCollection* writers)
{
  if (!writers || !fileType)
  {
    return;
  }
  writers->RemoveAllItems();
  const std::string wanted(fileType);
  for (const auto& writer : this->Writers)
  {
    if (writer->GetFileType() && wanted == writer->GetFileType())
    {
      writers->AddItem(writer);
    }
  }
}

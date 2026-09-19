/*==============================================================================

  SlicerWeb - browser implementation of vtkHTTPHandler.

  Network access in the browser goes through fetch() (JavaScript) or pyodide.http (Python),
  which download remote files into the Emscripten file system before MRML storage nodes read
  them. Therefore this handler does not claim any URI.

==============================================================================*/

#include "vtkHTTPHandler.h"

vtkStandardNewMacro(vtkHTTPHandler);

class vtkHTTPHandler::vtkInternal
{
public:
  int ForbidReuse{ 0 };
};

vtkHTTPHandler::vtkHTTPHandler()
  : Internal(new vtkInternal)
{
}

vtkHTTPHandler::~vtkHTTPHandler()
{
  this->SetCaCertificatesPath(nullptr);
  delete this->Internal;
}

void vtkHTTPHandler::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "Browser build: remote URIs are fetched by the web application\n";
}

int vtkHTTPHandler::CanHandleURI(const char* vtkNotUsed(uri))
{
  return 0;
}

void vtkHTTPHandler::SetForbidReuse(int value)
{
  this->Internal->ForbidReuse = value;
}

int vtkHTTPHandler::GetForbidReuse()
{
  return this->Internal->ForbidReuse;
}

void vtkHTTPHandler::InitTransfer() {}

int vtkHTTPHandler::CloseTransfer()
{
  return 0;
}

void vtkHTTPHandler::StageFileRead(const char* source, const char* vtkNotUsed(destination))
{
  vtkErrorMacro("StageFileRead: remote download of " << (source ? source : "(null)")
                << " is not available in the browser build; fetch the file into the virtual file system first.");
}

void vtkHTTPHandler::StageFileWrite(const char* vtkNotUsed(source), const char* destination)
{
  vtkErrorMacro("StageFileWrite: remote upload to " << (destination ? destination : "(null)")
                << " is not available in the browser build.");
}

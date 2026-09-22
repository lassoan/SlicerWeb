#include "vtkSlicerWebCLIModule.h"

#include <vtkSlicerCLIModuleLogic.h>

#include <ModuleDescription.h>
#include <ModuleDescriptionParser.h>

#include <vtkObjectFactory.h>

#include <cstdio>
#include <cstring>
#include <string>

// The modules linked in from Modules/CLI. Each CLI module defines these two, so only one of them
// can be linked into this library as it stands; a second would have to be compiled with the names
// changed (see Modules/CLI/CMakeLists.txt).
extern "C" int ModuleEntryPoint(int argc, char* argv[]);
extern "C" char XMLModuleDescription[];

namespace
{
const char* const BuiltInModule = "ResampleScalarVectorDWIVolume";
}

vtkStandardNewMacro(vtkSlicerWebCLIModule);

//----------------------------------------------------------------------------
vtkSlicerWebCLIModule::vtkSlicerWebCLIModule() = default;

//----------------------------------------------------------------------------
vtkSlicerWebCLIModule::~vtkSlicerWebCLIModule() = default;

//----------------------------------------------------------------------------
void vtkSlicerWebCLIModule::PrintSelf(ostream& os, vtkIndent indent)
{
  this->Superclass::PrintSelf(os, indent);
  os << indent << "Modules: " << vtkSlicerWebCLIModule::GetModuleNames() << "\n";
}

//----------------------------------------------------------------------------
const char* vtkSlicerWebCLIModule::GetModuleNames()
{
  return BuiltInModule;
}

//----------------------------------------------------------------------------
const char* vtkSlicerWebCLIModule::GetXMLDescription(const char* moduleName)
{
  if (moduleName == nullptr || strcmp(moduleName, BuiltInModule) != 0)
  {
    return nullptr;
  }
  return XMLModuleDescription;
}

//----------------------------------------------------------------------------
vtkSlicerCLIModuleLogic* vtkSlicerWebCLIModule::CreateLogic(const char* moduleName)
{
  const char* xml = vtkSlicerWebCLIModule::GetXMLDescription(moduleName);
  if (xml == nullptr)
  {
    vtkGenericWarningMacro("No CLI module named " << (moduleName ? moduleName : "(none)")
                                                  << " is built into this application");
    return nullptr;
  }

  ModuleDescription description;
  ModuleDescriptionParser parser;
  if (parser.Parse(std::string(xml), description) != 0)
  {
    vtkGenericWarningMacro("The description of " << moduleName << " could not be read");
    return nullptr;
  }

  // What tells vtkSlicerCLIModuleLogic::ApplyTask to call the module rather than start a program:
  // the type, and the entry point's address in the target, which it reads back with "slicer:%p".
  description.SetType("SharedObjectModule");
  char target[64] = { 0 };
  snprintf(target, sizeof(target), "slicer:%p", reinterpret_cast<void*>(&ModuleEntryPoint));
  description.SetTarget(target);

  vtkSlicerCLIModuleLogic* logic = vtkSlicerCLIModuleLogic::New();
  logic->SetDefaultModuleDescription(description);
  // A module that runs in the process would normally be handed its volumes in memory, through the
  // MRMLIDImageIO reader that understands a "slicer:<scene>#<node id>" file name. That reader is
  // part of the desktop application and is not built here, so the nodes travel as files in the
  // temporary directory instead, exactly as they do for a module that is a separate program.
  logic->SetAllowInMemoryTransfer(0);
  return logic;
}

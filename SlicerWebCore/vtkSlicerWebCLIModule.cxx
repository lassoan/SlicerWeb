#include "vtkSlicerWebCLIModule.h"

#include <vtkSlicerCLIModuleLogic.h>

#include <ModuleDescription.h>
#include <ModuleDescriptionParser.h>

#include <vtkObjectFactory.h>

#include <cstdio>
#include <cstring>
#include <string>

// The modules linked in from Modules/CLI. Each of them declares its entry point and the XML it
// describes itself with under the same names; they are compiled with the module's name in front of
// each, so that several can live in this one library (see Modules/CLI/CMakeLists.txt).
#define SLICERWEB_CLI_MODULE(name)                                                                                     \
  extern "C" int name##_ModuleEntryPoint(int argc, char* argv[]);                                                      \
  extern "C" char name##_XMLModuleDescription[];

SLICERWEB_CLI_MODULE(ResampleScalarVectorDWIVolume)
SLICERWEB_CLI_MODULE(MedianImageFilter)

namespace
{
struct BuiltInModule
{
  const char* Name;
  int (*EntryPoint)(int argc, char* argv[]);
  const char* XML;
};

const BuiltInModule BuiltInModules[] = {
  { "ResampleScalarVectorDWIVolume", &ResampleScalarVectorDWIVolume_ModuleEntryPoint, ResampleScalarVectorDWIVolume_XMLModuleDescription },
  { "MedianImageFilter", &MedianImageFilter_ModuleEntryPoint, MedianImageFilter_XMLModuleDescription },
};

const BuiltInModule* FindModule(const char* name)
{
  if (name == nullptr)
  {
    return nullptr;
  }
  for (const BuiltInModule& module : BuiltInModules)
  {
    if (strcmp(module.Name, name) == 0)
    {
      return &module;
    }
  }
  return nullptr;
}
} // namespace

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
  static std::string names;
  if (names.empty())
  {
    for (const BuiltInModule& module : BuiltInModules)
    {
      names += (names.empty() ? "" : ";");
      names += module.Name;
    }
  }
  return names.c_str();
}

//----------------------------------------------------------------------------
const char* vtkSlicerWebCLIModule::GetXMLDescription(const char* moduleName)
{
  const BuiltInModule* module = FindModule(moduleName);
  return module ? module->XML : nullptr;
}

//----------------------------------------------------------------------------
vtkSlicerCLIModuleLogic* vtkSlicerWebCLIModule::CreateLogic(const char* moduleName)
{
  const BuiltInModule* module = FindModule(moduleName);
  if (module == nullptr)
  {
    vtkGenericWarningMacro("No CLI module named " << (moduleName ? moduleName : "(none)")
                                                  << " is built into this application");
    return nullptr;
  }

  ModuleDescription description;
  ModuleDescriptionParser parser;
  if (parser.Parse(std::string(module->XML), description) != 0)
  {
    vtkGenericWarningMacro("The description of " << moduleName << " could not be read");
    return nullptr;
  }

  // What tells vtkSlicerCLIModuleLogic::ApplyTask to call the module rather than start a program:
  // the type, and the entry point's address in the target, which it reads back with "slicer:%p".
  description.SetType("SharedObjectModule");
  char target[64] = { 0 };
  snprintf(target, sizeof(target), "slicer:%p", reinterpret_cast<void*>(module->EntryPoint));
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

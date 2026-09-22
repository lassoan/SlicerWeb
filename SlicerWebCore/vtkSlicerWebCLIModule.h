/// \file vtkSlicerWebCLIModule.h
/// \brief CLI modules that are built into the application.
///
/// A CLI module is a separate program in desktop Slicer: Slicer writes the chosen nodes to files,
/// runs the program with their paths on its command line, and reads back the files it wrote. A web
/// page cannot start programs, but it does not have to: Slicer already knows how to call a CLI
/// module that is a library rather than a program (a "shared object module"), which is what the
/// modules here are - the same C++ sources, linked into this library.
///
/// This class builds the vtkSlicerCLIModuleLogic for such a module: the module's own XML
/// description, with its type set to SharedObjectModule and its target set to the address of its
/// entry point, which is what vtkSlicerCLIModuleLogic::ApplyTask calls. Registering that logic with
/// the application logic under the module's name is all the C++ that asks for it needs
/// (vtkSlicerCropVolumeLogic looks up "ResampleScalarVectorDWIVolume" that way).

#ifndef __vtkSlicerWebCLIModule_h
#define __vtkSlicerWebCLIModule_h

#include <vtkObject.h>

#include "vtkSlicerWebCoreExport.h"

class vtkSlicerCLIModuleLogic;

class VTK_SLICER_WEB_CORE_EXPORT vtkSlicerWebCLIModule : public vtkObject
{
public:
  static vtkSlicerWebCLIModule* New();
  vtkTypeMacro(vtkSlicerWebCLIModule, vtkObject);
  void PrintSelf(ostream& os, vtkIndent indent) override;

  /// Names of the CLI modules built into this application.
  static const char* GetModuleNames();

  /// The logic that runs this module, or nullptr if it is not built in.
  /// The caller owns the logic; it still needs its scene and application logic.
  VTK_NEWINSTANCE
  static vtkSlicerCLIModuleLogic* CreateLogic(const char* moduleName);

  /// The XML the module describes itself with, or nullptr if it is not built in.
  static const char* GetXMLDescription(const char* moduleName);

protected:
  vtkSlicerWebCLIModule();
  ~vtkSlicerWebCLIModule() override;

private:
  vtkSlicerWebCLIModule(const vtkSlicerWebCLIModule&) = delete;
  void operator=(const vtkSlicerWebCLIModule&) = delete;
};

#endif

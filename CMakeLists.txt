# SlicerWeb superproject: builds 3D Slicer's Qt-free libraries (MRML, logic, displayable managers,
# loadable module MRML/Logic/VTKWidgets/MRMLDM libraries) and SlicerWebCore as Pyodide-compatible
# Emscripten side modules with VTK Python wrapping.
#
# Slicer's own top-level CMakeLists.txt cannot be used because it requires Qt, CTK and PythonQt.
# This file replicates the subset of its setup that the Qt-free subdirectories rely on, then adds
# those subdirectories from the Slicer source tree unchanged.

cmake_minimum_required(VERSION 3.28)
project(SlicerWeb VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)


#-----------------------------------------------------------------------------
# Inputs
#-----------------------------------------------------------------------------
set(Slicer_SOURCE_DIR "" CACHE PATH "3D Slicer source tree")
set(vtkAddon_SOURCE_DIR "" CACHE PATH "vtkAddon source tree")
set(SlicerWeb_ITK_SOURCE_DIR "" CACHE PATH "ITK source tree (for header-only VtkGlue bridge used by vtkITK)")
foreach(var Slicer_SOURCE_DIR vtkAddon_SOURCE_DIR SlicerWeb_ITK_SOURCE_DIR)
  if(NOT EXISTS "${${var}}")
    message(FATAL_ERROR "${var} is not set or does not exist: '${${var}}'")
  endif()
endforeach()

# Loadable modules whose Qt-free libraries are built. Order matters (dependencies first),
# same as Slicer/Modules/Loadable/CMakeLists.txt.
set(SlicerWeb_LOADABLE_MODULES
  Cameras Units Terminologies SubjectHierarchy Colors Annotations Transforms GeneralizedReformat
  Data Models Plots Segmentations Sequences SceneViews Markups Tables Texts Reformat ViewControllers
  Volumes VolumeRendering CropVolume
  CACHE STRING "Slicer loadable modules to build (MRML/Logic/VTKWidgets/MRMLDM libraries only)")

#-----------------------------------------------------------------------------
# Slicer build settings (subset of Slicer/CMakeLists.txt)
#-----------------------------------------------------------------------------
set(Slicer_BINARY_DIR ${CMAKE_BINARY_DIR})
set(Slicer_CMAKE_DIR ${Slicer_SOURCE_DIR}/CMake)
set(Slicer_EXTENSIONS_CMAKE_DIR ${Slicer_SOURCE_DIR}/Extensions/CMake)
set(vtkAddon_CMAKE_DIR ${vtkAddon_SOURCE_DIR}/CMake)
set(CMAKE_MODULE_PATH
  ${CMAKE_CURRENT_SOURCE_DIR}/cmake
  ${vtkAddon_CMAKE_DIR}
  ${Slicer_CMAKE_DIR}
  ${Slicer_EXTENSIONS_CMAKE_DIR}
  ${CMAKE_MODULE_PATH})

# Version and revision, as Slicer/CMakeLists.txt sets them: the version numbers from Slicer's
# CMakeLists.txt, and the rest - the revision (the commit count), the build date, the git hash -
# by Slicer's own SlicerVersion.cmake from the git history of the Slicer checkout, which is fetched
# with its history for this (scripts/fetch.sh).
file(STRINGS "${Slicer_SOURCE_DIR}/CMakeLists.txt" _slicer_version_lines REGEX "set\\(Slicer_VERSION_(MAJOR|MINOR|PATCH) ")
foreach(_line IN LISTS _slicer_version_lines)
  if(_line MATCHES "set\\((Slicer_VERSION_(MAJOR|MINOR|PATCH)) \"?([0-9]+)\"?\\)")
    set(${CMAKE_MATCH_1} ${CMAKE_MATCH_3})
  endif()
endforeach()
set(Slicer_MAIN_PROJECT Slicer)
set(Slicer_APPLICATION_NAME Slicer)
set(Slicer_MAIN_PROJECT_APPLICATION_NAME Slicer)
foreach(p MAJOR MINOR PATCH)
  set(Slicer_MAIN_PROJECT_VERSION_${p} ${Slicer_VERSION_${p}})
endforeach()
set(Slicer_MAIN_PROJECT_SOURCE_DIR ${Slicer_SOURCE_DIR})
set(Slicer_RELEASE_TYPE "Experimental")
find_package(Git REQUIRED)
include(SlicerVersion)
message(STATUS "Building Slicer ${Slicer_VERSION_FULL} (revision ${Slicer_REVISION}) libraries for the browser")

# SlicerDirectories.cmake uses mark_as_superbuild() from ExternalProjectDependency, and
# CMAKE_INSTALL_LIBDIR (Slicer_SITE_PACKAGES_DIR)
macro(mark_as_superbuild)
endmacro()
include(GNUInstallDirs)
include(SlicerDirectories)

set(Slicer_EXPORT_HEADER_TEMPLATE "${Slicer_SOURCE_DIR}/CMake/qSlicerExport.h.in")
set(Slicer_LIBRARY_PROPERTIES "")
set(Slicer_INSTALL_NO_DEVELOPMENT 1)   # extensions build against the SDK build tree
set(Slicer_USE_PYTHONQT ON)          # enables Python wrapping of MRMLDisplayableManager/SlicerBaseLogic;
                                     # no PythonQt library is used by the Qt-free directories
set(Slicer_USE_PYTHONQT_WITH_OPENSSL OFF)
set(Slicer_BUILD_DICOM_SUPPORT OFF)
set(Slicer_USE_IDImageIO OFF)
set(Slicer_BUILD_vtkAddon ON)
set(Slicer_BUILD_QTLOADABLEMODULES OFF)
set(Slicer_BUILD_CLI_SUPPORT ON)
set(BUILD_TESTING OFF)
set(BUILD_SHARED_LIBS ON)
set(Slicer_VTK_WRAP_HIERARCHY_DIR ${Slicer_BINARY_DIR})
set(ITKFactoryRegistration_SKIP_IO_MODULES ON)
set(ModuleDescriptionParser_USE_PYTHON OFF)
set(Slicer_LAUNCH_COMMAND "")
set(vtkAddon_LAUNCH_COMMAND "")

# Output directories (Slicer/CMakeLists.txt)
file(WRITE "${Slicer_BINARY_DIR}/SlicerTargets.cmake" "")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${Slicer_BINARY_DIR}/${Slicer_BIN_DIR})
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${Slicer_BINARY_DIR}/${Slicer_BIN_DIR})
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${Slicer_BINARY_DIR}/${Slicer_LIB_DIR})
set(Slicer_HOME "${Slicer_BINARY_DIR}")

set(Slicer_Base_LIBRARIES CACHE INTERNAL "Slicer Base libraries" FORCE)
set(Slicer_Base_INCLUDE_DIRS CACHE INTERNAL "Slicer Base includes" FORCE)
set(Slicer_ModuleLogic_INCLUDE_DIRS CACHE INTERNAL "Slicer Module logic includes" FORCE)
set(Slicer_ModuleMRML_INCLUDE_DIRS CACHE INTERNAL "Slicer Module MRML includes" FORCE)
set(Slicer_ModuleWidgets_INCLUDE_DIRS CACHE INTERNAL "Slicer Module Widgets includes" FORCE)

#-----------------------------------------------------------------------------
# Dependencies
#-----------------------------------------------------------------------------
find_package(VTK REQUIRED)
if(NOT VTK_WRAP_PYTHON)
  message(FATAL_ERROR "VTK must be built with VTK_WRAP_PYTHON")
endif()
# Python symbols are provided by the Python runtime (Pyodide main module) when modules are loaded.
set(VTK_UNDEFINED_SYMBOLS_ALLOWED ON)
set(PYTHON_LIBRARY "")
find_package(Python3 COMPONENTS Development.Module REQUIRED)
set(PYTHON_INCLUDE_DIR ${Python3_INCLUDE_DIRS})

find_package(ITK REQUIRED)
find_package(Teem REQUIRED NO_MODULE)
include(${Teem_USE_FILE})
find_package(SlicerExecutionModel REQUIRED)
set(SlicerExecutionModel_EXTRA_INCLUDE_DIRECTORIES "" CACHE INTERNAL "" FORCE)
set(SlicerExecutionModel_EXTRA_EXECUTABLE_TARGET_LIBRARIES "" CACHE INTERNAL "" FORCE)

# Qt-only targets referenced unconditionally by Slicer CMake macros.
add_library(qSlicerBaseQTCLI INTERFACE) # SlicerMacroBuildModuleLogic.cmake links it
macro(ctkMacroCompilePythonScript)       # used by Libs/MRML/DisplayableManager/Python
endmacro()
function(ctk_add_executable_utf8)
endfunction()

# Configuration and version headers (Slicer/CMakeLists.txt and SlicerConfigureVersionHeaderTarget.cmake)
set(Slicer_OS "emscripten")
set(Slicer_ARCHITECTURE "wasm32")
set(Slicer_OS_LINUX_NAME "linux")
set(Slicer_OS_MAC_NAME "macosx")
set(Slicer_OS_WIN_NAME "win")
foreach(f vtkSlicerConfigure.h vtkSlicerVersionConfigureMinimal.h vtkSlicerVersionConfigure.h)
  configure_file(${Slicer_SOURCE_DIR}/CMake/${f}.in ${Slicer_BINARY_DIR}/${f})
endforeach()
include_directories(${Slicer_BINARY_DIR})

# vtkITK uses the header-only ITK/VTK image bridge filters of ITK's VtkGlue module.
include_directories(${SlicerWeb_ITK_SOURCE_DIR}/Modules/Bridge/VtkGlue/include)

#-----------------------------------------------------------------------------
# Libs (Slicer/Libs/CMakeLists.txt without Qt and curl)
#-----------------------------------------------------------------------------
set(GENERATECLP_USE_MD5 ON)
set(MRML_APPLICATION_NAME "Slicer" CACHE STRING "" FORCE)
math(EXPR MRML_APPLICATION_VERSION_HEX "1 << 24 | ${Slicer_VERSION_MAJOR} << 16 | ${Slicer_VERSION_MINOR} << 8 | ${Slicer_VERSION_PATCH}" OUTPUT_FORMAT HEXADECIMAL)
string(SUBSTRING "${MRML_APPLICATION_VERSION_HEX}" 3 6 MRML_APPLICATION_VERSION_HEX)
set(MRML_APPLICATION_VERSION "0x${MRML_APPLICATION_VERSION_HEX}" CACHE STRING "" FORCE)
set(MRML_APPLICATION_REVISION "${Slicer_MAIN_PROJECT_REVISION}" CACHE STRING "" FORCE)
set(MRML_APPLICATION_SUPPORT_VERSION "0x030000" CACHE STRING "" FORCE)
set(MRML_APPLICATION_OPENGL_PROFILE_ENV "SLICER_OPENGL_PROFILE")
set(MRML_TEST_DATA_DIR ${Slicer_SOURCE_DIR}/Libs/MRML/Core/Testing/TestData)
# DICOM files are read with GDCM; ITK is built without DCMTK (see cmake/itk/wasm.cmake)
set(VTKITK_BUILD_DICOM_SUPPORT ON)
set(VTKITK_BUILD_DCMTK_SUPPORT OFF)

# ITKFactoryRegistration is a plain library; the others are VTK modules (below)
set(ITKFactoryRegistration_INSTALL_BIN_DIR ${Slicer_INSTALL_LIB_DIR})
set(ITKFactoryRegistration_INSTALL_LIB_DIR ${Slicer_INSTALL_LIB_DIR})
set(ITKFactoryRegistration_INSTALL_NO_DEVELOPMENT ${Slicer_INSTALL_NO_DEVELOPMENT})
# (exported with the other libraries of this project, cmake/SlicerWebSDK.cmake)
add_subdirectory(${Slicer_SOURCE_DIR}/Libs/ITKFactoryRegistration ${CMAKE_BINARY_DIR}/Libs/ITKFactoryRegistration)

# vtkAddon is a package built before (scripts/stages/50-slicer.sh), found as Slicer finds it
find_package(vtkAddon REQUIRED)
include(vtkMacroKitPythonWrap)

# Slicer's libraries (Base/Logic and Libs) and the Qt-free libraries of the loadable modules
# (MRML, Logic, VTKWidgets, MRMLDM) are VTK modules, built as Slicer builds them
# (SlicerVTKModuleBuild.cmake), those of the loadable modules SlicerWeb has. Their Python wrappers are
# modules of the slicer package
# (slicer.MRMLCore), with the former module names (MRMLCorePython) as shims.
# The wrapping is done by the wrapping tools built for the build host (VTKCompileTools), as for VTK.
set(SW_VTK_COMPILETOOLS_DIR "${VTK_DIR}/../../../../vtk-compiletools/lib/cmake/vtkcompiletools-${VTK_VERSION_MAJOR}.${VTK_VERSION_MINOR}")
include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/vtk/project-include.cmake)
include(SlicerVTKModuleHeaderWrapper)
include(SlicerVTKModuleBuild)
include(SlicerVTKModuleAutoInit)
# The modules SlicerWeb does not build are turned off by the module system's own setting,
# VTK_MODULE_ENABLE_<module>: RemoteIO (curl; the web page downloads, and MRML scenes have no handler
# of remote URIs here), those of loadable modules that are not in SlicerWeb_LOADABLE_MODULES, the
# scripted modules' (DICOM) and the templates'.
set(VTK_MODULE_ENABLE_Slicer_RemoteIO NO CACHE STRING "Not built for the browser" FORCE)
vtk_module_find_modules(_module_files ${Slicer_SOURCE_DIR}/Modules ${Slicer_SOURCE_DIR}/Utilities/Templates)
foreach(_module_file IN LISTS _module_files)
  file(READ "${_module_file}" _module_description)
  string(REGEX MATCH "NAME[ \t\r\n]+([^ \t\r\n]+)" _match "${_module_description}")
  set(_module_name "${CMAKE_MATCH_1}")
  set(_wanted OFF)
  foreach(MODULE_NAME IN LISTS SlicerWeb_LOADABLE_MODULES)
    if(_module_file MATCHES "^${Slicer_SOURCE_DIR}/Modules/Loadable/${MODULE_NAME}/")
      set(_wanted ON)
    endif()
  endforeach()
  if(NOT _wanted)
    string(REPLACE "::" "_" _module_name_safe "${_module_name}")
    set(VTK_MODULE_ENABLE_${_module_name_safe} NO CACHE STRING "Not built for the browser" FORCE)
  endif()
endforeach()
slicer_vtk_module_build(
  SOURCE_DIR ${Slicer_SOURCE_DIR}
  BUILD_PYI_FILES OFF)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${Slicer_BINARY_DIR}/${Slicer_BIN_DIR})
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${Slicer_BINARY_DIR}/${Slicer_BIN_DIR})
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${Slicer_BINARY_DIR}/${Slicer_LIB_DIR})
_vtk_module_real_target(SlicerWeb_vtkITK_TARGET Slicer::ITK)

# vtkITK instantiates ITK filters and IO for all pixel types. In a WebAssembly side module every
# exported symbol is preemptible and therefore imported (GOT entry) even when defined locally, which
# makes libvtkITK exceed the browser limits of 100000 imports and 100000 exports per module.
# Bind its own definitions locally, and export only the vtkITK classes (VTK_ITK_EXPORT, generated by
# generate_export_header) instead of every ITK template instantiation.
target_link_options(${SlicerWeb_vtkITK_TARGET} PRIVATE "LINKER:-Bsymbolic")
set_target_properties(${SlicerWeb_vtkITK_TARGET} PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
set(MRML_LIBRARIES MRMLCore MRMLLogic MRMLDisplayableManager MRMLCLI CACHE INTERNAL "MRML libraries" FORCE)
set(Slicer_Libs_VTK_WRAPPED_LIBRARIES
  vtkSegmentationCore vtkTeem vtkITK MRMLCore MRMLLogic vtkAddon MRMLDisplayableManager MRMLCLI
  CACHE INTERNAL "Slicer Libs VTK wrapped" FORCE)

# Base/Logic and the loadable module libraries are among the VTK modules above
set(Slicer_Base_INCLUDE_DIRS "" CACHE INTERNAL "Slicer Base includes" FORCE)
set(Slicer_Base_LIBRARIES SlicerBaseLogic CACHE INTERNAL "Slicer Base libraries" FORCE)

#-----------------------------------------------------------------------------
# SlicerWeb libraries
#-----------------------------------------------------------------------------
include(SlicerWebMacros)
add_subdirectory(Modules/CLI ${CMAKE_BINARY_DIR}/Modules/CLI)
add_subdirectory(SlicerWebCore)
add_subdirectory(Modules)

#-----------------------------------------------------------------------------
# ITK stays inside the libraries that use it
#-----------------------------------------------------------------------------
# Every library that uses ITK compiles its own copy of the ITK class templates it touches - their
# code is in the headers - and each copy brings its own description of those types. The loader
# shares one copy of each symbol between libraries, and which library a copy comes from is settled
# name by name, so a type can end up described by one library while the base it derives from is
# described by another. Code reaches a description through the table the loader fills in, but a
# description's pointer to its base is fixed when its own library is linked, so the two can point
# at different copies of the same thing. dynamic_cast compares them by address and fails, which is
# how itk::Image<bool,2> stopped being an itk::ImageBase<2> and took several vtkITK filters with it:
# grow-cut, contour interpolation, level tracing, island math and the VTK-to-ITK bridge, each
# throwing "cannot cast DataObject to ImageBase<2>" or refusing to downcast its own output.
#
# Marking the ITK templates hidden keeps each library's copies to itself, so every description a
# library casts against is one of its own and they agree. ITK is an implementation detail of these
# two libraries - the ITK objects they make never leave them - and ITK's plain classes (DataObject,
# ProcessObject, the IO factories) are not templates, so they stay shared as before.
#
# This is done for the libraries whose ITK use is entirely their own. MRMLCore is left alone: it
# reads transforms, and the transform objects come from ITK's factory in another library, so its
# casts are between descriptions that have to be shared.
foreach(target ${SlicerWeb_vtkITK_TARGET} SlicerWebCore)
  if(TARGET ${target})
    target_compile_definitions(${target} PRIVATE
      "ITK_TEMPLATE_EXPORT=__attribute__((visibility(\"hidden\")))")
  endif()
endforeach()

#-----------------------------------------------------------------------------
# Extension SDK (build tree): SlicerConfig.cmake for extensions
#-----------------------------------------------------------------------------
include(SlicerWebSDK)

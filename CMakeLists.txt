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

# Version (Slicer/CMakeLists.txt; SlicerVersion.cmake needs git metadata, set explicitly instead)
file(STRINGS "${Slicer_SOURCE_DIR}/CMakeLists.txt" _slicer_version_lines REGEX "set\\(Slicer_VERSION_(MAJOR|MINOR|PATCH) ")
foreach(_line IN LISTS _slicer_version_lines)
  if(_line MATCHES "set\\((Slicer_VERSION_(MAJOR|MINOR|PATCH)) \"?([0-9]+)\"?\\)")
    set(${CMAKE_MATCH_1} ${CMAKE_MATCH_3})
  endif()
endforeach()
set(Slicer_VERSION "${Slicer_VERSION_MAJOR}.${Slicer_VERSION_MINOR}")
set(Slicer_VERSION_FULL "${Slicer_VERSION}.${Slicer_VERSION_PATCH}")
set(Slicer_MAIN_PROJECT Slicer)
set(Slicer_APPLICATION_NAME Slicer)
set(Slicer_MAIN_PROJECT_APPLICATION_NAME Slicer)
foreach(p MAJOR MINOR PATCH)
  set(Slicer_MAIN_PROJECT_VERSION_${p} ${Slicer_VERSION_${p}})
endforeach()
set(Slicer_MAIN_PROJECT_REVISION "0" CACHE STRING "Slicer revision")
set(Slicer_REVISION ${Slicer_MAIN_PROJECT_REVISION})
set(Slicer_RELEASE_TYPE "Experimental")
message(STATUS "Building Slicer ${Slicer_VERSION_FULL} libraries for the browser")

# SlicerDirectories.cmake uses mark_as_superbuild() from ExternalProjectDependency.
macro(mark_as_superbuild)
endmacro()
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
set(ITKFactoryRegistration_SKIP_UNAVAILABLE_IO_MODULES ON)
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
set(Slicer_MAIN_PROJECT_VERSION "${Slicer_VERSION}")
set(Slicer_MAIN_PROJECT_VERSION_FULL "${Slicer_VERSION_FULL}")
string(TIMESTAMP Slicer_BUILDDATE "%Y-%m-%d" UTC)
set(Slicer_MAIN_PROJECT_BUILDDATE "${Slicer_BUILDDATE}")
set(Slicer_WC_REVISION_HASH "" CACHE STRING "Git hash of the Slicer source revision")
set(Slicer_WC_REVISION "${Slicer_WC_REVISION_HASH}")
set(Slicer_MAIN_PROJECT_WC_REVISION "${Slicer_WC_REVISION_HASH}")
set(Slicer_MAIN_PROJECT_WC_REVISION_HASH "${Slicer_WC_REVISION_HASH}")
set(Slicer_WC_URL "https://github.com/Slicer/Slicer.git")
set(Slicer_MAIN_PROJECT_WC_URL "${Slicer_WC_URL}")
set(Slicer_COMMIT_COUNT 0)
set(Slicer_MAIN_PROJECT_COMMIT_COUNT 0)
set(Slicer_REVISION_TYPE "Hash")
set(Slicer_MAIN_PROJECT_REVISION_TYPE "Hash")
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
set(VTKITK_BUILD_DICOM_SUPPORT OFF)

set(_slicerweb_libs
  ITKFactoryRegistration:${Slicer_SOURCE_DIR}/Libs/ITKFactoryRegistration
  vtkAddon:${vtkAddon_SOURCE_DIR}
  vtkTeem:${Slicer_SOURCE_DIR}/Libs/vtkTeem
  vtkITK:${Slicer_SOURCE_DIR}/Libs/vtkITK
  vtkSegmentationCore:${Slicer_SOURCE_DIR}/Libs/vtkSegmentationCore
  MRMLCore:${Slicer_SOURCE_DIR}/Libs/MRML/Core
  MRMLCLI:${Slicer_SOURCE_DIR}/Libs/MRML/CLI
  RemoteIO:${CMAKE_CURRENT_SOURCE_DIR}/Stubs/RemoteIO
  MRMLLogic:${Slicer_SOURCE_DIR}/Libs/MRML/Logic
  MRMLDisplayableManager:${Slicer_SOURCE_DIR}/Libs/MRML/DisplayableManager
  )
set(_include_dirs)
foreach(_entry IN LISTS _slicerweb_libs)
  string(REPLACE ":" ";" _entry "${_entry}")
  list(GET _entry 0 _name)
  list(GET _entry 1 _dir)
  set(${_name}_INSTALL_BIN_DIR ${Slicer_INSTALL_LIB_DIR})
  set(${_name}_INSTALL_LIB_DIR ${Slicer_INSTALL_LIB_DIR})
  set(${_name}_INSTALL_SHARE_DIR ${Slicer_INSTALL_ROOT}share/${_name})
  set(${_name}_INSTALL_NO_DEVELOPMENT ${Slicer_INSTALL_NO_DEVELOPMENT})
  set(${_name}_EXPORT_FILE ${Slicer_BINARY_DIR}/SlicerTargets.cmake)
  if(_name STREQUAL "vtkAddon")
    set(vtkAddon_WRAP_PYTHON ON)
    set(vtkAddon_INSTALL_PYTHON_MODULE_LIB_DIR ${Slicer_INSTALL_LIB_DIR})
    set(vtkAddon_INSTALL_PYTHON_LIB_DIR ${Slicer_INSTALL_LIB_DIR})
  endif()
  message(STATUS "Configuring library: ${_name}")
  add_subdirectory(${_dir} ${CMAKE_BINARY_DIR}/Libs/${_name})
  list(APPEND _include_dirs ${${_name}_INCLUDE_DIRS})
endforeach()
set(Slicer_Libs_INCLUDE_DIRS ${_include_dirs} CACHE INTERNAL "Slicer Libs includes" FORCE)

# vtkITK instantiates ITK filters and IO for all pixel types. In a WebAssembly side module every
# exported symbol is preemptible and therefore imported (GOT entry) even when defined locally, which
# makes libvtkITK exceed the browser limits of 100000 imports and 100000 exports per module.
# Bind its own definitions locally, and export only the vtkITK classes (VTK_ITK_EXPORT, generated by
# generate_export_header) instead of every ITK template instantiation.
target_link_options(vtkITK PRIVATE "LINKER:-Bsymbolic")
set_target_properties(vtkITK PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
set(MRML_LIBRARIES MRMLCore MRMLLogic MRMLDisplayableManager MRMLCLI CACHE INTERNAL "MRML libraries" FORCE)
set(Slicer_Libs_VTK_WRAPPED_LIBRARIES
  vtkSegmentationCore vtkTeem vtkITK MRMLCore MRMLLogic vtkAddon MRMLDisplayableManager MRMLCLI
  CACHE INTERNAL "Slicer Libs VTK wrapped" FORCE)

#-----------------------------------------------------------------------------
# Base/Logic
#-----------------------------------------------------------------------------
set(SlicerBaseLogic_INSTALL_BIN_DIR ${Slicer_INSTALL_LIB_DIR})
set(SlicerBaseLogic_INSTALL_LIB_DIR ${Slicer_INSTALL_LIB_DIR})
add_subdirectory(${Slicer_SOURCE_DIR}/Base/Logic ${CMAKE_BINARY_DIR}/Base/Logic)
set(Slicer_Base_INCLUDE_DIRS
  ${Slicer_SOURCE_DIR}/Base/Logic ${CMAKE_BINARY_DIR}/Base/Logic
  CACHE INTERNAL "Slicer Base includes" FORCE)
set(Slicer_Base_LIBRARIES SlicerBaseLogic CACHE INTERNAL "Slicer Base libraries" FORCE)

#-----------------------------------------------------------------------------
# Loadable modules: only their Qt-free subdirectories
#-----------------------------------------------------------------------------
include(SlicerMacroBuildModuleVTKLibrary)
include(SlicerMacroPythonWrapModuleVTKLibrary)
include(SlicerMacroBuildModuleLogic)
include(SlicerMacroBuildModuleMRML)
foreach(MODULE_NAME IN LISTS SlicerWeb_LOADABLE_MODULES)
  string(TOUPPER ${MODULE_NAME} MODULE_NAME_UPPER)
  set(_module_dir ${Slicer_SOURCE_DIR}/Modules/Loadable/${MODULE_NAME})
  foreach(_sub MRML VTKWidgets Logic MRMLDM)
    if(EXISTS ${_module_dir}/${_sub}/CMakeLists.txt)
      message(STATUS "Configuring module library: ${MODULE_NAME}/${_sub}")
      add_subdirectory(${_module_dir}/${_sub} ${CMAKE_BINARY_DIR}/Modules/Loadable/${MODULE_NAME}/${_sub})
    endif()
  endforeach()
endforeach()

#-----------------------------------------------------------------------------
# SlicerWeb libraries
#-----------------------------------------------------------------------------
include(SlicerWebMacros)
add_subdirectory(SlicerWebCore)
add_subdirectory(Modules)

#-----------------------------------------------------------------------------
# Extension SDK (build tree): SlicerConfig.cmake for extensions
#-----------------------------------------------------------------------------
include(SlicerWebSDK)

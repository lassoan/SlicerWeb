# Slicer_USE_FILE of the SlicerWeb build tree: replaces Slicer's UseSlicer.cmake for extensions.
#
# The same extension source code as for desktop Slicer is configured; what differs:
#  - Python scripted modules are installed as in desktop Slicer.
#  - Loadable modules: their Qt-free libraries (MRML, Logic, VTKWidgets, MRMLDM subdirectories, built
#    with Slicer's own macros and Python-wrapped) are built. The Qt module class and widgets are not
#    built: a module description file (<Name>.slicerweb-module.json) is installed instead, from which
#    the SlicerWeb module manager creates the module (logic) like qSlicerLoadableModule does.
#  - CLI modules are not built (they need a worker/process runner; see the SlicerWeb plan).
#  - Extension packaging (CPack) is replaced by wheel packaging (scripts/make_wheels.py).

if(NOT DEFINED EXTENSION_NAME)
  set(EXTENSION_NAME ${PROJECT_NAME})
endif()
set(EXTENSION_SOURCE_DIR ${CMAKE_SOURCE_DIR})
set(EXTENSION_BINARY_DIR ${CMAKE_BINARY_DIR})
set(EXTENSION_SUPERBUILD_BINARY_DIR ${CMAKE_BINARY_DIR})
set(EXTENSION_BUILD_SUBDIRECTORY ".")
set(${EXTENSION_NAME}_SUPERBUILD OFF CACHE BOOL "SlicerWeb builds extension dependencies separately" FORCE)

list(PREPEND CMAKE_MODULE_PATH ${SlicerWeb_CMAKE_DIR} ${Slicer_CMAKE_DIR} ${Slicer_EXTENSIONS_CMAKE_DIR} ${vtkAddon_CMAKE_DIR})
set(BUILD_SHARED_LIBS ON)
if(NOT DEFINED BUILD_TESTING)
  set(BUILD_TESTING OFF)
endif()
set(VTK_UNDEFINED_SYMBOLS_ALLOWED ON)  # Python symbols come from the Pyodide main module
set(PYTHON_LIBRARY "")
include_directories(${Slicer_BINARY_DIR})  # vtkSlicerConfigure.h, vtkSlicerVersionConfigure.h
include(${ITK_USE_FILE} OPTIONAL)

# Output directories: same layout as the Slicer build tree
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/${Slicer_QTLOADABLEMODULES_LIB_DIR})
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/${Slicer_QTLOADABLEMODULES_BIN_DIR})
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/${Slicer_QTLOADABLEMODULES_LIB_DIR})

#-----------------------------------------------------------------------------
# Superbuild helpers (dependencies are built by the SlicerWeb build scripts)
function(mark_as_superbuild)
endfunction()

#-----------------------------------------------------------------------------
# CTK Python script installation (ctkMacroCompilePythonScript.cmake), without byte compilation
macro(ctkMacroCompilePythonScript)
  cmake_parse_arguments(_CTKPY "NO_INSTALL_SUBDIR;GLOBAL_TARGET"
    "TARGET_NAME;SOURCE_DIR;DESTINATION_DIR;INSTALL_DIR" "SCRIPTS;RESOURCES" ${ARGN})
  if(NOT _CTKPY_SOURCE_DIR)
    set(_CTKPY_SOURCE_DIR ${CMAKE_CURRENT_SOURCE_DIR})
  endif()
  foreach(_ctkpy_file IN LISTS _CTKPY_SCRIPTS _CTKPY_RESOURCES)
    set(_ctkpy_src ${_ctkpy_file})
    if(NOT IS_ABSOLUTE "${_ctkpy_src}")
      set(_ctkpy_src ${_CTKPY_SOURCE_DIR}/${_ctkpy_file})
    endif()
    if(NOT EXISTS "${_ctkpy_src}" AND EXISTS "${_ctkpy_src}.py")
      set(_ctkpy_src "${_ctkpy_src}.py")
      set(_ctkpy_file "${_ctkpy_file}.py")
    endif()
    if(IS_ABSOLUTE "${_ctkpy_file}")
      file(RELATIVE_PATH _ctkpy_file ${_CTKPY_SOURCE_DIR} ${_ctkpy_file})
    endif()
    get_filename_component(_ctkpy_dir "${_CTKPY_DESTINATION_DIR}/${_ctkpy_file}" DIRECTORY)
    file(COPY "${_ctkpy_src}" DESTINATION "${_ctkpy_dir}")
  endforeach()
  set(_ctkpy_install_dir ${_CTKPY_DESTINATION_DIR})
  if(_CTKPY_NO_INSTALL_SUBDIR)
    set(_ctkpy_install_dir ${_CTKPY_DESTINATION_DIR}/)
  endif()
  install(DIRECTORY "${_ctkpy_install_dir}" DESTINATION "${_CTKPY_INSTALL_DIR}" COMPONENT RuntimeLibraries
    PATTERN "__pycache__" EXCLUDE)
endmacro()
function(ctkFunctionAddCompilePythonScriptTargets)
endfunction()

#-----------------------------------------------------------------------------
# Slicer module macros (unchanged)
include(vtkMacroKitPythonWrap)
include(SlicerMacroBuildScriptedModule)
include(SlicerMacroBuildModuleVTKLibrary)
include(SlicerMacroPythonWrapModuleVTKLibrary)
include(SlicerMacroBuildModuleLogic)
include(SlicerMacroBuildModuleMRML)

#-----------------------------------------------------------------------------
# Loadable module: Qt module class replaced by a module description
function(slicerMacroBuildLoadableModule)
  cmake_parse_arguments(MY "WITH_GENERIC_TESTS;NO_INSTALL;NO_TITLE" "NAME;TITLE;EXPORT_DIRECTIVE;FOLDER"
    "SRCS;MOC_SRCS;UI_SRCS;INCLUDE_DIRECTORIES;TARGET_LIBRARIES;RESOURCES" ${ARGN})
  set(_logic_class "")
  if(TARGET vtkSlicer${MY_NAME}ModuleLogic)
    set(_logic_class "vtkSlicer${MY_NAME}Logic")
  endif()
  set(_title "${MY_TITLE}")
  if(NOT _title)
    set(_title "${MY_NAME}")
  endif()
  # Module dependencies (qSlicer<Name>Module::dependencies() returns a QStringList of names)
  set(_deps "")
  set(_module_cxx "${CMAKE_CURRENT_SOURCE_DIR}/qSlicer${MY_NAME}Module.cxx")
  if(EXISTS "${_module_cxx}")
    file(READ "${_module_cxx}" _src)
    if(_src MATCHES "::dependencies\\(\\)[^{]*{([^}]*)}")
      string(REGEX MATCHALL "\"[A-Za-z0-9_]+\"" _dep_list "${CMAKE_MATCH_1}")
      list(JOIN _dep_list ", " _deps)
    endif()
  endif()
  set(_json "${CMAKE_BINARY_DIR}/${Slicer_QTLOADABLEMODULES_LIB_DIR}/${MY_NAME}.slicerweb-module.json")
  file(WRITE "${_json}" "{\"name\": \"${MY_NAME}\", \"title\": \"${_title}\", \"logicClass\": \"${_logic_class}\", \"dependencies\": [${_deps}], \"extension\": \"${EXTENSION_NAME}\"}\n")
  install(FILES "${_json}" DESTINATION ${Slicer_INSTALL_QTLOADABLEMODULES_LIB_DIR} COMPONENT RuntimeLibraries)
  # Resources (e.g. icons, presets) are installed as in desktop Slicer's share directory
  message(STATUS "SlicerWeb: loadable module ${MY_NAME}: Qt module class and widgets are not built (logic: ${_logic_class})")
endfunction()
macro(slicerMacroBuildQtModule)
  slicerMacroBuildLoadableModule(${ARGN})
endmacro()

# Qt libraries of modules are not built
function(SlicerMacroBuildModuleWidgets)
  cmake_parse_arguments(MY "" "NAME" "" ${ARGN})
  message(STATUS "SlicerWeb: Qt widgets library ${MY_NAME} is not built")
  set(${MY_NAME}_INCLUDE_DIRS "" CACHE INTERNAL "" FORCE)
endfunction()
function(SlicerMacroBuildModuleQtLibrary)
  cmake_parse_arguments(MY "" "NAME" "" ${ARGN})
  message(STATUS "SlicerWeb: Qt library ${MY_NAME} is not built")
endfunction()
function(SlicerMacroBuildBaseQtLibrary)
  cmake_parse_arguments(MY "" "NAME" "" ${ARGN})
  message(STATUS "SlicerWeb: Qt library ${MY_NAME} is not built")
endfunction()

# CLI modules are not built
function(SEMMacroBuildCLI)
  cmake_parse_arguments(MY "" "NAME" "" ${ARGN})
  message(STATUS "SlicerWeb: CLI module ${MY_NAME} is not built")
endfunction()
function(slicerMacroBuildCLI)
  SEMMacroBuildCLI(${ARGN})
endfunction()
function(slicerMacroBuildScriptedCLI)
  SEMMacroBuildCLI(${ARGN})
endfunction()

# Tests are not built
function(slicer_add_python_unittest)
endfunction()
function(slicer_add_python_test)
endfunction()
function(simple_test)
endfunction()
function(SlicerMacroConfigureModuleCxxTestDriver)
endfunction()

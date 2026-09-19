# Injected into VTK right after project(VTK) (CMAKE_PROJECT_VTK_INCLUDE).
# Makes VTK use natively built wrapping tools while cross-compiling to wasm.
include_guard(GLOBAL)
# The tools are 64-bit host executables; the package version file would reject them for a 32-bit target.
set(_sw_sizeof_void_p "${CMAKE_SIZEOF_VOID_P}")
set(CMAKE_SIZEOF_VOID_P 8)
find_package(VTKCompileTools REQUIRED
  PATHS "${SW_VTK_COMPILETOOLS_DIR}" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
set(CMAKE_SIZEOF_VOID_P "${_sw_sizeof_void_p}")

# Preprocessor macros of the wasm target, so the host wrapping tools parse headers as em++ does
# (sizeof(long) == 4, __EMSCRIPTEN__, ...). VTK passes them with -undef -imacros.
set(_VTKCompileTools_macros_file "${CMAKE_BINARY_DIR}/sw-wasm-target-macros.h")
execute_process(
  COMMAND "${CMAKE_CXX_COMPILER}" -fPIC -fwasm-exceptions -dM -E -x c++ /dev/null
  OUTPUT_FILE "${_VTKCompileTools_macros_file}"
  RESULT_VARIABLE _sw_macros_result)
if(NOT _sw_macros_result EQUAL 0)
  message(FATAL_ERROR "Failed to extract target macros from ${CMAKE_CXX_COMPILER}")
endif()
if(NOT TARGET VTKCompileTools_macros)
  add_custom_target(VTKCompileTools_macros)
endif()

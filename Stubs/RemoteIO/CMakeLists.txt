# Browser replacement of Slicer's Libs/RemoteIO (curl based).
# In the browser, remote data is downloaded with fetch() by the web application or by Python
# (pyodide.http) into the virtual file system, so vtkHTTPHandler declines all URIs.
project(RemoteIO)

set(lib_name RemoteIO)
add_library(${lib_name} vtkHTTPHandler.cxx)
target_include_directories(${lib_name} PUBLIC
  ${Slicer_SOURCE_DIR}/Libs/RemoteIO
  ${CMAKE_CURRENT_BINARY_DIR}
  ${MRMLCore_INCLUDE_DIRS})
target_link_libraries(${lib_name} MRMLCore)

include(GenerateExportHeader)
generate_export_header(${lib_name}
  EXPORT_FILE_NAME ${CMAKE_CURRENT_BINARY_DIR}/vtkRemoteIOExport.h
  EXPORT_MACRO_NAME VTK_RemoteIO_EXPORT)

install(TARGETS ${lib_name}
  RUNTIME DESTINATION ${Slicer_INSTALL_LIB_DIR} COMPONENT RuntimeLibraries
  LIBRARY DESTINATION ${Slicer_INSTALL_LIB_DIR} COMPONENT RuntimeLibraries
  ARCHIVE DESTINATION ${Slicer_INSTALL_LIB_DIR} COMPONENT Development)

set(RemoteIO_INCLUDE_DIRS ${Slicer_SOURCE_DIR}/Libs/RemoteIO ${CMAKE_CURRENT_BINARY_DIR}
  CACHE INTERNAL "RemoteIO include dirs" FORCE)

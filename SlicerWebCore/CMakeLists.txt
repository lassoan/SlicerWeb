# SlicerWebCore: Qt-free views (render window bound to an HTML canvas + displayable managers).
project(SlicerWebCore)

set(SlicerWebCore_SRCS
  vtkSlicerIOProperties.cxx
  vtkSlicerFileIOHandler.cxx
  vtkSlicerFileReader.cxx
  vtkSlicerFileWriter.cxx
  vtkSlicerFileIOManager.cxx
  vtkSlicerWebView.cxx
  vtkSlicerWebCanvas.cxx
  vtkSlicerWebSliceView.cxx
  vtkSlicerWebThreeDView.cxx
  vtkSlicerWebSegmentEditorWidgetRepresentation.cxx
  vtkSlicerWebSegmentEditorWidget.cxx
  vtkSlicerWebSegmentEditorDisplayableManager.cxx
  vtkSlicerWebCLIModule.cxx
  )

# Not Python-wrapped: the interactor is the views' own (its base class is not wrapped either)
set(SlicerWebCore_NOWRAP_SRCS
  vtkSlicerWebRenderWindowInteractor.cxx
  )
if(EMSCRIPTEN)
  # The render window of a view of a shared canvas (vtkSlicerWebCanvas)
  list(APPEND SlicerWebCore_NOWRAP_SRCS vtkSlicerWebSharedRenderWindow.cxx)
endif()

set(lib_name SlicerWebCore)
add_library(${lib_name} ${SlicerWebCore_SRCS} ${SlicerWebCore_NOWRAP_SRCS})
target_include_directories(${lib_name} PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_BINARY_DIR}
  ${Slicer_Libs_INCLUDE_DIRS}
  ${Slicer_Base_INCLUDE_DIRS}
  ${SlicerExecutionModel_INCLUDE_DIRS}   # ModuleDescription, for the CLI modules built in
  )
target_link_libraries(${lib_name} PUBLIC SlicerBaseLogic MRMLDisplayableManager MRMLLogic MRMLCore ${VTK_LIBRARIES})
# The CLI modules built into the application, which vtkSlicerWebCLIModule hands to the CLI logic
target_link_libraries(${lib_name} PRIVATE ${SlicerWeb_CLI_MODULE_LIBRARIES} ModuleDescriptionParser)

include(GenerateExportHeader)
generate_export_header(${lib_name}
  EXPORT_FILE_NAME ${CMAKE_CURRENT_BINARY_DIR}/vtkSlicerWebCoreExport.h
  EXPORT_MACRO_NAME VTK_SLICER_WEB_CORE_EXPORT)

install(TARGETS ${lib_name}
  LIBRARY DESTINATION ${Slicer_INSTALL_LIB_DIR} COMPONENT RuntimeLibraries
  ARCHIVE DESTINATION ${Slicer_INSTALL_LIB_DIR} COMPONENT Development)

set(${lib_name}_INCLUDE_DIRS ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_BINARY_DIR} CACHE INTERNAL "" FORCE)

include(vtkMacroKitPythonWrap)
vtkMacroKitPythonWrap(
  KIT_NAME ${lib_name}
  KIT_SRCS ${SlicerWebCore_SRCS}
  KIT_INSTALL_BIN_DIR ${Slicer_INSTALL_LIB_DIR}
  KIT_INSTALL_LIB_DIR ${Slicer_INSTALL_LIB_DIR}
  )

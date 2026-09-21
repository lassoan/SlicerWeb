# Initial cache for VTK built as Pyodide-compatible Emscripten side modules with Python wrapping.
set(BUILD_SHARED_LIBS ON CACHE BOOL "")
set(VTK_ENABLE_KITS ON CACHE BOOL "")
set(VTK_VERSIONED_INSTALL OFF CACHE BOOL "")
set(VTK_INSTALL_SDK ON CACHE BOOL "")
set(VTK_BUILD_TESTING OFF CACHE STRING "")
set(VTK_BUILD_EXAMPLES OFF CACHE BOOL "")
set(VTK_BUILD_DOCUMENTATION OFF CACHE BOOL "")
set(VTK_ENABLE_REMOTE_MODULES OFF CACHE BOOL "")
set(VTK_ENABLE_WEBGPU OFF CACHE BOOL "")
set(VTK_ENABLE_CATALYST OFF CACHE BOOL "")
set(VTK_JPEG_ENABLE_SIMD OFF CACHE BOOL "")
set(VTK_LEGACY_REMOVE ON CACHE BOOL "")
# Point and cell ids are 64 bit, as they are in desktop Slicer. A 32-bit build is smaller and
# would do for the meshes a page can hold, but module code written for the desktop hands VTK the
# index arrays NumPy makes, which are 64 bit: with 32-bit ids vtk.util.numpy_support refuses them
# ("Expecting a numpy.int32 array, got int64 instead") and the module fails where it works on the
# desktop.
set(VTK_USE_64BIT_IDS ON CACHE BOOL "")
set(VTK_SMP_IMPLEMENTATION_TYPE Sequential CACHE STRING "")
set(VTK_WEBASSEMBLY_THREADS OFF CACHE BOOL "")
set(VTK_WEBASSEMBLY_64_BIT OFF CACHE BOOL "")
set(VTK_WEBASSEMBLY_LEGACY_EXCEPTIONS ON CACHE BOOL "")   # Pyodide uses legacy wasm EH
set(VTK_WEBASSEMBLY_JS_LIBRARY OFF CACHE BOOL "")        # side modules cannot carry --js-library
set(VTK_WEBASSEMBLY_JOB_POOL_LINK_SIZE 4 CACHE STRING "")
set(VTK_DEFAULT_RENDER_WINDOW_HEADLESS OFF CACHE BOOL "")

# Python wrapping (CPython 3.14 from the Pyodide cross-build environment)
set(VTK_WRAP_PYTHON ON CACHE BOOL "")
set(VTK_PYTHON_VERSION 3 CACHE STRING "")
set(VTK_BUILD_PYI_FILES OFF CACHE BOOL "")
set(VTK_WHEEL_BUILD OFF CACHE BOOL "")
set(VTK_USE_TK OFF CACHE BOOL "")
set(VTK_MODULE_ENABLE_VTK_PythonInterpreter NO CACHE STRING "")
set(VTK_MODULE_ENABLE_VTK_WebPython NO CACHE STRING "")

# Only build what Slicer's Qt-free libraries use (derived from their #includes) plus rendering glue.
foreach(g StandAlone Rendering Imaging Views Web MPI Qt Tk)
  set(VTK_GROUP_ENABLE_${g} DONT_WANT CACHE STRING "")
endforeach()
set(VTK_GROUP_ENABLE_Qt NO CACHE STRING "")
set(VTK_GROUP_ENABLE_MPI NO CACHE STRING "")
set(VTK_GROUP_ENABLE_Tk NO CACHE STRING "")
set(VTK_GROUP_ENABLE_Web NO CACHE STRING "")
foreach(m
    ChartsCore CommonComputationalGeometry CommonCore CommonDataModel CommonExecutionModel CommonMath
    CommonMisc CommonSystem CommonTransforms
    FiltersCore FiltersExtraction FiltersFlowPaths FiltersGeneral FiltersGeometry FiltersHybrid
    FiltersModeling FiltersParallel FiltersSources FiltersTexture FiltersStatistics
    IOCore IOExport IOGeometry IOImage IOInfovis IOLegacy IOPLY IOSQL IOXML IOXMLParser
    ImagingColor ImagingCore ImagingGeneral ImagingHybrid ImagingMath ImagingMorphological ImagingSources
    ImagingStatistics ImagingStencil
    InfovisCore InteractionImage InteractionStyle InteractionWidgets
    RenderingAnnotation RenderingContext2D RenderingContextOpenGL2 RenderingCore RenderingFreeType
    RenderingImage RenderingLabel RenderingOpenGL2 RenderingUI RenderingVolume RenderingVolumeOpenGL2
    TestingCore
    WrappingPythonCore Python)
  set(VTK_MODULE_ENABLE_VTK_${m} YES CACHE STRING "")
endforeach()

# Modules that do not build for wasm or need unavailable software (from VTK .gitlab/ci/configure_wasm_common.cmake)
foreach(m CommonArchive DomainsMicroscopy FiltersONNX FiltersOpenTURNS FiltersReebGraph InfovisBoost
    InfovisBoostGraphAlgorithms InfovisLayout IOADIOS2 IOAlembic IOAMR IOCatalystConduit IOFFMPEG IOGDAL IOLAS
    IOMySQL IONanoVDB IOOCCT IOIFC IOUSD IOODBC IOOpenVDB IOPDAL IOPostgreSQL RenderingExternal
    RenderingFFMPEGOpenGL2 RenderingFreeTypeFontConfig RenderingMatplotlib RenderingOpenVR RenderingOpenXR
    RenderingQt RenderingTk RenderingZSpace fides xdmf3 vtkviskores conduit RenderingWebGPU)
  set(VTK_MODULE_ENABLE_VTK_${m} NO CACHE STRING "")
endforeach()

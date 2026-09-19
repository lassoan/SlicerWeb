# Initial cache for ITK built as Pyodide-compatible Emscripten side modules (shared: one ITK object
# factory registry for all Slicer libraries, like desktop Slicer).
set(BUILD_SHARED_LIBS ON CACHE BOOL "")
set(BUILD_TESTING OFF CACHE BOOL "")
set(BUILD_EXAMPLES OFF CACHE BOOL "")
set(ITK_WRAPPING OFF CACHE BOOL "")
set(ITK_WRAP_PYTHON OFF CACHE BOOL "")
set(ITK_DYNAMIC_LOADING OFF CACHE BOOL "")
set(ITK_USE_GPU OFF CACHE BOOL "")
set(ITK_USE_FFTWD OFF CACHE BOOL "")
set(ITK_USE_FFTWF OFF CACHE BOOL "")
set(ITK_USE_KWSTYLE OFF CACHE BOOL "")
set(ITK_LEGACY_REMOVE OFF CACHE BOOL "")
set(ITK_LEGACY_SILENT ON CACHE BOOL "")
set(ITK_SKIP_PATH_LENGTH_CHECKS ON CACHE BOOL "")
set(ITK_CXX_OPTIMIZATION_FLAGS "" CACHE STRING "")
set(ITK_C_OPTIMIZATION_FLAGS "" CACHE STRING "")
set(KWSYS_USE_MD5 ON CACHE BOOL "")                 # required by SlicerExecutionModel
set(ITK_USE_SYSTEM_ZLIB OFF CACHE BOOL "")          # bundled, mangled zlib-ng
set(GDCM_USE_SYSTEM_OPENJPEG OFF CACHE BOOL "")
set(Module_ITKTBB OFF CACHE BOOL "")
set(ITK_DEFAULT_THREADER Platform CACHE STRING "")

set(ITK_BUILD_DEFAULT_MODULES OFF CACHE BOOL "")
# Modules used by Slicer's Qt-free libraries (derived from their #includes) and the IO factories
# registered by Libs/ITKFactoryRegistration.
foreach(m
    ITKAnisotropicSmoothing ITKCommon ITKConnectedComponents ITKDisplacementField ITKDistanceMap
    ITKIOImageBase ITKIOSpatialObjects ITKIOTransformBase ITKImageCompose ITKImageFilterBase
    ITKImageFunction ITKImageGrid ITKImageIntensity ITKLabelMap ITKPath ITKStatistics ITKThresholding
    ITKTransform ITKTransformFactory ITKVNL ITKVTK ITKRegionGrowing ITKMesh ITKSpatialObjects
    ITKIOGE ITKIOXML ITKExpat
    ITKIOJPEG ITKIOGDCM ITKIOBMP ITKIOLSM ITKIOPNG ITKIOTIFF ITKIOVTK ITKIOStimulate ITKIOBioRad
    ITKIOMeta ITKIOMRC ITKIONIFTI ITKIONRRD ITKIOGIPL ITKIOTransformHDF5 ITKIOTransformInsightLegacy
    ITKIOTransformMatlab
    ITKReview)
  set(Module_${m} ON CACHE BOOL "")
endforeach()
# Remote modules used by Slicer (fetched at configure time)
foreach(m MGHIO GrowCut MorphologicalContourInterpolation GenericLabelInterpolator AdaptiveDenoising)
  set(Module_${m} ON CACHE BOOL "")
endforeach()
# Not available in the browser (threads/network/external libraries)
foreach(m IOOMEZarrNGFF ITKIODCMTK ITKIOMINC IOScanco SimpleITKFilters ITKVtkGlue ITKVideoBridgeOpenCV)
  set(Module_${m} OFF CACHE BOOL "")
endforeach()

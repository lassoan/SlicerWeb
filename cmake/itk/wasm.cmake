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
set(ITK_USE_SYSTEM_ZLIB ON CACHE BOOL "")           # zlib of Pyodide main module (see env.sh)
set(GDCM_USE_SYSTEM_OPENJPEG OFF CACHE BOOL "")
set(Module_ITKTBB OFF CACHE BOOL "")
set(ITK_DEFAULT_THREADER Platform CACHE STRING "")

# Default modules, as desktop Slicer (SuperBuild/External_ITK.cmake builds ITK_BUILD_DEFAULT_MODULES):
# extensions (e.g. VMTK) use ITK filters that Slicer's own libraries do not. ITK_BUILD_DEFAULT_MODULES
# itself cannot be used, because it cannot exclude modules (HDF5 and MINC need programs that are run on
# the build host), so the default module list of ITK 5.4 is given here without HDF5, MINC, GPU and test
# modules. Libraries that Slicer's core does not need are packaged separately (slicerweb-itk-extra).
set(ITK_BUILD_DEFAULT_MODULES OFF CACHE BOOL "" FORCE)
foreach(m
    ITKAntiAlias ITKBiasCorrection ITKBinaryMathematicalMorphology ITKClassifiers ITKColormap 
    ITKConvolution ITKCurvatureFlow ITKDICOMParser ITKDeconvolution ITKDeformableMesh ITKDenoising 
    ITKDiffusionTensorImage ITKDoubleConversion ITKEigen ITKFFT ITKFastMarching ITKFiniteDifference 
    ITKGDCM ITKGIFTI ITKIOBruker ITKIOCSV ITKIOIPL ITKIOJPEG2000 ITKIOMesh ITKIOMeshBYU 
    ITKIOMeshBase ITKIOMeshFreeSurfer ITKIOMeshGifti ITKIOMeshOBJ ITKIOMeshOFF ITKIOMeshVTK 
    ITKIORAW ITKIOSiemens ITKImageAdaptors ITKImageCompare ITKImageFeature ITKImageFrequency 
    ITKImageFusion ITKImageGradient ITKImageLabel ITKImageNoise ITKImageSources ITKImageStatistics 
    ITKJPEG ITKKLMRegionGrowing ITKKWSys ITKLIBLBFGS ITKLabelVoting ITKLevelSets ITKLevelSetsv4 
    ITKMarkovRandomFieldsClassifiers ITKMathematicalMorphology ITKMetaIO ITKMetricsv4 ITKNIFTI 
    ITKNarrowBand ITKNetlib ITKNrrdIO ITKOptimizers ITKOptimizersv4 ITKPDEDeformableRegistration 
    ITKPNG ITKPolynomials ITKQuadEdgeMesh ITKQuadEdgeMeshFiltering ITKRegistrationCommon 
    ITKRegistrationMethodsv4 ITKSignedDistanceFunction ITKSmoothing ITKSpatialFunction 
    ITKSuperPixel ITKTIFF ITKTestKernel ITKVNLInstantiation ITKVideoCore ITKVideoFiltering 
    ITKVideoIO ITKVoronoi ITKWatersheds ITKZLIB )
  set(Module_${m} ON CACHE BOOL "" FORCE)
endforeach()
# Modules used by Slicer's Qt-free libraries (derived from their #includes) and the IO factories
# registered by Libs/ITKFactoryRegistration.
foreach(m
    ITKAnisotropicSmoothing ITKCommon ITKConnectedComponents ITKDisplacementField ITKDistanceMap
    ITKIOImageBase ITKIOSpatialObjects ITKIOTransformBase ITKImageCompose ITKImageFilterBase
    ITKImageFunction ITKImageGrid ITKImageIntensity ITKLabelMap ITKPath ITKStatistics ITKThresholding
    ITKTransform ITKTransformFactory ITKVNL ITKVTK ITKRegionGrowing ITKMesh ITKSpatialObjects
    ITKIOGE ITKIOXML ITKExpat
    ITKIOJPEG ITKIOGDCM ITKIOBMP ITKIOLSM ITKIOPNG ITKIOTIFF ITKIOVTK ITKIOStimulate ITKIOBioRad
    ITKIOMeta ITKIOMRC ITKIONIFTI ITKIONRRD ITKIOGIPL ITKIOTransformInsightLegacy
    ITKIOTransformMatlab)
  set(Module_${m} ON CACHE BOOL "")
endforeach()
# Remote modules used by Slicer (fetched at configure time)
foreach(m MGHIO GrowCut MorphologicalContourInterpolation GenericLabelInterpolator AdaptiveDenoising)
  set(Module_${m} ON CACHE BOOL "")
endforeach()
# Not available in the browser (threads/network/external libraries)
# ITKReview and ITKIOTransformHDF5 need HDF5, whose build runs generator programs on the host.
foreach(m IOOMEZarrNGFF ITKIODCMTK ITKIOMINC IOScanco SimpleITKFilters ITKVtkGlue ITKVideoBridgeOpenCV
    ITKReview ITKIOTransformHDF5 ITKIOHDF5 ITKHDF5 ITKMINC ITKIOTransformMINC)
  set(Module_${m} OFF CACHE BOOL "" FORCE)
endforeach()

# Test driver executable is not needed (and cannot link side modules as a static executable)
set(DO_NOT_BUILD_ITK_TEST_DRIVER ON CACHE BOOL "")

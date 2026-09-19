# Qt-free initialization of the displayable managers of Slicer's core loadable modules
# (what qSlicerMarkupsModule::setup(), qSlicerSegmentationsModule::setup(), ... do on desktop).
slicerweb_add_module_initializer(
  NAME CoreModules
  DISPLAYABLE_MANAGER_LIBRARIES
    vtkSlicerColorsModuleMRMLDisplayableManager
    vtkSlicerMarkupsModuleMRMLDisplayableManager
    vtkSlicerSegmentationsModuleMRMLDisplayableManager
    vtkSlicerTransformsModuleMRMLDisplayableManager
    vtkSlicerVolumeRenderingModuleMRMLDisplayableManager
  SLICE_DISPLAYABLE_MANAGERS
    vtkMRMLColorLegendDisplayableManager
    vtkMRMLMarkupsDisplayableManager
    vtkMRMLSegmentationsDisplayableManager2D
    vtkMRMLTransformsDisplayableManager2D
    vtkMRMLLinearTransformsDisplayableManager
  THREED_DISPLAYABLE_MANAGERS
    vtkMRMLColorLegendDisplayableManager
    vtkMRMLMarkupsDisplayableManager
    vtkMRMLSegmentationsDisplayableManager3D
    vtkMRMLTransformsDisplayableManager3D
    vtkMRMLLinearTransformsDisplayableManager
    vtkMRMLVolumeRenderingDisplayableManager
  )

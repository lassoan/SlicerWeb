"""Descriptors of Slicer's built-in loadable modules.

Each entry replaces a ``qSlicer<Name>Module`` Qt class: it names the module logic class (same as
``createLogic()``), the module dependencies, and performs the non-GUI part of ``setup()``.
Displayable manager registration is done by the generated vtkSlicerWebCoreModulesInitializer class.
"""

import logging
import os

from .modules import LoadableModuleDescriptor

logger = logging.getLogger("slicerweb.modules")


def _before_scene(fn):
    fn.before_scene = True
    return fn


@_before_scene
def _setup_terminologies(module, app, logic):
    # qSlicerTerminologiesModule::createLogic
    contexts = os.path.join(os.path.dirname(app.userSettings().fileName()), "Terminologies")
    os.makedirs(contexts, exist_ok=True)
    logic.SetUserContextsPath(contexts)


def _setup_colors(module, app, logic):
    # qSlicerColorsModule::setup
    appLogic = app.applicationLogic()
    appLogic.SetColorLogic(logic)
    logic.SetMRMLApplicationLogic(appLogic)
    paths = app.userSettings().value("QTCoreModules/Colors/ColorFilePaths", []) or []
    logic.SetUserColorFilePaths(":".join(paths))


def _import_python_lib(name):
    def setup(module, app, logic):
        try:
            __import__(name)
        except Exception as e:  # GUI-only helper libraries may not be available
            logger.debug("Optional module library %s not loaded: %s", name, e)

    return setup


def CORE_MODULES():
    M = LoadableModuleDescriptor
    return [
        M("Cameras", logicClass="vtkSlicerCamerasModuleLogic", categories=["Developer Tools"], hidden=True),
        M("Units", logicClass="vtkSlicerUnitsLogic", categories=["Informatics"], hidden=True),
        M("Terminologies", logicClass="vtkSlicerTerminologiesModuleLogic", categories=["Informatics"],
          setup=_setup_terminologies, hidden=True),
        M("SubjectHierarchy", title="Subject Hierarchy", logicClass="vtkSlicerSubjectHierarchyModuleLogic",
          categories=["Developer Tools"], setup=_import_python_lib("SubjectHierarchyLib"), hidden=True),
        M("Colors", logicClass="vtkSlicerColorLogic", categories=["Informatics"], dependencies=["Terminologies"],
          setup=_setup_colors),
        M("Annotations", logicClass="vtkSlicerAnnotationModuleLogic", categories=["Legacy"],
          dependencies=["SubjectHierarchy"], hidden=True),
        M("Transforms", logicClass="vtkSlicerTransformLogic", categories=[""], dependencies=["Units"]),
        M("GeneralizedReformat", title="Generalized Reformat", logicClass="vtkSlicerGeneralizedReformatLogic",
          categories=["Examples"], hidden=True),
        M("Data", logicClass="vtkSlicerDataModuleLogic", categories=[""], dependencies=["Cameras"]),
        M("Models", logicClass="vtkSlicerModelsLogic", categories=[""], dependencies=["Colors"]),
        M("Plots", logicClass="vtkSlicerPlotsLogic", categories=["Informatics"]),
        M("Segmentations", logicClass="vtkSlicerSegmentationsModuleLogic", categories=[""],
          dependencies=["Terminologies"], webWidget="segmentations"),
        M("Sequences", logicClass="vtkSlicerSequencesLogic", categories=["Sequences"]),
        M("SceneViews", title="Scene Views", logicClass="vtkSlicerSceneViewsModuleLogic", categories=[""],
          dependencies=["Sequences"], hidden=True),
        M("Markups", logicClass="vtkSlicerMarkupsLogic", categories=[""], setup=_import_python_lib("MarkupsLib"),
          webWidget="markups"),
        M("Tables", logicClass="vtkSlicerTablesLogic", categories=["Informatics"]),
        M("Texts", logicClass="vtkSlicerTextsLogic", categories=["Informatics"]),
        M("Reformat", logicClass="vtkSlicerReformatLogic", categories=["Registration.Specialized"]),
        M("ViewControllers", title="View Controllers", logicClass="vtkSlicerViewControllersLogic", categories=[""],
          hidden=True),
        M("Volumes", logicClass="vtkSlicerVolumesLogic", categories=[""], dependencies=["Colors", "Units"],
          webWidget="volumes"),
        M("VolumeRendering", title="Volume Rendering", logicClass="vtkSlicerVolumeRenderingLogic", categories=[""],
          webWidget="volumerendering"),
        M("CropVolume", title="Crop Volume", logicClass="vtkSlicerCropVolumeLogic", categories=["Converters"],
          dependencies=["Volumes"]),
    ]

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
          setup=_setup_colors,
          helpText='The colour tables and colour maps of the scene: what the labels of a segmentation, the scalars of a model and the greys of a volume are painted with.'),
        M("Annotations", logicClass="vtkSlicerAnnotationModuleLogic", categories=["Legacy"],
          dependencies=["SubjectHierarchy"], hidden=True),
        M("Transforms", logicClass="vtkSlicerTransformLogic", categories=[""], dependencies=["Units"],
          helpText='Move, rotate and scale nodes, by hand or with a transform read from a file. A node placed under a transform follows it.'),
        M("GeneralizedReformat", title="Generalized Reformat", logicClass="vtkSlicerGeneralizedReformatLogic",
          categories=["Examples"], hidden=True),
        M("Data", logicClass="vtkSlicerDataModuleLogic", categories=[""], dependencies=["Cameras"],
          helpText='Everything the scene holds, as a tree of subjects, studies and the nodes that belong to them: rename, show, hide and delete them here.'),
        M("Models", logicClass="vtkSlicerModelsLogic", categories=[""], dependencies=["Colors"],
          helpText='Surface meshes: their colour, their opacity, and how they are drawn in the slice views and in 3D.'),
        M("Plots", logicClass="vtkSlicerPlotsLogic", categories=["Informatics"],
          helpText='Charts drawn from the tables of the scene, shown in a plot view of the layout.'),
        M("Segmentations", logicClass="vtkSlicerSegmentationsModuleLogic", categories=[""],
          dependencies=["Terminologies"], webWidget="segmentations",
          helpText='The segments of a segmentation: what they are called, what colour they are and which of them are shown. Painting them is done in Segment Editor.'),
        M("Sequences", logicClass="vtkSlicerSequencesLogic", categories=["Sequences"],
          helpText='A sequence is a series of nodes, one per time point. A browser plays it: it keeps a proxy node at the item it stands on, and that is what the views show.'),
        M("SceneViews", title="Scene Views", logicClass="vtkSlicerSceneViewsModuleLogic", categories=[""],
          dependencies=["Sequences"], hidden=True,
          helpText='Remember the scene as it is now - what is shown, where the cameras look - and go back to it later.'),
        M("Markups", logicClass="vtkSlicerMarkupsLogic", categories=[""], setup=_import_python_lib("MarkupsLib"),
          webWidget="markups",
          helpText='Points, lines, angles, curves, planes and boxes placed in the views, with the measurements they carry.'),
        M("Tables", logicClass="vtkSlicerTablesLogic", categories=["Informatics"],
          helpText='Tables of numbers and text: edit them here, and plot them in the Plots module.'),
        M("Texts", logicClass="vtkSlicerTextsLogic", categories=["Informatics"],
          helpText='Text nodes: notes kept with the scene, and the text that other modules store in it.'),
        M("Reformat", logicClass="vtkSlicerReformatLogic", categories=["Registration.Specialized"],
          helpText='Turn a slice view to any orientation, by its normal or by an angle.'),
        M("ViewControllers", title="View Controllers", logicClass="vtkSlicerViewControllersLogic", categories=[""],
          hidden=True),
        M("Volumes", logicClass="vtkSlicerVolumesLogic", categories=[""], dependencies=["Colors", "Units"],
          webWidget="volumes",
          helpText='Volumes: what they look like (window and level, colour table, threshold) and what they are made of (spacing, origin, dimensions).'),
        M("VolumeRendering", title="Volume Rendering", logicClass="vtkSlicerVolumeRenderingLogic", categories=[""],
          webWidget="volumerendering",
          helpText='Show a volume as a cloud rather than as slices, with a transfer function that decides what is opaque and what is see-through.'),
        M("CropVolume", title="Crop Volume", logicClass="vtkSlicerCropVolumeLogic", categories=["Converters"],
          dependencies=["Volumes"],
          helpText='Cut a volume down to a region of interest, either by taking whole voxels out of it or by resampling it.'),
    ]

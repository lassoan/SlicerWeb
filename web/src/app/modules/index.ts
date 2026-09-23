/** Web GUIs of modules, by module name (or by the webWidget name declared by the module). */
import type { Component } from "vue";
import VolumesPanel from "./VolumesPanel.vue";
import ModelsPanel from "./ModelsPanel.vue";
import MarkupsPanel from "./MarkupsPanel.vue";
import SegmentationsPanel from "./SegmentationsPanel.vue";
import SegmentEditorPanel from "./SegmentEditorPanel.vue";
import VolumeRenderingPanel from "./VolumeRenderingPanel.vue";
import TransformsPanel from "./TransformsPanel.vue";
import DataModulePanel from "./DataModulePanel.vue";
import TextsPanel from "./TextsPanel.vue";
import ColorsPanel from "./ColorsPanel.vue";
import TerminologiesPanel from "./TerminologiesPanel.vue";
import SceneViewsPanel from "./SceneViewsPanel.vue";
import TablesPanel from "./TablesPanel.vue";
import PlotsPanel from "./PlotsPanel.vue";
import SequencesPanel from "./SequencesPanel.vue";
import CropVolumePanel from "./CropVolumePanel.vue";
import ViewControllersPanel from "./ViewControllersPanel.vue";
// Web GUIs of loadable modules of extensions (their desktop GUIs are Qt C++ widgets)
import MarkupsToModelPanel from "./MarkupsToModelPanel.vue";

export const modulePanels: Record<string, Component> = {
  Volumes: VolumesPanel,
  volumes: VolumesPanel,
  Models: ModelsPanel,
  Markups: MarkupsPanel,
  markups: MarkupsPanel,
  Segmentations: SegmentationsPanel,
  segmentations: SegmentationsPanel,
  SegmentEditor: SegmentEditorPanel,
  VolumeRendering: VolumeRenderingPanel,
  volumerendering: VolumeRenderingPanel,
  Transforms: TransformsPanel,
  Data: DataModulePanel,
  Texts: TextsPanel,
  texts: TextsPanel,
  Colors: ColorsPanel,
  colors: ColorsPanel,
  Terminologies: TerminologiesPanel,
  terminologies: TerminologiesPanel,
  SceneViews: SceneViewsPanel,
  sceneviews: SceneViewsPanel,
  Tables: TablesPanel,
  tables: TablesPanel,
  Plots: PlotsPanel,
  plots: PlotsPanel,
  Sequences: SequencesPanel,
  sequences: SequencesPanel,
  CropVolume: CropVolumePanel,
  cropvolume: CropVolumePanel,
  ViewControllers: ViewControllersPanel,
  viewcontrollers: ViewControllersPanel,
  MarkupsToModel: MarkupsToModelPanel,
  markupstomodel: MarkupsToModelPanel,
};

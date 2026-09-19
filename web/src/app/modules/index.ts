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
};

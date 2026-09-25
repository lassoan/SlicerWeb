/*
 * Which module shows a node of this kind, as the subject hierarchy plugins of desktop Slicer decide
 * it, and opening a node there (qSlicerApplication::openNodeModule): the module is opened and
 * selects the node - and, with the role "SegmentID", the segment named by the context, as the
 * Segmentations module of the desktop does (qSlicerSegmentationsModuleWidget::setEditedNode).
 */
import { openModule, store } from "./store";

// A sequence and the browser that plays it both belong to Sequences, where the playback controls are
const MODULE_FOR_CLASS: [string, string][] = [
  ["Sequence", "Sequences"],
  ["Segmentation", "Segmentations"],
  ["Volume", "Volumes"],
  ["Model", "Models"],
  ["Markups", "Markups"],
  ["Transform", "Transforms"],
  ["Table", "Tables"],
  ["PlotChart", "Plots"],
  ["PlotSeries", "Plots"],
  ["Text", "Texts"],
];

/** The module a node of this class is shown in (none known: the module on screen). */
export function moduleForNodeClass(className: string): string {
  return MODULE_FOR_CLASS.find(([name]) => className.includes(name))?.[1] ?? store.activeModule;
}

/** Open the module of a node and select the node there (and a segment, role "SegmentID"). */
export function openNodeModule(nodeID: string, className: string, role = "", context = "") {
  openModule(moduleForNodeClass(className));
  store.selectedNodeClass = className;
  store.selectedNodeID = nodeID;
  store.selectedSegmentID = role === "SegmentID" && context ? context : null;
}

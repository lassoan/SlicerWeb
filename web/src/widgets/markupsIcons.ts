/**
 * The icon of each kind of markups node: the toolbar's markups tools and the Place button of a
 * markups place widget (as desktop Slicer's place button shows the node's add icon) use these, so
 * that a kind of markup looks the same wherever it is placed from.
 */
import type { Component } from "vue";
import { CircleDot, Ruler, Spline, Square, Triangle } from "@lucide/vue";
import ClosedCurveIcon from "@/app/components/icons/ClosedCurveIcon.vue";
import RoiBoxIcon from "@/app/components/icons/RoiBoxIcon.vue";

export const markupsIcons: Record<string, Component> = {
  vtkMRMLMarkupsLineNode: Ruler,
  vtkMRMLMarkupsFiducialNode: CircleDot,
  vtkMRMLMarkupsAngleNode: Triangle,
  vtkMRMLMarkupsCurveNode: Spline,
  vtkMRMLMarkupsClosedCurveNode: ClosedCurveIcon,
  vtkMRMLMarkupsPlaneNode: Square,
  vtkMRMLMarkupsROINode: RoiBoxIcon,
};

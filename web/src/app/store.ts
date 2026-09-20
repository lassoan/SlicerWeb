/** Application state shared by the OHIF-style shell components. */
import { reactive } from "vue";
import type { LoadingProgress } from "@/core/runtime";
import type { SubjectHierarchyItem } from "@/core/bridge";

export interface ModuleSummary {
  name: string;
  title: string;
  categories: string[];
  dependencies: string[];
  hidden: boolean;
  kind: "loadable" | "scripted" | "cli";
  helpText: string;
  acknowledgementText: string;
  contributors: string[];
  webWidget: string | null;
  hasTest?: boolean;
  icon: string | null;
}

export interface LayoutTreeNode {
  type: string; // horizontal | vertical | tab | grid | view | empty
  children?: LayoutTreeNode[];
  size?: number;
  split?: boolean;
  row?: number;
  column?: number;
  rowSpan?: number;
  columnSpan?: number;
  // view
  className?: string;
  layoutName?: string;
  kind?: "slice" | "threeD" | "table" | "plot" | "other";
  nodeID?: string;
  label?: string;
  color?: string;
  orientation?: string;
}

export interface LogEntry {
  time: number;
  level: string;
  origin: string;
  message: string;
}

export const store = reactive({
  status: "loading" as "loading" | "ready" | "error",
  progress: { stage: "", message: "Starting", fraction: 0 } as LoadingProgress,
  error: "" as string,
  modules: [] as ModuleSummary[],
  activeModule: "Data",
  // maximized: layout name of the view shown alone (view controller "maximize" button)
  layout: { layout: 0, description: { type: "empty", children: [] } as LayoutTreeNode, maximized: null as string | null },
  availableLayouts: {} as Record<string, number>,
  activeView: "" as string,
  subjectHierarchy: [] as SubjectHierarchyItem[],
  interactionMode: "ViewTransform" as string,
  logs: [] as LogEntry[],
  leftPanelOpen: true,
  rightPanelOpen: true,
  pythonConsoleOpen: false,
  extensionsManagerOpen: false,
  sceneVersion: 0,
});

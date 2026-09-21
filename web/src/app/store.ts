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
  /** File the module was loaded from (shown by the module finder). */
  path?: string;
  /** Extension the module came from, or null for a module of the application itself. */
  extension?: string | null;
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
  /** Modules that were opened, oldest first, and where in that list the panel stands: what the
   *  back and forward arrows of the module title bar walk through (as the module toolbar of
   *  desktop Slicer does). */
  moduleHistory: ["Data"] as string[],
  moduleHistoryIndex: 0,
  /** Whether the module finder is open under the title bar. */
  moduleFinderOpen: false,
  /** Whether the help and acknowledgment of the module that is open are shown. */
  moduleHelpOpen: false,
  /** Node picked in the subject hierarchy or in a module panel (both follow it). */
  selectedNodeID: null as string | null,
  /** Class of that node, so that a panel can tell whether the selection is one of its own. */
  selectedNodeClass: null as string | null,
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
  logWindowOpen: false,
  extensionsManagerOpen: false,
  sceneVersion: 0,
});

/** Open a module, remembering where the panel has been (see store.moduleHistory). */
export function openModule(name: string) {
  if (store.activeModule === name) {
    return;
  }
  // Opening a module from anywhere but the arrows drops whatever was ahead, as a browser does.
  store.moduleHistory = store.moduleHistory.slice(0, store.moduleHistoryIndex + 1);
  store.moduleHistory.push(name);
  // Only so many are kept; the oldest are forgotten.
  const limit = 50;
  if (store.moduleHistory.length > limit) {
    store.moduleHistory = store.moduleHistory.slice(-limit);
  }
  store.moduleHistoryIndex = store.moduleHistory.length - 1;
  store.activeModule = name;
}

/** Go back (-1) or forward (+1) through the modules that were opened. */
export function stepModuleHistory(step: number) {
  const index = store.moduleHistoryIndex + step;
  if (index < 0 || index >= store.moduleHistory.length) {
    return;
  }
  store.moduleHistoryIndex = index;
  store.activeModule = store.moduleHistory[index];
}

/** The modules that were opened most recently, the current one first, without repeats. */
export function recentModules(limit = 8): string[] {
  const seen: string[] = [];
  for (let i = store.moduleHistory.length - 1; i >= 0 && seen.length < limit; i--) {
    const name = store.moduleHistory[i];
    if (!seen.includes(name)) {
      seen.push(name);
    }
  }
  return seen;
}

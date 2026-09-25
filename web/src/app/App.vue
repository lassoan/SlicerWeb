<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, useTemplateRef, watch } from "vue";
import type { SlicerRuntime } from "@/core/runtime";
import { openNodeModule } from "./nodeModules";
import { openModule, setSetting, store, type LayoutTreeNode, type LogEntry, type ModuleSummary } from "./store";
import { reportGLToApplication } from "../core/glDiagnostics";
import ViewerHeader from "./components/ViewerHeader.vue";
import SidePanel from "./components/SidePanel.vue";
import ViewportGrid from "./components/ViewportGrid.vue";
import LoadingScreen from "./components/LoadingScreen.vue";
import PythonConsole from "./components/PythonConsole.vue";
import LogWindow from "./components/LogWindow.vue";
import ModuleTitleBar from "./components/ModuleTitleBar.vue";
import ExtensionsManager from "./components/ExtensionsManager.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import DataPanel from "./panels/DataPanel.vue";
import ModulePanel from "./panels/ModulePanel.vue";
import { SAMPLE_DATA } from "./sampleData";

const runtime = inject<SlicerRuntime>("runtime")!;
provide("bridge", runtime.bridge);
// Python code may be suspended while the page draws only if the settings allow it (Developer section)
runtime.bridge.allowYielding = () => store.settings["Developer/AllowJSPI"] !== false;

const events = runtime.bridge.events;
events.on<{ layout: number; description: LayoutTreeNode; maximized: string | null }>("layout-changed", (p) => {
  store.layout = p;
});
events.on<ModuleSummary[]>("modules-changed", (modules) => {
  store.modules = modules;
});
events.on<LogEntry>("log", (entry) => {
  store.logs.push(entry);
  if (store.logs.length > 1000) store.logs.splice(0, store.logs.length - 1000);
});
let shTimer: number | undefined;
function scheduleSubjectHierarchyRefresh() {
  window.clearTimeout(shTimer);
  shTimer = window.setTimeout(refreshSubjectHierarchy, 50);
}
events.on("scene-changed", scheduleSubjectHierarchyRefresh);
// A module selected from Python (slicer.util.selectModule): it has been entered there already
events.on<{ name: string }>("select-module", ({ name }) => openModule(name));
// A node opened in its module from Python (slicer.app.openNodeModule), a segment with it
events.on<{ nodeID: string | null; className: string; role: string; context: string }>("open-node-module",
  ({ nodeID, className, role, context }) => { if (nodeID) openNodeModule(nodeID, className, role, context); });
// The eye of a volume shows whether it is shown in the selected view: another view selected, or
// the volumes the views show changed (from a slice controller, say), and the eyes follow.
events.on("views-shown-changed", scheduleSubjectHierarchyRefresh);
// The segments of the segmentations are listed too
events.on("segments-changed", scheduleSubjectHierarchyRefresh);
watch(() => store.activeView, scheduleSubjectHierarchyRefresh);

// What a click in a view does is the scene's to say: a module may change it, and place mode ends
// by itself once something has been placed. The toolbar shows what the scene says, not what was
// last asked of it (see slicerweb.bridge.interactionMode).
events.on<{ mode: string; placeNodeClassName: string }>("interaction-mode", ({ mode, placeNodeClassName }) => {
  store.interactionMode = mode === "Place" && placeNodeClassName ? `Place:${placeNodeClassName}` : mode;
});

// A setting changed from Python (slicer.app.userSettings().setValue(...)) is kept as one changed
// in the dialog would be; only the settings the page offers are the page's to keep.
events.on<Record<string, unknown>>("settings-changed", (values) => {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (key in store.settings) setSetting(key as keyof typeof store.settings, value as never, false);
  }
});

// A renamed node: the name is put where it belongs rather than the whole tree fetched again,
// because renaming is often a person typing and the tree would be rebuilt at every letter.
events.on<{ itemID: number; name: string }>("item-renamed", ({ itemID, name }) => {
  const rename = (items: typeof store.subjectHierarchy): boolean =>
    items.some((item) => (item.id === itemID ? ((item.name = name), true) : rename(item.children ?? [])));
  if (!rename(store.subjectHierarchy)) refreshSubjectHierarchy();
});

async function refreshSubjectHierarchy() {
  if (store.status !== "ready") return;
  store.subjectHierarchy = await runtime.bridge.call("getSubjectHierarchy", [store.activeView || null]);
  store.sceneVersion++;
}

/**
 * The scene of the last session, offered back.
 *
 * A phone reclaims a tab of this size as soon as another application is in front, and starts the
 * page from nothing on return. The scene is kept as the page goes into the background (below), and
 * asked about here, before anything else is loaded: what was there is usually what is wanted.
 */
async function offerLastSession(): Promise<boolean> {
  const info = await runtime.bridge.call<{ savedAt: number; bytes: number; nodes: string[]; count: number } | null>("sessionInfo").catch(() => null);
  if (!info) return false;
  const when = new Date(info.savedAt * 1000);
  const age = Date.now() - when.getTime();
  const saved = age < 24 * 3600 * 1000
    ? `at ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : `on ${when.toLocaleDateString()}`;
  const what = info.nodes.slice(0, 4).join(", ") + (info.count > 4 ? ` and ${info.count - 4} more` : "");
  if (!window.confirm(`Restore the scene from your last session?\n\n${what}\nSaved ${saved}, ${(info.bytes / 1048576).toFixed(0)} MB`)) {
    await runtime.bridge.call("forgetSession").catch(() => {});
    return false;
  }
  store.progress = { stage: "session", message: "Restoring the last session", fraction: 0.9 };
  try {
    await runtime.bridge.call("restoreSession");
    return true;
  } catch (e: any) {
    alert(`The last session could not be restored: ${e.message ?? e}`);
    await runtime.bridge.call("forgetSession").catch(() => {});
    return false;
  }
}

/**
 * Keep the scene as the page goes into the background.
 *
 * That is the moment before a phone reclaims the tab, and the last one this code runs; the
 * page is hidden, so a moment's pause to write the scene is not felt. What is written goes to
 * IndexedDB right away rather than on the usual short delay, since there may be no later.
 */
function keepSessionWhenHidden() {
  let keeping: Promise<unknown> | null = null;
  const keep = () => {
    if (keeping || store.status !== "ready") return;
    keeping = runtime.bridge.call<{ saved: boolean }>("saveSession")
      .then((result) => (result.saved ? runtime.flushPersistentStorage() : undefined))
      .catch((e) => console.warn("The session could not be kept", e))
      .finally(() => (keeping = null));
  };
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && keep());
  window.addEventListener("pagehide", keep);
}

/**
 * Sample data set loaded at startup: `?sample=<name>` URL parameter, else the VITE_DEFAULT_SAMPLE build
 * setting (`?sample=` with an empty value disables it). With `&volumeRendering=1` the volume it
 * loads is also volume rendered, with the preset that suits it (`&volumeRendering=<preset name>`
 * for a given one), so that a link opens on the rendering.
 */
async function loadStartupSample() {
  const params = new URLSearchParams(window.location.search);
  const name = params.has("sample") ? params.get("sample") : (import.meta.env.VITE_DEFAULT_SAMPLE as string | undefined);
  if (!name) return;
  const sample = SAMPLE_DATA.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!sample) {
    console.warn(`Unknown sample data set: ${name}`);
    return;
  }
  try {
    const path = await runtime.downloadFile(sample.url, sample.fileName);
    const loaded = await runtime.bridge.call<string[]>("loadFiles", [[path], sample.properties ?? {}]);
    const rendering = params.get("volumeRendering");
    if (rendering && !/^(0|false|no)$/i.test(rendering)) {
      const volumeID = (loaded ?? []).find((id) => /^vtkMRML\w*VolumeNode\d+$/.test(id) && !/LabelMap/.test(id));
      if (volumeID) {
        const properties: Record<string, unknown> = { visible: true };
        if (!/^(1|true|yes)$/i.test(rendering)) properties.preset = rendering;
        await runtime.bridge.call("setVolumeRendering", [volumeID, properties]);
        await runtime.bridge.call("resetThreeDViews").catch(() => {});
      }
    }
  } catch (e) {
    console.error(`Loading sample data ${name} failed`, e);
  }
}

/**
 * Whether an open side panel lies over the views instead of beside them.
 *
 * A panel beside the views takes width from them, and on a narrow screen - a phone held upright -
 * it takes nearly all of it: the views are left a sliver, and whatever is loaded while they are
 * that shape is fitted to the sliver and stays that small afterwards. So once the panels would
 * leave the views less than a quarter of the width, they lie over them instead, and the views keep
 * the size they are read at.
 */
const RAIL = 33; // the strip that opens a closed panel, with the gap beside it
const shell = useTemplateRef<HTMLElement>("shell");
const shellWidth = ref(window.innerWidth);
const panelsOverlay = computed(() => {
  const left = store.leftPanelOpen ? store.leftPanelWidth : RAIL;
  const right = store.rightPanelOpen ? store.rightPanelWidth : RAIL;
  return shellWidth.value - left - right < shellWidth.value * 0.25;
});

onMounted(async () => {
  const observer = new ResizeObserver(([entry]) => (shellWidth.value = entry.contentRect.width));
  if (shell.value) observer.observe(shell.value);
  onBeforeUnmount(() => observer.disconnect());
  // Small screens (phones): start with collapsed side panels so the views get the space
  if (window.matchMedia("(max-width: 768px)").matches) {
    store.leftPanelOpen = false;
    store.rightPanelOpen = false;
  }
  runtime.onProgress((p) => (store.progress = p));
  try {
    await runtime.start();
    const layout = await runtime.bridge.call<{ layout: number; description: LayoutTreeNode; maximized: string | null; available: Record<string, number> }>(
      "getLayoutDescription",
    );
    store.layout = { layout: layout.layout, description: layout.description, maximized: layout.maximized ?? null };
    store.availableLayouts = layout.available;
    store.modules = await runtime.bridge.call("getModules");
    store.status = "ready";
    reportGLToApplication(runtime.bridge);
    await refreshSubjectHierarchy();
    if (!(await offerLastSession())) await loadStartupSample();
    keepSessionWhenHidden();
  } catch (e: any) {
    console.error(e);
    store.status = "error";
    store.error = String(e?.message ?? e);
  }
});
</script>

<template>
  <div class="flex h-full flex-col bg-background text-foreground select-none">
    <ViewerHeader />
    <div ref="shell" class="relative flex min-h-0 flex-1 flex-row overflow-hidden" style="height: calc(100vh - 52px)">
      <SidePanel side="left" :open="store.leftPanelOpen" :overlay="panelsOverlay" @toggle="store.leftPanelOpen = !store.leftPanelOpen"
        :tabs="[{ id: 'data', label: 'Data' }]">
        <DataPanel />
      </SidePanel>
      <main class="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <ViewportGrid :key="store.settings['Rendering/SharedWebGLContext'] ? 'shared' : 'own'" v-if="store.status === 'ready'" :node="store.layout.description" class="min-h-0 flex-1" />
        <LoadingScreen v-else />
        <LogWindow v-if="store.logWindowOpen" />
        <PythonConsole v-if="store.pythonConsoleOpen" />
      </main>
      <SidePanel side="right" :open="store.rightPanelOpen" :overlay="panelsOverlay" @toggle="store.rightPanelOpen = !store.rightPanelOpen"
        :tabs="[{ id: 'modules', label: 'Modules' }]">
        <template #header><ModuleTitleBar /></template>
        <ModulePanel />
      </SidePanel>
    </div>
    <ExtensionsManager v-if="store.extensionsManagerOpen" @close="store.extensionsManagerOpen = false" />
    <SettingsDialog v-if="store.settingsDialogOpen" @close="store.settingsDialogOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, useTemplateRef } from "vue";
import type { SlicerRuntime } from "@/core/runtime";
import { store, type LayoutTreeNode, type LogEntry, type ModuleSummary } from "./store";
import { reportGLToApplication } from "../core/glDiagnostics";
import ViewerHeader from "./components/ViewerHeader.vue";
import SidePanel from "./components/SidePanel.vue";
import ViewportGrid from "./components/ViewportGrid.vue";
import LoadingScreen from "./components/LoadingScreen.vue";
import PythonConsole from "./components/PythonConsole.vue";
import LogWindow from "./components/LogWindow.vue";
import ModuleTitleBar from "./components/ModuleTitleBar.vue";
import ExtensionsManager from "./components/ExtensionsManager.vue";
import DataPanel from "./panels/DataPanel.vue";
import ModulePanel from "./panels/ModulePanel.vue";
import { SAMPLE_DATA } from "./sampleData";

const runtime = inject<SlicerRuntime>("runtime")!;
provide("bridge", runtime.bridge);

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
events.on("scene-changed", () => {
  window.clearTimeout(shTimer);
  shTimer = window.setTimeout(refreshSubjectHierarchy, 50);
});

// What a click in a view does is the scene's to say: a module may change it, and place mode ends
// by itself once something has been placed. The toolbar shows what the scene says, not what was
// last asked of it (see slicerweb.bridge.interactionMode).
events.on<{ mode: string; placeNodeClassName: string }>("interaction-mode", ({ mode, placeNodeClassName }) => {
  store.interactionMode = mode === "Place" && placeNodeClassName ? `Place:${placeNodeClassName}` : mode;
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
  store.subjectHierarchy = await runtime.bridge.call("getSubjectHierarchy");
  store.sceneVersion++;
}

/**
 * Sample data set loaded at startup: `?sample=<name>` URL parameter, else the VITE_DEFAULT_SAMPLE build
 * setting (`?sample=` with an empty value disables it).
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
    await runtime.bridge.call("loadFiles", [[path], sample.properties ?? {}]);
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
    await loadStartupSample();
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
        <ViewportGrid v-if="store.status === 'ready'" :node="store.layout.description" class="min-h-0 flex-1" />
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
  </div>
</template>

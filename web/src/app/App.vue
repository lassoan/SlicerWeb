<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, useTemplateRef, watch, watchEffect } from "vue";
import type { SlicerRuntime } from "@/core/runtime";
import { openNodeModule } from "./nodeModules";
import { openModule, setSetting, store, type LayoutTreeNode, type LogEntry, type ModuleSummary } from "./store";
import { reportGLToApplication } from "../core/glDiagnostics";
import ViewerHeader from "./components/ViewerHeader.vue";
import SidePanel from "./components/SidePanel.vue";
import ViewportGrid from "./components/ViewportGrid.vue";
import LoadingScreen from "./components/LoadingScreen.vue";
import ActivityIndicator from "./components/ActivityIndicator.vue";
import { downloadProgress, loadFilesShowingProgress, showActivity, clearActivity } from "./activity";
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
// The Segment Editor effect at work, for the mouse mode button; and it stops when another module
// is opened (not when the panel of the Segment Editor is closed: a phone closes it to paint)
events.on<{ effect?: string | null }>("segment-editor-changed", (state) => {
  store.segmentEditorEffect = state?.effect ?? "";
});
watch(() => store.activeModule, (now, before) => {
  if (before === "SegmentEditor" && now !== "SegmentEditor" && store.segmentEditorEffect) {
    runtime.bridge.call("segmentEditorSetEffect", [null]).catch(() => {});
  }
});
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
/**
 * The module that was open, kept for the tab whenever another is opened (sessionStorage: a tab's
 * own, as its session is): a reload does not wait for the session to be written, and the module
 * belongs with the scene it is restored with. Read before anything else opens a module.
 */
const ACTIVE_MODULE_KEY = "slicerweb.activeModule";
const lastActiveModule = (() => {
  try {
    return sessionStorage.getItem(ACTIVE_MODULE_KEY);
  } catch {
    return null;
  }
})();
function rememberActiveModule() {
  watch(() => store.activeModule, (name) => {
    try {
      if (name) sessionStorage.setItem(ACTIVE_MODULE_KEY, name);
    } catch {
      // a private window, say
    }
  }, { immediate: true });
}

async function offerLastSession(): Promise<boolean> {
  const info = await runtime.bridge.call<{ savedAt: number; bytes: number; nodes: string[]; count: number; module?: string | null } | null>("sessionInfo").catch(() => null);
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
    // and the module that was open, if it is still there (an extension may have gone meanwhile)
    const module = lastActiveModule ?? info.module;
    if (module && store.modules.some((m) => m.name === module)) openModule(module);
    return true;
  } catch (e: any) {
    alert(`The last session could not be restored: ${e.message ?? e}`);
    await runtime.bridge.call("forgetSession").catch(() => {});
    return false;
  }
}

/**
 * Keep the scene for the next start: as the page goes into the background, and - with auto-save on
 * (application settings) - while it is used.
 *
 * Going into the background is the moment before a phone reclaims the tab, and the last one this
 * code runs; the page is hidden, so a moment's pause to write the scene is not felt. A reload does
 * not wait for what is written to reach IndexedDB, though, so auto-save also keeps the scene when
 * it has changed and nothing has been done for 5 seconds (so that saving does not interrupt
 * dragging a point). Only what changed is written (slicerweb/session.py). The dot in the lower left
 * corner shows it: red while saving, green when saved.
 */
function keepSession() {
  let keeping: Promise<unknown> | null = null;
  const keep = (showing = false) => {
    if (keeping || store.status !== "ready") return;
    keeping = (async () => {
      if (showing) {
        // Saving blocks the page, so the red dot is drawn first
        store.sessionSaveState = "saving";
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }
      const result = await runtime.bridge.call<{ saved: boolean; changed?: boolean }>("saveSession", [false, store.activeModule ?? null]);
      if (result.saved || result.changed) await runtime.flushPersistentStorage();
      if (showing) {
        store.sessionSaveState = "saved";
        store.sessionSavedAt = Date.now();
      }
    })()
      .catch((e) => {
        console.warn("The session could not be kept", e);
        if (showing) store.sessionSaveState = "";
      })
      .finally(() => (keeping = null));
  };
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && keep());
  window.addEventListener("pagehide", () => keep());

  // Auto-save: whether anything changed is looked at every second (the dot shows it), and it is
  // saved after 5 seconds without input - not while a sequence is being played, which changes its
  // nodes at every frame, nor while Python is in the middle of something
  const IDLE_MS = 5000;
  let lastInput = Date.now();
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchmove"]) {
    window.addEventListener(type, () => (lastInput = Date.now()), { passive: true, capture: true });
  }
  let looking = false;
  window.setInterval(async () => {
    if (!store.settings["General/AutoSave"] || keeping || looking || store.status !== "ready") return;
    if (document.visibilityState !== "visible" || (runtime.bridge as { suspendableCalls?: number }).suspendableCalls) return;
    looking = true;
    try {
      const state = await runtime.bridge.call<{ unsaved: boolean; playing: boolean }>("sessionState");
      if (keeping || !store.settings["General/AutoSave"]) return;   // may have changed meanwhile
      if (state.unsaved) store.sessionSaveState = "unsaved";
      else if (store.sessionSaveState === "unsaved") store.sessionSaveState = "saved";
      if (state.unsaved && !state.playing && Date.now() - lastInput >= IDLE_MS) keep(true);
    } catch {
      // not now; the next look will tell
    } finally {
      looking = false;
    }
  }, 1000);
}

/**
 * Data loaded at startup: the files of the `?url=<address of a file>` URL parameters (one or more),
 * else the sample data set of `?sample=<name>`, else that of the VITE_DEFAULT_SAMPLE build setting
 * (`?sample=` with an empty value disables it). A file of a server that does not allow cross-origin
 * requests is read through the site's download proxy, where it has one (runtime.downloadFile). With
 * `&volumeRendering=1` the volume it loads is also volume rendered, with the preset that suits it
 * (`&volumeRendering=<preset name>` for a given one), so that a link opens on the rendering.
 */
async function loadStartupSample() {
  const params = new URLSearchParams(window.location.search);
  const urls = params.getAll("url").filter(Boolean);
  const name = params.has("sample") ? params.get("sample") : (import.meta.env.VITE_DEFAULT_SAMPLE as string | undefined);
  if (!urls.length && !name) return;
  const sample = urls.length ? null : SAMPLE_DATA.find((s) => s.name.toLowerCase() === name!.toLowerCase());
  if (!urls.length && !sample) {
    console.warn(`Unknown sample data set: ${name}`);
    return;
  }
  // The data is downloaded and loaded showing how far along it is (activity.ts)
  const displayName = (url: string) => {
    try {
      return decodeURIComponent(new URL(url, document.baseURI).pathname.split("/").pop() || "data");
    } catch {
      return "data";
    }
  };
  const what = sample ? sample.name : urls.length === 1 ? displayName(urls[0]) : `${urls.length} files`;
  try {
    showActivity(`Downloading ${what}`);
    const paths = sample
      ? [await runtime.downloadFile(sample.url, sample.fileName, undefined, { onProgress: downloadProgress(sample.name) })]
      : await Promise.all(urls.map((url) => runtime.downloadFile(url, undefined, undefined, { onProgress: downloadProgress(displayName(url)) })));
    const loaded = await loadFilesShowingProgress<string[]>(runtime.bridge, "loadFiles", [paths, sample?.properties ?? {}], what);
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
    console.error(`Loading ${urls.length ? urls.join(", ") : "sample data " + name} failed`, e);
  } finally {
    clearActivity();
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
// A narrow screen held upright (a phone): the strips would take a sixth of the width from the views,
// so the panels are opened from buttons at the ends of the toolbar instead
const windowSize = ref({ width: window.innerWidth, height: window.innerHeight });
window.addEventListener("resize", () => (windowSize.value = { width: window.innerWidth, height: window.innerHeight }));
watchEffect(() => {
  store.panelButtons = windowSize.value.width < 600 && windowSize.value.height > windowSize.value.width;
});
// The log window covers the views and the panels on a small screen (a phone, upright or sideways): a
// strip below the views would show a few words of a message, with its buttons in the way
const logWindowFills = computed(() => windowSize.value.width < 768 || windowSize.value.height < 600);
const panelsOverlay = computed(() => {
  // a phone held upright: always over the views, whose width is little enough already
  if (store.panelButtons) return true;
  const rail = RAIL;
  const left = store.leftPanelOpen ? store.leftPanelWidth : rail;
  const right = store.rightPanelOpen ? store.rightPanelWidth : rail;
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
    keepSession();
    rememberActiveModule();
  } catch (e: any) {
    console.error(e);
    store.status = "error";
    store.error = String(e?.message ?? e);
  }
});

// Keyboard shortcuts of desktop Slicer's windows: Ctrl+3 the Python console, Ctrl+0 the
// application log (the error log there), Ctrl+4 the Extensions Manager - each shows or hides it
// (Cmd on a Mac). Taken before a text field gets the key, so that they work while typing in the
// console too.
const windowShortcuts: Record<string, () => void> = {
  "3": () => { store.pythonConsoleOpen = !store.pythonConsoleOpen; },
  "0": () => { store.logWindowOpen = !store.logWindowOpen; },
  "4": () => { store.extensionsManagerOpen = !store.extensionsManagerOpen; },
};
function onWindowShortcut(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  const digit = /^(Digit|Numpad)(\d)$/.exec(event.code)?.[2];
  const toggle = digit !== undefined ? windowShortcuts[digit] : undefined;
  if (!toggle) return;
  event.preventDefault();
  event.stopPropagation();
  toggle();
}
onMounted(() => window.addEventListener("keydown", onWindowShortcut, { capture: true }));

// Files dropped where nothing takes them (the views, a panel while 3D Slicer is loading) would have
// the browser open them in place of the application: nothing happens, and the cursor says so
function onStrayDrag(event: DragEvent) {
  if (event.defaultPrevented) return;
  event.preventDefault();
  if (event.type === "dragover" && event.dataTransfer) event.dataTransfer.dropEffect = "none";
}
onMounted(() => {
  window.addEventListener("dragover", onStrayDrag);
  window.addEventListener("drop", onStrayDrag);
});
onBeforeUnmount(() => {
  window.removeEventListener("dragover", onStrayDrag);
  window.removeEventListener("drop", onStrayDrag);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onWindowShortcut, { capture: true }));
</script>

<template>
  <div class="flex h-full flex-col bg-background text-foreground select-none">
    <ViewerHeader />
    <div ref="shell" class="relative flex min-h-0 flex-1 flex-row overflow-hidden" style="height: calc(100vh - 52px)">
      <SidePanel side="left" :open="store.leftPanelOpen" :overlay="panelsOverlay" :no-strip="store.panelButtons" @toggle="store.leftPanelOpen = !store.leftPanelOpen" :disabled="store.status !== 'ready'"
        :tabs="[{ id: 'data', label: 'Data' }]">
        <DataPanel />
      </SidePanel>
      <main class="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <ViewportGrid :key="`${store.settings['Rendering/SharedWebGLContext'] ? 'shared' : 'own'}-${store.settings['Rendering/MaximumPixelRatio']}`" v-if="store.status === 'ready'" :node="store.layout.description" class="min-h-0 flex-1" />
        <LoadingScreen v-else />
        <ActivityIndicator />
        <LogWindow v-if="store.logWindowOpen && !logWindowFills" />
        <PythonConsole v-if="store.pythonConsoleOpen" />
      </main>
      <SidePanel side="right" :open="store.rightPanelOpen" :overlay="panelsOverlay" :no-strip="store.panelButtons" @toggle="store.rightPanelOpen = !store.rightPanelOpen" :disabled="store.status !== 'ready'"
        :tabs="[{ id: 'modules', label: 'Modules' }]">
        <template #header><ModuleTitleBar /></template>
        <ModulePanel />
      </SidePanel>
      <!-- on a small screen the log covers the views and the panels: beside open panels there would be
           room for a few words only -->
      <LogWindow v-if="store.logWindowOpen && logWindowFills" fill />
    </div>
    <ExtensionsManager v-if="store.extensionsManagerOpen" @close="store.extensionsManagerOpen = false" />
    <SettingsDialog v-if="store.settingsDialogOpen" @close="store.settingsDialogOpen = false" />
    <!-- auto-save, in muted colors: unsaved changes (close to the background), saving (red), all
         changes saved (green) -->
    <div v-if="store.settings['General/AutoSave'] && store.sessionSaveState" data-name="autosave-indicator"
      class="pointer-events-auto fixed bottom-2 left-2 z-[70] h-2.5 w-2.5 rounded-full"
      :class="{ unsaved: 'bg-muted-foreground/25', saving: 'bg-red-400/60', saved: 'bg-green-500/50' }[store.sessionSaveState]"
      :data-state="store.sessionSaveState"
      :title="{ unsaved: 'Unsaved changes: saved after 5 seconds without input',
        saving: 'Saving the scene…',
        saved: `All changes saved (${new Date(store.sessionSavedAt).toLocaleTimeString()})` }[store.sessionSaveState]" />
  </div>
</template>

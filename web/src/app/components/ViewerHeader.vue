<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import {
  Crosshair,
  Box,
  Camera,
  Contrast,
  Hand,
  LayoutPanelLeft,
  Maximize,
  Move3d,
  MousePointerClick,
  Puzzle,
  ScanSearch,
  ScrollText,
  Menu,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  LayoutGrid,
  SlidersHorizontal,
  Terminal,
  Brush,
  Eraser,
  PenLine,
  Scissors,
  Sparkles,
  Waves,
} from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import type { BuildInfo, GitVersion, SlicerRuntime } from "@/core/runtime";
import { openModule as openModuleInPanel, store } from "../store";
import { moduleList } from "../modules/list";
import { appConfig } from "@/core/appConfig";
import ToolButton from "./ToolButton.vue";
import ToolMenu from "./ToolMenu.vue";
import { markupsIcons } from "@/widgets/markupsIcons";
import ScrollSlicesIcon from "./icons/ScrollSlicesIcon.vue";
import LayoutSelector from "./LayoutSelector.vue";

const bridge = inject<SlicerBridge>("bridge")!;
const runtime = inject<SlicerRuntime>("runtime")!;
const ready = computed(() => store.status === "ready");

// The version, at the end of the application menu: when the runtime was built and from which commits
// of SlicerWeb and of the application's repository (wheels/build-info.json), and the commit of the
// web application where it is not the one the runtime was built from.
const buildInfo = ref<BuildInfo | null>(null);
onMounted(async () => { buildInfo.value = await runtime.buildInfo().catch(() => null); });
const appVersion = typeof __SLICERWEB_APP_VERSION__ === "string" ? __SLICERWEB_APP_VERSION__ : "";
const versionLines = computed(() => {
  const lines: { text: string; title: string }[] = [];
  const version = (v: GitVersion) => `${v.commit.slice(0, 7)}${v.modified ? " (modified)" : ""}`;
  const info = buildInfo.value;
  if (info?.date) {
    const date = new Date(info.date);
    lines.push({ text: `Built ${Number.isNaN(date.getTime()) ? info.date : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`, title: info.date });
  }
  if (info?.application?.commit) {
    lines.push({ text: `${info.application.name.split("/").pop()} ${version(info.application)}`, title: `${info.application.name} ${info.application.commit}` });
  }
  if (info?.slicerweb?.commit) lines.push({ text: `SlicerWeb ${version(info.slicerweb)}`, title: `SlicerWeb ${info.slicerweb.commit}` });
  const app = appVersion.replace(/\+$/, "");
  if (app && app !== info?.slicerweb?.commit) {
    const modified = appVersion.endsWith("+") ? " (modified)" : "";
    lines.push({ text: `${info?.slicerweb ? "Application" : "SlicerWeb"} ${app.slice(0, 7)}${modified}`, title: `web application ${app}${modified}` });
  }
  return lines;
});
const layoutOpen = ref(false);
const layoutAnchor = useTemplateRef<HTMLElement>("layoutAnchor");

async function setMode(mode: string) {
  store.interactionMode = mode;
  await bridge.call("setInteractionMode", [mode]);
}

async function place(className: string) {
  store.interactionMode = "Place:" + className;
  lastMarkupTool.value = className;
  await bridge.call("placeMarkup", [className]);
}

/** Show the current view alone (the one last used, else the red slice view), or, when a view is
 *  maximized, restore the layout: what the button in the header of each view does, for the view at
 *  hand. */
async function toggleMaximized() {
  await bridge.call("maximizeView", [store.layout.maximized || store.activeView || "Red"]);
}

/** Show or hide the crosshair. Moving it (shift + mouse, or a click where it is placed) centers the
 *  other slice views on the point (centered jump), so that it is in the middle of each. */
async function toggleCrosshair() {
  const mode = await bridge.evalPython(`(lambda n: (
    n.SetCrosshairBehavior(n.CenteredJumpSlice),
    n.SetCrosshairMode(0 if n.GetCrosshairMode() else 2),
    n.GetCrosshairMode())[-1])(__import__("slicer").mrmlScene.GetFirstNodeByClass("vtkMRMLCrosshairNode"))`, "eval");
  store.crosshairOn = String(mode) !== "0";
}

async function resetViews() {
  await bridge.call("fitSliceViews");
  await bridge.call("resetThreeDViews");
}

const iconUrl = import.meta.env.BASE_URL + "slicer-icon.png";

function fullScreen() {
  document.documentElement.requestFullscreen?.();
}

function openModule(name: string) {
  openModuleInPanel(name);
  store.rightPanelOpen = true;
}

// A line first, and offered first: measuring a distance is what a markup is wanted for most often.
// (the icons are those of markups place widgets too: widgets/markupsIcons.ts)
const markupTools = [
  { cls: "vtkMRMLMarkupsLineNode", label: "Line" },
  { cls: "vtkMRMLMarkupsFiducialNode", label: "Point list" },
  { cls: "vtkMRMLMarkupsAngleNode", label: "Angle" },
  { cls: "vtkMRMLMarkupsCurveNode", label: "Open curve" },
  { cls: "vtkMRMLMarkupsClosedCurveNode", label: "Closed curve" },
  { cls: "vtkMRMLMarkupsPlaneNode", label: "Plane" },
  { cls: "vtkMRMLMarkupsROINode", label: "ROI" },
].map((tool) => ({ ...tool, icon: markupsIcons[tool.cls] }));

/**
 * Whether the toolbar is too narrow for all of its buttons.
 *
 * Rather than guess from the width of the window, the toolbar is measured: if it does not fit, the
 * width it wanted is remembered, and the buttons fold into menus until there is that much room
 * again. Remembering it is what keeps the toolbar from flickering between the two - folded, it
 * would fit, and would unfold, and would not fit.
 */
const nav = useTemplateRef<HTMLElement>("nav");
const compact = ref(false);
const wanted = ref(0);

function measure() {
  const element = nav.value;
  if (!element) return;
  if (!compact.value) {
    if (element.scrollWidth > element.clientWidth + 1) {
      wanted.value = element.scrollWidth;
      compact.value = true;
    }
  } else if (wanted.value && element.clientWidth >= wanted.value + 8) {
    compact.value = false;
  }
}

onMounted(() => {
  const observer = new ResizeObserver(() => measure());
  if (nav.value) observer.observe(nav.value);
  onBeforeUnmount(() => observer.disconnect());
  measure();
});
// A button appears or goes as the application becomes ready, so measure again when it does.
watch(ready, () => nextTick(measure));

/** The mouse modes, for the single button they fold into: what a click in a view does. */
const mouseModes = computed(() => [
  { mode: "ViewTransform", label: "Rotate / Pan / Zoom", icon: Hand },
  { mode: "AdjustWindowLevel", label: "Window / Level", icon: Contrast },
  // Browsing the slices by dragging up and down in a slice view, as radiology viewers offer
  { mode: "Scroll", label: "Scroll slices", icon: ScrollSlicesIcon },
  // Placing is a mode like the others, and the only one a click in a view adds something in. It
  // places the kind of markup made last; which kind that is belongs to the New markup button.
  { mode: "Place", label: "Place points", icon: MousePointerClick },
]);
const placing = computed(() => store.interactionMode.startsWith("Place:"));
/** A Segment Editor effect that is used with the mouse in the views (Paint, Draw, Scissors, ...) is
 *  a mouse mode while it is selected. Choosing another mode (to scroll the slices, say) does not end
 *  it: it waits, and choosing its mode again takes up where it was. */
const effectIcons: Record<string, unknown> = { Paint: Brush, Erase: Eraser, Draw: PenLine, Scissors, Smoothing: Waves, Islands: Sparkles };
const effectLabels: Record<string, string> = { Smoothing: "Smoothing brush", Islands: "Select island" };
const segmentEditMode = computed(() =>
  store.segmentEditorEffect && store.segmentEditorTakesMouse
    ? { mode: "SegmentEdit", label: `${effectLabels[store.segmentEditorEffect] ?? store.segmentEditorEffect} (Segment Editor)`,
        icon: effectIcons[store.segmentEditorEffect] ?? Brush }
    : null);
/** The effect has the views (rather than waiting while another mouse mode has them). */
const segmentEditing = computed(() => !!segmentEditMode.value && !store.segmentEditorSuspended);
const modeActive = (mode: string) =>
  !segmentEditing.value && (mode === "Place" ? placing.value : store.interactionMode === mode);
const currentMouseMode = computed(() =>
  (segmentEditing.value ? segmentEditMode.value : null)
  ?? mouseModes.value.find((m) => m.mode === store.interactionMode)
  ?? (placing.value ? mouseModes.value.find((m) => m.mode === "Place")! : mouseModes.value[0]));

/** Enter a mouse mode; placing means placing the kind of markup made last. A Segment Editor effect
 *  that had the mouse waits meanwhile. */
async function chooseMode(mode: string) {
  if (segmentEditing.value) await bridge.call("segmentEditorSuspend", [true]);
  return mode === "Place" ? place(lastMarkupTool.value) : setMode(mode);
}

/** The effect's own mouse mode: back to the effect if it was waiting, else to its module. */
async function chooseSegmentEditMode() {
  if (store.segmentEditorSuspended) {
    if (placing.value) await setMode("ViewTransform");   // (no points placed meanwhile)
    await bridge.call("segmentEditorSuspend", [false]);
  } else {
    openModule("SegmentEditor");
  }
}

/** The modules the toolbar offers (Slicer's setting of favorite modules, Application settings >
 *  Modules), or those the address names for this page (?favoriteModules=SegmentEditor,Markups: an
 *  embedding page's own, not kept as a setting). A module that is not loaded is left out. */
const favouritesFromAddress = (() => {
  const value = new URLSearchParams(window.location.search).get("favoriteModules");
  return value === null ? null : value.split(/[,;\s]+/).filter(Boolean);
})();
const moduleIcons: Record<string, unknown> = { SegmentEditor: Brush, VolumeRendering: Box, Transforms: Move3d, SceneViews: Camera };
const favouriteModules = computed(() =>
  (favouritesFromAddress ?? store.settings["Modules/FavoriteModules"] ?? []).flatMap((name) => {
    const module = moduleList.value.find((m) => m.name === name);
    return module ? [{ name, label: module.title || name, icon: moduleIcons[name] ?? null, iconUrl: module.icon }] : [];
  }));
// More or fewer buttons: whether they fit is measured again
watch(() => favouriteModules.value.map((m) => m.name).join(), () => { compact.value = false; nextTick(measure); });

/** The markup kind the menu button shows: the one being placed, else the one placed last. */
const lastMarkupTool = ref("vtkMRMLMarkupsLineNode");
const currentMarkupTool = computed(() =>
  markupTools.find((t) => t.cls === (store.interactionMode.startsWith("Place:") ? store.interactionMode.slice("Place:".length) : lastMarkupTool.value))
  ?? markupTools[0]);


</script>

<template>
  <header class="relative z-50 flex h-[52px] shrink-0 items-center justify-between bg-background px-3">
    <!-- A phone held upright: the Data panel opens from here, not from a strip beside the views -->
    <ToolButton v-if="store.panelButtons" label="Data panel" :active="store.leftPanelOpen" data-name="leftPanelButton"
      class="mr-1" @click="store.leftPanelOpen = !store.leftPanelOpen"><PanelLeft :size="20" /></ToolButton>
    <div class="flex shrink-0 items-center gap-3 md:min-w-[240px]">
      <img :src="iconUrl" alt="" class="h-7 w-7 shrink-0" />
      <div class="leading-tight max-md:hidden">
        <div class="text-[15px] font-semibold tracking-wide text-foreground">3D Slicer</div>
        <div class="text-[11px] text-muted-foreground">Web</div>
      </div>
    </div>

    <!-- [&>*]:shrink-0 so that the buttons keep their size and the toolbar overflows instead of
         squeezing them: overflowing is what tells it to fold them into menus (see measure()). -->
    <!-- centered in the room between the logo and the application menu; where the buttons do not
         fit, packed to the left instead (safe centering), so that the first ones stay reachable -->
    <nav ref="nav" class="flex min-w-0 flex-1 items-center justify-center-safe gap-1 overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0 max-md:mx-2"
      :class="{ 'pointer-events-none opacity-40': !ready }" aria-label="Toolbar">
      <div ref="layoutAnchor" class="relative shrink-0">
        <ToolButton label="Layout" @click="layoutOpen = !layoutOpen"><LayoutPanelLeft :size="20" /></ToolButton>
        <!-- the crosshair is in the layout menu here: a mark on the button says it is on -->
        <span v-if="compact && store.crosshairOn" class="pointer-events-none absolute right-0.5 bottom-0.5 rounded-full bg-background text-highlight"
          data-name="crosshairBadge"><Crosshair :size="12" /></span>
        <LayoutSelector v-if="layoutOpen" :anchor="layoutAnchor" @close="layoutOpen = false">
          <!-- Too narrow for them of their own: what is done to the views joins the layouts. -->
          <template v-if="compact" #views="{ close }">
            <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60" @click="resetViews(); close()">
              <ScanSearch :size="16" />Reset views
            </button>
            <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]"
              :class="store.layout.maximized ? 'bg-accent text-highlight' : 'hover:bg-accent/60'"
              data-name="maximizeMenuItem" @click="toggleMaximized(); close()">
              <Minimize2 v-if="store.layout.maximized" :size="16" /><Maximize2 v-else :size="16" />
              {{ store.layout.maximized ? "Restore layout" : "Maximize view" }}
            </button>
            <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]"
              :class="store.crosshairOn ? 'bg-accent text-highlight' : 'hover:bg-accent/60'" :aria-pressed="store.crosshairOn"
              data-name="crosshairMenuItem" @click="toggleCrosshair(); close()">
              <Crosshair :size="16" />{{ store.crosshairOn ? "Crosshair: on" : "Crosshair" }}
            </button>
          </template>
        </LayoutSelector>
      </div>

      <!-- With room for everything, every button is its own -->
      <template v-if="!compact">
        <ToolButton label="Reset views" @click="resetViews"><ScanSearch :size="20" /></ToolButton>
        <ToolButton :label="store.layout.maximized ? 'Restore layout' : 'Maximize view'" :active="!!store.layout.maximized"
          data-name="maximizeButton" @click="toggleMaximized">
          <Minimize2 v-if="store.layout.maximized" :size="20" /><Maximize2 v-else :size="20" />
        </ToolButton>
        <ToolButton label="Crosshair" :active="store.crosshairOn" data-name="crosshairButton" @click="toggleCrosshair"><Crosshair :size="20" /></ToolButton>
        <div class="mx-1 h-6 w-px shrink-0 bg-input" />
        <ToolButton v-for="m in mouseModes" :key="m.mode" :label="m.label"
          :active="modeActive(m.mode)" @click="chooseMode(m.mode)">
          <component :is="m.icon" :size="20" />
        </ToolButton>
        <ToolButton v-if="segmentEditMode" :label="segmentEditMode.label" :active="segmentEditing" data-name="segmentEditMode"
          @click="chooseSegmentEditMode()">
          <component :is="segmentEditMode.icon" :size="20" />
        </ToolButton>
        <div class="mx-1 h-6 w-px shrink-0 bg-input" />
      </template>

      <!-- Too narrow for a button each: what a click in a view does becomes one menu -->
      <template v-if="compact">
        <!-- What a click in a view does. Placing is one of the three, and places the kind of
             markup chosen last; which kind that is belongs to the button beside this one. -->
        <ToolMenu label="Mouse mode" :active="segmentEditing || store.interactionMode !== 'ViewTransform'">
          <template #button><component :is="currentMouseMode.icon" :size="20" /></template>
          <button v-if="segmentEditMode" type="button" role="menuitem" data-name="segmentEditMode"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]"
            :class="segmentEditing ? 'bg-accent text-highlight' : 'hover:bg-accent/60'"
            @click="chooseSegmentEditMode()">
            <component :is="segmentEditMode.icon" :size="16" />{{ segmentEditMode.label }}
          </button>
          <button v-for="m in mouseModes" :key="m.mode" type="button" role="menuitem"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]"
            :class="modeActive(m.mode) ? 'bg-accent text-highlight' : 'hover:bg-accent/60'"
            @click="chooseMode(m.mode)">
            <component :is="m.icon" :size="16" />{{ m.label }}
          </button>
        </ToolMenu>
      </template>

      <!-- A new markup, of whichever kind. Not a state to be in but something done, so the button
           holds nothing to switch off; that a click in a view now places points is said by the
           mouse mode. The icon is the kind made last, to make another in one tap. -->
      <ToolMenu label="New markup">
        <template #button><component :is="currentMarkupTool.icon" :size="20" /></template>
        <button v-for="t in markupTools" :key="t.cls" type="button" role="menuitem"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          @click="place(t.cls)">
          <component :is="t.icon" :size="16" />{{ t.label }}
        </button>
      </ToolMenu>

      <template v-if="!compact">
        <div class="mx-1 h-6 w-px shrink-0 bg-input" />
        <ToolButton v-for="m in favouriteModules" :key="m.name" :label="m.label" @click="openModule(m.name)">
          <component v-if="m.icon" :is="m.icon" :size="20" />
          <img v-else-if="m.iconUrl" :src="m.iconUrl" alt="" class="h-5 w-5 object-contain" />
          <Puzzle v-else :size="20" />
        </ToolButton>
      </template>

      <!-- ... and the modules of the toolbar another -->
      <template v-if="compact">
        <ToolMenu v-if="favouriteModules.length" label="Modules">
          <template #button><LayoutGrid :size="20" /></template>
          <button v-for="m in favouriteModules" :key="m.name" type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
            @click="openModule(m.name)">
            <component v-if="m.icon" :is="m.icon" :size="16" />
            <img v-else-if="m.iconUrl" :src="m.iconUrl" alt="" class="h-4 w-4 object-contain" />
            <Puzzle v-else :size="16" />{{ m.label }}
          </button>
        </ToolMenu>
      </template>

    </nav>

    <!-- The tools that are not about the views: in a menu of their own, at the end of the bar -->
    <div class="flex shrink-0 items-center justify-end gap-1">
      <ToolMenu label="Application menu" align="right" :active="store.logWindowOpen || store.pythonConsoleOpen">
        <template #button><Menu :size="20" /></template>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          data-name="menu:fullscreen" @click="fullScreen"><Maximize :size="16" />Full screen</button>
        <button v-if="appConfig.features.extensionsManager" type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          data-name="menu:extensions" @click="store.extensionsManagerOpen = true"><Puzzle :size="16" />Extensions manager</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          data-name="menu:settings" @click="store.settingsDialogOpen = true"><SlidersHorizontal :size="16" />Application settings</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          :class="store.logWindowOpen ? 'text-highlight' : ''" data-name="menu:log"
          @click="store.logWindowOpen = !store.logWindowOpen"><ScrollText :size="16" />Application log</button>
        <button v-if="appConfig.features.pythonConsole" type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          :class="store.pythonConsoleOpen ? 'text-highlight' : ''" data-name="menu:python"
          @click="store.pythonConsoleOpen = !store.pythonConsoleOpen"><Terminal :size="16" />Python console</button>
        <!-- What this is: the build of the runtime and the commits it was made from (selectable, to be quoted) -->
        <div v-if="versionLines.length" class="mt-1 cursor-text select-text border-t border-input px-2 pb-0.5 pt-1.5 text-[11px] leading-snug text-muted-foreground"
          data-name="menu:version" @click.stop>
          <div v-for="line in versionLines" :key="line.text" :title="line.title">{{ line.text }}</div>
        </div>
      </ToolMenu>
      <!-- A phone held upright: the module panel opens from here -->
      <ToolButton v-if="store.panelButtons" label="Module panel" :active="store.rightPanelOpen" data-name="rightPanelButton"
        @click="store.rightPanelOpen = !store.rightPanelOpen"><PanelRight :size="20" /></ToolButton>
    </div>
  </header>
</template>

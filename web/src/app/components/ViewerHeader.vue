<script setup lang="ts">
import { computed, inject, ref } from "vue";
import {
  Crosshair,
  Box,
  Camera,
  CircleDot,
  Contrast,
  Hand,
  LayoutPanelLeft,
  Maximize,
  MoreHorizontal,
  Move3d,
  Puzzle,
  RotateCcw,
  Ruler,
  Spline,
  ScrollText,
  Terminal,
  Triangle,
  Brush,
  Square,
} from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { openModule as openModuleInPanel, store } from "../store";
import ToolButton from "./ToolButton.vue";
import ToolMenu from "./ToolMenu.vue";
import ClosedCurveIcon from "./icons/ClosedCurveIcon.vue";
import RoiBoxIcon from "./icons/RoiBoxIcon.vue";
import LayoutSelector from "./LayoutSelector.vue";

const bridge = inject<SlicerBridge>("bridge")!;
const ready = computed(() => store.status === "ready");
const layoutOpen = ref(false);

async function setMode(mode: string) {
  store.interactionMode = mode;
  await bridge.call("setInteractionMode", [mode]);
}

async function place(className: string) {
  store.interactionMode = "Place:" + className;
  lastMarkupTool.value = className;
  await bridge.call("placeMarkup", [className]);
}

async function toggleCrosshair() {
  await bridge.evalPython(`
import slicer
n = slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLCrosshairNode")
n.SetCrosshairMode(0 if n.GetCrosshairMode() else 2)
n.SetCrosshairBehavior(n.OffsetJumpSlice)
`);
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

const markupTools = [
  { cls: "vtkMRMLMarkupsFiducialNode", label: "Point list", icon: CircleDot },
  { cls: "vtkMRMLMarkupsLineNode", label: "Line", icon: Ruler },
  { cls: "vtkMRMLMarkupsAngleNode", label: "Angle", icon: Triangle },
  { cls: "vtkMRMLMarkupsCurveNode", label: "Open curve", icon: Spline },
  { cls: "vtkMRMLMarkupsClosedCurveNode", label: "Closed curve", icon: ClosedCurveIcon },
  { cls: "vtkMRMLMarkupsPlaneNode", label: "Plane", icon: Square },
  { cls: "vtkMRMLMarkupsROINode", label: "ROI", icon: RoiBoxIcon },
];

/** The markup kind the menu button shows: the one being placed, else the one placed last. */
const lastMarkupTool = ref("vtkMRMLMarkupsFiducialNode");
const currentMarkupTool = computed(() =>
  markupTools.find((t) => t.cls === (store.interactionMode.startsWith("Place:") ? store.interactionMode.slice("Place:".length) : lastMarkupTool.value))
  ?? markupTools[0]);


</script>

<template>
  <header class="relative z-20 flex h-[52px] shrink-0 items-center justify-between bg-background px-3">
    <div class="flex shrink-0 items-center gap-3 md:min-w-[240px]">
      <img :src="iconUrl" alt="" class="h-7 w-7 shrink-0" />
      <div class="leading-tight max-md:hidden">
        <div class="text-[15px] font-semibold tracking-wide text-foreground">3D Slicer</div>
        <div class="text-[11px] text-muted-foreground">Web</div>
      </div>
    </div>

    <nav class="flex min-w-0 items-center gap-1 max-md:mx-2 max-md:overflow-x-auto max-md:[scrollbar-width:none]" :class="{ 'pointer-events-none opacity-40': !ready }" aria-label="Toolbar">
      <div class="relative">
        <ToolButton label="Layout" @click="layoutOpen = !layoutOpen"><LayoutPanelLeft :size="20" /></ToolButton>
        <LayoutSelector v-if="layoutOpen" @close="layoutOpen = false" />
      </div>
      <ToolButton label="Reset views" @click="resetViews"><RotateCcw :size="20" /></ToolButton>
      <ToolButton label="Crosshair" class="max-sm:hidden" @click="toggleCrosshair"><Crosshair :size="20" /></ToolButton>
      <div class="mx-1 h-6 w-px bg-input max-sm:hidden" />
      <ToolButton label="Rotate / Pan / Zoom" :active="store.interactionMode === 'ViewTransform'" @click="setMode('ViewTransform')">
        <Hand :size="20" />
      </ToolButton>
      <ToolButton label="Window / Level" class="max-sm:hidden" :active="store.interactionMode === 'AdjustWindowLevel'" @click="setMode('AdjustWindowLevel')">
        <Contrast :size="20" />
      </ToolButton>
      <div class="mx-1 h-6 w-px bg-input max-sm:hidden" />
      <!-- The markup tools are a menu: seven buttons of their own leave a phone's toolbar with no
           room for anything else. The button shows the last kind placed, so that it can be started
           again with one tap. -->
      <ToolMenu label="Place markup" :active="store.interactionMode.startsWith('Place:')">
        <template #button><component :is="currentMarkupTool.icon" :size="20" /></template>
        <button v-for="t in markupTools" :key="t.cls" type="button" role="menuitem"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]"
          :class="store.interactionMode === 'Place:' + t.cls ? 'bg-accent text-highlight' : 'hover:bg-accent/60'"
          @click="place(t.cls)">
          <component :is="t.icon" :size="16" />{{ t.label }}
        </button>
      </ToolMenu>
      <div class="mx-1 h-6 w-px bg-input max-sm:hidden" />
      <ToolButton label="Segment Editor" @click="openModule('SegmentEditor')"><Brush :size="20" /></ToolButton>
      <ToolButton label="Volume Rendering" class="max-sm:hidden" @click="openModule('VolumeRendering')"><Box :size="20" /></ToolButton>
      <ToolButton label="Transforms" class="max-sm:hidden" @click="openModule('Transforms')"><Move3d :size="20" /></ToolButton>
      <ToolButton label="Scene Views" class="max-sm:hidden" @click="openModule('SceneViews')"><Camera :size="20" /></ToolButton>
      <!-- What does not fit on a narrow screen is in a menu instead -->
      <ToolMenu label="More" class="sm:hidden">
        <template #button><MoreHorizontal :size="20" /></template>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          @click="openModule('VolumeRendering')"><Box :size="16" />Volume Rendering</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          @click="openModule('Transforms')"><Move3d :size="16" />Transforms</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          @click="openModule('SceneViews')"><Camera :size="16" />Scene Views</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          :class="store.interactionMode === 'AdjustWindowLevel' ? 'text-highlight' : ''"
          @click="setMode('AdjustWindowLevel')"><Contrast :size="16" />Window / Level</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          @click="toggleCrosshair"><Crosshair :size="16" />Crosshair</button>
      </ToolMenu>
    </nav>

    <!-- The tools that are not about the views: in a menu of their own, at the end of the bar -->
    <div class="flex shrink-0 items-center justify-end gap-1">
      <ToolMenu label="Application menu" align="right" :active="store.logWindowOpen || store.pythonConsoleOpen">
        <template #button><MoreHorizontal :size="20" /></template>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          :class="store.logWindowOpen ? 'text-highlight' : ''" data-name="menu:log"
          @click="store.logWindowOpen = !store.logWindowOpen"><ScrollText :size="16" />Application log</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          :class="store.pythonConsoleOpen ? 'text-highlight' : ''" data-name="menu:python"
          @click="store.pythonConsoleOpen = !store.pythonConsoleOpen"><Terminal :size="16" />Python console</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          data-name="menu:extensions" @click="store.extensionsManagerOpen = true"><Puzzle :size="16" />Extensions manager</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          data-name="menu:fullscreen" @click="fullScreen"><Maximize :size="16" />Full screen</button>
      </ToolMenu>
    </div>
  </header>
</template>

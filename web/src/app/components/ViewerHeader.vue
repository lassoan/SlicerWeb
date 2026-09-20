<script setup lang="ts">
import { computed, inject, ref } from "vue";
import {
  Crosshair,
  Box,
  Camera,
  CircleDot,
  Contrast,
  Hand,
  LayoutGrid,
  Maximize,
  Move3d,
  Puzzle,
  RotateCcw,
  Ruler,
  Spline,
  Terminal,
  Triangle,
  Brush,
  Square,
} from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { store } from "../store";
import { captureView } from "../captureView";
import ToolButton from "./ToolButton.vue";
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

async function screenshot() {
  const layoutName = store.activeView || store.layout.maximized || "Red";
  const image = await captureView(bridge, layoutName);
  if (!image) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(image);
  link.download = `Slicer-${layoutName}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

function fullScreen() {
  document.documentElement.requestFullscreen?.();
}

function openModule(name: string) {
  store.activeModule = name;
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
        <ToolButton label="Layout" @click="layoutOpen = !layoutOpen"><LayoutGrid :size="20" /></ToolButton>
        <LayoutSelector v-if="layoutOpen" @close="layoutOpen = false" />
      </div>
      <ToolButton label="Reset views" @click="resetViews"><RotateCcw :size="20" /></ToolButton>
      <div class="mx-1 h-6 w-px bg-input" />
      <ToolButton label="Rotate / Pan / Zoom" :active="store.interactionMode === 'ViewTransform'" @click="setMode('ViewTransform')">
        <Hand :size="20" />
      </ToolButton>
      <ToolButton label="Window / Level" :active="store.interactionMode === 'AdjustWindowLevel'" @click="setMode('AdjustWindowLevel')">
        <Contrast :size="20" />
      </ToolButton>
      <ToolButton label="Crosshair" @click="toggleCrosshair"><Crosshair :size="20" /></ToolButton>
      <div class="mx-1 h-6 w-px bg-input" />
      <ToolButton v-for="t in markupTools" :key="t.cls" :label="t.label"
        :active="store.interactionMode === 'Place:' + t.cls" @click="place(t.cls)">
        <component :is="t.icon" :size="20" />
      </ToolButton>
      <div class="mx-1 h-6 w-px bg-input" />
      <ToolButton label="Segment Editor" @click="openModule('SegmentEditor')"><Brush :size="20" /></ToolButton>
      <ToolButton label="Volume Rendering" @click="openModule('VolumeRendering')"><Box :size="20" /></ToolButton>
      <ToolButton label="Transforms" @click="openModule('Transforms')"><Move3d :size="20" /></ToolButton>
      <ToolButton label="Screenshot" @click="screenshot"><Camera :size="20" /></ToolButton>
    </nav>

    <div class="flex shrink-0 items-center justify-end gap-1 md:min-w-[240px]">
      <ToolButton label="Python console" :active="store.pythonConsoleOpen" @click="store.pythonConsoleOpen = !store.pythonConsoleOpen">
        <Terminal :size="20" />
      </ToolButton>
      <ToolButton label="Extensions" @click="store.extensionsManagerOpen = true"><Puzzle :size="20" /></ToolButton>
      <ToolButton label="Full screen" @click="fullScreen"><Maximize :size="20" /></ToolButton>
    </div>
  </header>
</template>

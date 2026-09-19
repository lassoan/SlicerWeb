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
  SquareDashed,
  Terminal,
  Triangle,
  Waypoints,
  Brush,
  Square,
} from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { store } from "../store";
import ToolButton from "./ToolButton.vue";
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

function screenshot() {
  const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas.sw-view-canvas"));
  const target = canvases.find((c) => c.id === "slicer-view-" + store.activeView) ?? canvases[0];
  if (!target) return;
  target.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Slicer-${store.activeView || "view"}.png`;
    a.click();
  });
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
  { cls: "vtkMRMLMarkupsClosedCurveNode", label: "Closed curve", icon: Waypoints },
  { cls: "vtkMRMLMarkupsPlaneNode", label: "Plane", icon: Square },
  { cls: "vtkMRMLMarkupsROINode", label: "ROI", icon: SquareDashed },
];
</script>

<template>
  <header class="relative z-20 flex h-[52px] shrink-0 items-center justify-between bg-background px-3">
    <div class="flex shrink-0 items-center gap-3 md:min-w-[240px]">
      <svg viewBox="0 0 32 32" class="h-7 w-7" aria-hidden="true">
        <rect width="32" height="32" rx="6" fill="var(--color-bkg-med)" />
        <path d="M7 22 L16 6 L25 22 Z" fill="none" stroke="var(--color-primary-light)" stroke-width="2.5" />
        <circle cx="16" cy="17" r="3" fill="var(--color-primary)" />
      </svg>
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
      <div class="mx-1 h-6 w-px bg-input" />
      <ToolButton label="Rotate / Pan / Zoom" :active="store.interactionMode === 'ViewTransform'" @click="setMode('ViewTransform')">
        <Hand :size="20" />
      </ToolButton>
      <ToolButton label="Window / Level" :active="store.interactionMode === 'AdjustWindowLevel'" @click="setMode('AdjustWindowLevel')">
        <Contrast :size="20" />
      </ToolButton>
      <ToolButton label="Crosshair" @click="toggleCrosshair"><Crosshair :size="20" /></ToolButton>
      <ToolButton label="Reset views" @click="resetViews"><RotateCcw :size="20" /></ToolButton>
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

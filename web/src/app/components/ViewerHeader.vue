<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import {
  Crosshair,
  Box,
  Camera,
  CircleDot,
  Contrast,
  Hand,
  LayoutPanelLeft,
  Maximize,
  Move3d,
  Puzzle,
  ScanSearch,
  Ruler,
  Spline,
  ScrollText,
  Settings,
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
]);
const currentMouseMode = computed(() =>
  mouseModes.value.find((m) => m.mode === store.interactionMode)
  ?? (store.interactionMode.startsWith("Place:") ? { icon: currentMarkupTool.value.icon } : mouseModes.value[0]));

/** The modules the toolbar offers, for the single button they fold into. */
const favouriteModules = [
  { name: "SegmentEditor", label: "Segment Editor", icon: Brush },
  { name: "VolumeRendering", label: "Volume Rendering", icon: Box },
  { name: "Transforms", label: "Transforms", icon: Move3d },
  { name: "SceneViews", label: "Scene Views", icon: Camera },
];

/** The markup kind the menu button shows: the one being placed, else the one placed last. */
const lastMarkupTool = ref("vtkMRMLMarkupsFiducialNode");
const currentMarkupTool = computed(() =>
  markupTools.find((t) => t.cls === (store.interactionMode.startsWith("Place:") ? store.interactionMode.slice("Place:".length) : lastMarkupTool.value))
  ?? markupTools[0]);


</script>

<template>
  <header class="relative z-50 flex h-[52px] shrink-0 items-center justify-between bg-background px-3">
    <div class="flex shrink-0 items-center gap-3 md:min-w-[240px]">
      <img :src="iconUrl" alt="" class="h-7 w-7 shrink-0" />
      <div class="leading-tight max-md:hidden">
        <div class="text-[15px] font-semibold tracking-wide text-foreground">3D Slicer</div>
        <div class="text-[11px] text-muted-foreground">Web</div>
      </div>
    </div>

    <!-- [&>*]:shrink-0 so that the buttons keep their size and the toolbar overflows instead of
         squeezing them: overflowing is what tells it to fold them into menus (see measure()). -->
    <nav ref="nav" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0 max-md:mx-2"
      :class="{ 'pointer-events-none opacity-40': !ready }" aria-label="Toolbar">
      <div class="relative shrink-0">
        <ToolButton label="Layout" @click="layoutOpen = !layoutOpen"><LayoutPanelLeft :size="20" /></ToolButton>
        <LayoutSelector v-if="layoutOpen" @close="layoutOpen = false">
          <!-- Too narrow for them of their own: what is done to the views joins the layouts. -->
          <template v-if="compact" #views="{ close }">
            <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60" @click="resetViews(); close()">
              <ScanSearch :size="16" />Reset views
            </button>
            <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60" @click="toggleCrosshair(); close()">
              <Crosshair :size="16" />Crosshair
            </button>
          </template>
        </LayoutSelector>
      </div>

      <!-- With room for everything, every button is its own -->
      <template v-if="!compact">
        <ToolButton label="Reset views" @click="resetViews"><ScanSearch :size="20" /></ToolButton>
        <ToolButton label="Crosshair" @click="toggleCrosshair"><Crosshair :size="20" /></ToolButton>
        <div class="mx-1 h-6 w-px shrink-0 bg-input" />
        <ToolButton v-for="m in mouseModes" :key="m.mode" :label="m.label" :active="store.interactionMode === m.mode"
          @click="setMode(m.mode)">
          <component :is="m.icon" :size="20" />
        </ToolButton>
        <div class="mx-1 h-6 w-px shrink-0 bg-input" />
      </template>

      <!-- Too narrow for a button each: what a click in a view does becomes one menu -->
      <template v-if="compact">
        <!-- What a click in a view does. Placing is one of the three, and places the kind of
             markup chosen last; which kind that is belongs to the button beside this one. -->
        <ToolMenu label="Mouse mode" :active="store.interactionMode !== 'ViewTransform'">
          <template #button><component :is="currentMouseMode.icon" :size="20" /></template>
          <button v-for="m in mouseModes" :key="m.mode" type="button" role="menuitem"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]"
            :class="store.interactionMode === m.mode ? 'bg-accent text-highlight' : 'hover:bg-accent/60'"
            @click="setMode(m.mode)">
            <component :is="m.icon" :size="16" />{{ m.label }}
          </button>
          <button type="button" role="menuitem"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]"
            :class="store.interactionMode.startsWith('Place:') ? 'bg-accent text-highlight' : 'hover:bg-accent/60'"
            @click="place(lastMarkupTool)">
            <component :is="currentMarkupTool.icon" :size="16" />Place {{ currentMarkupTool.label.toLowerCase() }}
          </button>
        </ToolMenu>
      </template>

      <!-- What is placed, in both toolbars: seven buttons of their own would leave a narrow one no
           room for anything else. The button shows the kind placed last, to start it again in one tap. -->
      <ToolMenu label="Place markup" :active="store.interactionMode.startsWith('Place:')">
        <template #button><component :is="currentMarkupTool.icon" :size="20" /></template>
        <button v-for="t in markupTools" :key="t.cls" type="button" role="menuitem"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]"
          :class="store.interactionMode === 'Place:' + t.cls ? 'bg-accent text-highlight' : 'hover:bg-accent/60'"
          @click="place(t.cls)">
          <component :is="t.icon" :size="16" />{{ t.label }}
        </button>
      </ToolMenu>

      <template v-if="!compact">
        <div class="mx-1 h-6 w-px shrink-0 bg-input" />
        <ToolButton v-for="m in favouriteModules" :key="m.name" :label="m.label" @click="openModule(m.name)">
          <component :is="m.icon" :size="20" />
        </ToolButton>
      </template>

      <!-- ... and the modules of the toolbar another -->
      <template v-if="compact">
        <ToolMenu label="Modules">
          <template #button><Brush :size="20" /></template>
          <button v-for="m in favouriteModules" :key="m.name" type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
            @click="openModule(m.name)">
            <component :is="m.icon" :size="16" />{{ m.label }}
          </button>
        </ToolMenu>
      </template>

    </nav>

    <!-- The tools that are not about the views: in a menu of their own, at the end of the bar -->
    <div class="flex shrink-0 items-center justify-end gap-1">
      <ToolMenu label="Application menu" align="right" :active="store.logWindowOpen || store.pythonConsoleOpen">
        <template #button><Settings :size="20" /></template>
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

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Eye, EyeOff, Link2, Link2Off, Pin, ScanSearch, Maximize2, Minimize2 } from "@lucide/vue";
import PopupMenu from "./PopupMenu.vue";
import TouchMagnifier from "./TouchMagnifier.vue";
import TableView from "./TableView.vue";
import PlotView from "./PlotView.vue";
import type { SlicerBridge } from "@/core/bridge";
import { store, type LayoutTreeNode } from "../store";
import { SHARED_CANVAS_ID, rectOnSharedCanvas, sharedCanvas, sharedCanvasLayout, sharedRendering } from "./sharedCanvas";

const props = defineProps<{ view: LayoutTreeNode }>();
const bridge = inject<SlicerBridge>("bridge")!;

const container = ref<HTMLDivElement>();
const canvasId = computed(() => `slicer-view-${props.view.layoutName}`);
const isSlice = computed(() => props.view.kind === "slice");
const isThreeD = computed(() => props.view.kind === "threeD");
const isTable = computed(() => props.view.kind === "table");
const isPlot = computed(() => props.view.kind === "plot");
const isActive = computed(() => store.activeView === props.view.layoutName);

interface SliceState {
  orientation: string;
  offset: number;
  offsetRange: [number, number];
  offsetResolution: number;
  backgroundVolumeID: string | null;
  foregroundVolumeID: string | null;
  labelVolumeID: string | null;
  foregroundOpacity: number;
  labelOpacity: number;
  sliceVisible: boolean;
  fieldOfView: number[];
}
const slice = reactive<Partial<SliceState>>({});
/** Whether this view's controls move the other views of its kind (Slicer's link button). */
const linked = ref(false);
const volumes = ref<{ id: string; name: string }[]>([]);
let attached = false;
let resizeObserver: ResizeObserver | null = null;
let offs: (() => void)[] = [];

async function refreshSliceState() {
  if (!isSlice.value || !attached) return;
  const s = await bridge.call<SliceState | null>("getSliceViewState", [props.view.layoutName]);
  if (s) Object.assign(slice, s);
}

async function refreshLinked() {
  if (!attached) return;
  linked.value = await bridge.call<boolean>("getViewLinked", [props.view.layoutName]);
}

function deviceSize() {
  const rect = container.value!.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return [Math.max(1, Math.round(rect.width * dpr)), Math.max(1, Math.round(rect.height * dpr))];
}

/** Where this view is: on the shared canvas for the renderer, on the page for the pointer. */
function reportRect() {
  if (!sharedRendering.value || !container.value) return null;
  const onPage = container.value.getBoundingClientRect();
  store.viewRects[props.view.layoutName ?? ""] = { left: onPage.left, top: onPage.top, width: onPage.width, height: onPage.height };
  return rectOnSharedCanvas(container.value);
}

async function attach() {
  const [w, h] = deviceSize();
  if (sharedRendering.value) {
    // One canvas for every view: this one draws in its own rectangle of it. The grid makes the
    // canvas; until it has, there is nothing to draw into and the attempt is made again.
    const rect = reportRect();
    if (!rect || !sharedCanvas.value) {
      attached = false;
      return;
    }
    attached = await bridge.call<boolean>("attachView", [props.view.layoutName, "#" + SHARED_CANVAS_ID, rect[2], rect[3], rect]);
  } else {
    attached = await bridge.call<boolean>("attachView", [props.view.layoutName, "#" + canvasId.value, w, h]);
  }
  if (!attached) return;
  if (props.view.nodeID) await bridge.call("observeNode", [props.view.nodeID, true]);
  await refreshSliceState();
  await refreshLinked();
  await refreshVolumes();
}

/**
 * The view's WebGL context, lost and made good again.
 *
 * A phone's browser lets go of the GPU while the page is in the background, and the canvases come
 * back with their contexts dead: Chrome draws a sad face in the corner and nothing else. Everything
 * the view showed is still in the scene, so the view is simply made again - the old canvas goes,
 * a new one takes its place, and the render window is attached to it as at the start.
 *
 * The loss is answered in two ways, because browsers differ in what they say: by the canvas's own
 * events, and by asking the context whether it is lost when the page becomes visible again.
 */
const canvasKey = ref(0);
let remaking = false;

function onContextLost(event: Event) {
  event.preventDefault(); // otherwise the browser will not offer a restored context at all
}

async function remakeView() {
  if (remaking) return;
  remaking = true;
  try {
    if (attached) {
      attached = false;
      await bridge.call("detachView", [props.view.layoutName]).catch(() => {});
    }
    canvasKey.value++;
    await nextTick();
    await attach();
  } finally {
    remaking = false;
  }
}

function onVisible() {
  if (document.visibilityState !== "visible" || !attached) return;
  const gl = viewCanvas.value?.getContext("webgl2") ?? viewCanvas.value?.getContext("webgl");
  if (gl?.isContextLost()) void remakeView();
}

// Magnifier: a fingertip covers the point it touches, so while control points are placed or moved,
// the image under the finger is shown enlarged above it.
const magnifierPosition = ref<{ x: number; y: number } | null>(null);
const magnifierOffset = ref<{ x: number; y: number } | undefined>(undefined);

/** Where this view's space is on the shared canvas, in CSS pixels from its top left. */
function containerOnSharedCanvas() {
  const canvas = sharedCanvas.value;
  if (!canvas || !container.value) return undefined;
  const view = container.value.getBoundingClientRect();
  const whole = canvas.getBoundingClientRect();
  return { x: view.left - whole.left, y: view.top - whole.top };
}

// Where the views share a canvas, touches land on it, not on this view's space (which lets them
// through): the view follows the touches that start in its rectangle, as it follows those on a
// canvas of its own - for the magnifier. (The grid tells double taps apart, see ViewportGrid.)
function touchesThisView(touch: Touch) {
  const rect = container.value?.getBoundingClientRect();
  return !!rect && touch.clientX >= rect.left && touch.clientX < rect.right && touch.clientY >= rect.top && touch.clientY < rect.bottom;
}
function onSharedTouchStart(event: TouchEvent) {
  if (event.touches.length === 1 && touchesThisView(event.touches[0])) onTouchStart(event);
  else hideMagnifier();
}
function onSharedTouchMove(event: TouchEvent) {
  if (magnifierTouch !== null) onTouchMove(event);
}
function onSharedTouchEnd() {
  if (magnifierTouch !== null || magnifierPosition.value) hideMagnifier();
}
watch(sharedCanvas, (canvas, previous) => {
  previous?.removeEventListener("touchstart", onSharedTouchStart);
  previous?.removeEventListener("touchmove", onSharedTouchMove);
  previous?.removeEventListener("touchend", onSharedTouchEnd);
  previous?.removeEventListener("touchcancel", onSharedTouchEnd);
  canvas?.addEventListener("touchstart", onSharedTouchStart, { passive: true });
  canvas?.addEventListener("touchmove", onSharedTouchMove, { passive: true });
  canvas?.addEventListener("touchend", onSharedTouchEnd, { passive: true });
  canvas?.addEventListener("touchcancel", onSharedTouchEnd, { passive: true });
}, { immediate: true });
const viewCanvas = ref<HTMLCanvasElement | null>(null);
let magnifierTouch: number | null = null;
let magnifierChecked = false; // the view has been asked whether a control point is placed or moved
let magnifierEnabled = false; // ... and it is

function touchInContainer(touch: Touch) {
  const rect = container.value!.getBoundingClientRect();
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

async function updateMagnifier(touch: Touch) {
  if (!magnifierChecked) {
    magnifierChecked = true;
    // the press is processed by the view before this answer arrives (it starts moving a control point)
    magnifierEnabled = await bridge.call<boolean>("markupsInteractionActive").catch(() => false);
    // on the canvas the views share, the view is read from its rectangle of it
    viewCanvas.value = sharedRendering.value ? sharedCanvas.value : ((container.value?.querySelector("canvas") as HTMLCanvasElement) ?? null);
    magnifierOffset.value = sharedRendering.value ? containerOnSharedCanvas() : undefined;
  }
  if (!magnifierEnabled || !viewCanvas.value || magnifierTouch !== touch.identifier) return;
  magnifierPosition.value = touchInContainer(touch);
}

function onTouchStart(event: TouchEvent) {
  if (event.touches.length !== 1) {
    hideMagnifier();
    return;
  }
  magnifierTouch = event.touches[0].identifier;
  magnifierChecked = false;
  magnifierEnabled = false;
  lastTouch = event.touches[0];
  // the view processes the press in its next frame: ask after that, and refresh once more, because
  // the first image is read while the view is still being rendered
  for (const delay of [60, 160]) {
    window.setTimeout(() => {
      if (magnifierTouch !== null && lastTouch) updateMagnifier(lastTouch);
    }, delay);
  }
}

let lastTouch: Touch | null = null;
function onTouchMove(event: TouchEvent) {
  if (event.touches.length !== 1) {
    hideMagnifier();
    return;
  }
  lastTouch = event.touches[0];
  updateMagnifier(event.touches[0]);
}

function hideMagnifier() {
  magnifierTouch = null;
  magnifierChecked = true;
  magnifierEnabled = false;
  magnifierPosition.value = null;
  lastTouch = null;
}

// A drag is followed until the button is released, even outside the view: the pointer is captured,
// so the view goes on receiving the moves (a rotation that stops at the edge of the view) and is
// told about the release (without it the view believes the button is still down when the cursor
// comes back).
function onCanvasPointerDown(event: PointerEvent) {
  const canvas = event.target as HTMLCanvasElement;
  // Without preventScroll a browser may scroll the page to bring the canvas fully into view when
  // it takes focus - under a finger that has just started a drag, moving the view it is on
  canvas.focus({ preventScroll: true });
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // no capture for this pointer (it has already been released): the view still gets the events
  }
}

function onCanvasPointerUp(event: PointerEvent) {
  const canvas = event.target as HTMLCanvasElement;
  try {
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  } catch {
    // already released
  }
}

function renderView() {
  return bridge.call("renderView", [props.view.layoutName]);
}

// Double tap: touch screens have no double click, which maximizes a view in Slicer. Two taps at the
// same place in quick succession are sent to the view as a double click.
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DISTANCE = 30; // CSS pixels
let lastTap: { time: number; x: number; y: number } | null = null;

function onTouchEnd(event: TouchEvent) {
  hideMagnifier();
  if (event.changedTouches.length !== 1 || event.touches.length > 0) {
    lastTap = null;
    return;
  }
  const touch = event.changedTouches[0];
  const now = Date.now();
  const previous = lastTap;
  lastTap = { time: now, x: touch.clientX, y: touch.clientY };
  if (!previous || now - previous.time > DOUBLE_TAP_MS) return;
  if (Math.hypot(touch.clientX - previous.x, touch.clientY - previous.y) > DOUBLE_TAP_DISTANCE) return;
  lastTap = null;
  const canvas = container.value?.querySelector("canvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  event.preventDefault();
  bridge.call("viewDoubleClick", [props.view.layoutName, (touch.clientX - rect.left) * dpr, (touch.clientY - rect.top) * dpr]);
}

/** Create the view again after it was destroyed, while this viewport is still in the page. */
async function reattach() {
  if (attached || !container.value) return;
  for (let i = 0; i < 10 && !attached; i++) {
    await attach().catch(() => {});
    if (attached) return;
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
}

// A view too narrow for the whole of its bar - a phone held upright - does without the slice
// offset slider (the slices are browsed by dragging in the view); what is left is the
// orientation, the offset and the volume.
const narrow = ref(false);
function measureWidth() {
  if (container.value) narrow.value = container.value.getBoundingClientRect().width < 360;
}
let resizeFrame = 0;
function onResize() {
  measureWidth();
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(async () => {
    if (!attached || !container.value) return;
    if (sharedRendering.value) {
      const rect = reportRect();
      if (rect) await bridge.call("setViewRect", [props.view.layoutName, ...rect]);
      return;
    }
    const [w, h] = deviceSize();
    await bridge.call("resizeView", [props.view.layoutName, w, h]);
  });
}

async function refreshVolumes() {
  if (!isSlice.value) return;
  const nodes = await bridge.call<{ id: string; name: string }[]>("getNodes", ["vtkMRMLVolumeNode"]);
  volumes.value = nodes;
}

onMounted(async () => {
  measureWidth();
  resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(container.value!);
  document.addEventListener("visibilitychange", onVisible);
  container.value!.addEventListener("touchstart", onTouchStart, { passive: true });
  container.value!.addEventListener("touchmove", onTouchMove, { passive: true });
  container.value!.addEventListener("touchend", onTouchEnd);
  offs.push(
    bridge.events.on<{ id: string }>("node-modified", (p) => {
      if (p?.id === props.view.nodeID) refreshSliceState();
    }),
    bridge.events.on("scene-changed", () => {
      refreshVolumes();
      refreshSliceState();
    }),
    // The view is destroyed when its view node disappears (e.g. the scene is closed by a module or
    // a self test). The canvas stays in the page, so a new view is created for the new view node.
    bridge.events.on<{ layoutName: string }>("view-detached", (p) => {
      if (p?.layoutName !== props.view.layoutName || !container.value) return;
      attached = false;
      window.setTimeout(reattach, 0);
    }),
  );
  await reattach();   // the shared canvas may not be there yet on the first try
});

// The grid says the canvas moved or was resized: every view sends its rectangle again
watch(sharedCanvasLayout, () => onResize());

onBeforeUnmount(async () => {
  container.value?.removeEventListener("touchstart", onTouchStart);
  container.value?.removeEventListener("touchmove", onTouchMove);
  container.value?.removeEventListener("touchend", onTouchEnd);
  sharedCanvas.value?.removeEventListener("touchstart", onSharedTouchStart);
  sharedCanvas.value?.removeEventListener("touchmove", onSharedTouchMove);
  sharedCanvas.value?.removeEventListener("touchend", onSharedTouchEnd);
  sharedCanvas.value?.removeEventListener("touchcancel", onSharedTouchEnd);
  resizeObserver?.disconnect();
  document.removeEventListener("visibilitychange", onVisible);
  offs.forEach((off) => off());
  delete store.viewRects[props.view.layoutName ?? ""];
  if (attached) await bridge.call("detachView", [props.view.layoutName]);
});

async function setOffset(value: number) {
  slice.offset = value;
  await bridge.call("setSliceOffset", [props.view.layoutName, value]);
}

async function setOrientation(orientation: string) {
  await bridge.call("setSliceOrientation", [props.view.layoutName, orientation]);
  await refreshSliceState();
}

async function setLayer(layer: "background" | "foreground" | "label", id: string) {
  await bridge.call("setSliceLayerVolume", [props.view.layoutName, layer, id || null]);
  await refreshSliceState();
}

/** Show or hide this slice in the 3D views, as the image button of Slicer's slice controller does. */
async function setSliceVisible(visible: boolean) {
  slice.sliceVisible = visible;
  await bridge.call("setSliceVisible", [props.view.layoutName, visible]);
  await refreshSliceState();
}

/** Link or unlink all the views of this kind, as the link button of Slicer's controllers does. */
async function setLinked(value: boolean) {
  linked.value = value;
  await bridge.call("setViewLinked", [props.view.layoutName, value]);
  await refreshLinked();
}

/** Linking is set on the other views too, so read it again rather than show a stale chain. */
function openViewMenu(toggle: () => void) {
  refreshLinked();
  toggle();
}

async function resetView() {
  if (isSlice.value) {
    await bridge.evalPython(`slicer.app.layoutManager().sliceWidget(${JSON.stringify(props.view.layoutName)}).sliceLogic().FitSliceToAll()`);
  } else {
    await bridge.evalPython(`slicer.app.layoutManager().view(${JSON.stringify(props.view.layoutName)}).ResetCamera(-1)`);
  }
}

const maximized = computed(() => store.layout.maximized === props.view.layoutName);

/** Show this view alone; when it is already maximized, restore the layout. */
async function maximize() {
  await bridge.call("maximizeView", [props.view.layoutName]);
}

const orientations = ["Axial", "Sagittal", "Coronal", "Reformat"];
const offsetText = computed(() => (slice.offset !== undefined ? `${slice.offset.toFixed(2)} mm` : ""));
</script>

<template>
  <!-- Where the views share a canvas, the cell must not cover it: what is drawn is behind this -->
  <div class="flex min-h-0 min-w-0 flex-col rounded-[4px] border"
    :class="[isActive ? 'border-highlight' : 'border-input/60 hover:border-input',
             sharedRendering ? 'bg-transparent pointer-events-none' : 'bg-black']"
    @pointerdown="store.activeView = view.layoutName ?? ''">
    <!-- Slice / 3D view controller bar (Slicer's colored view controller, OHIF styling) -->
    <!-- the bar keeps its buttons where the cell lets the pointer through to the shared canvas -->
    <div v-if="!isTable && !isPlot" class="flex h-[26px] shrink-0 items-center gap-1.5 border-b border-input/40 bg-card px-1.5 text-[12px]"
      :class="{ 'pointer-events-auto': sharedRendering }">
      <PopupMenu v-if="isSlice || isThreeD">
        <template #trigger="{ open, toggle }">
          <button type="button" data-name="viewMenu" class="flex h-5 items-center gap-1.5 rounded px-1 hover:bg-accent/60"
            :class="open ? 'bg-accent/60' : ''" :title="`${view.label ?? view.layoutName} view menu`" @click="openViewMenu(toggle)">
            <span class="inline-block h-3 w-3 shrink-0 rounded-sm" :style="{ background: view.color ?? '#888' }" />
            <span class="shrink-0 font-medium text-foreground">{{ view.label ?? view.layoutName }}</span>
          </button>
        </template>
        <button v-if="isSlice" type="button" role="menuitem" data-name="menu:showIn3D"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          :class="slice.sliceVisible ? 'text-highlight' : ''" @click="setSliceVisible(!slice.sliceVisible)">
          <Eye v-if="slice.sliceVisible" :size="16" /><EyeOff v-else :size="16" />Show in 3D
        </button>
        <button type="button" role="menuitem" data-name="menu:linkViews"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          :class="linked ? 'text-highlight' : ''" @click="setLinked(!linked)">
          <Link2 v-if="linked" :size="16" /><Link2Off v-else :size="16" />Link views
        </button>
      </PopupMenu>
      <template v-else>
        <span class="inline-block h-3 w-3 shrink-0 rounded-sm" :style="{ background: view.color ?? '#888' }" />
        <span class="shrink-0 font-medium text-foreground">{{ view.label ?? view.layoutName }}</span>
      </template>
      <template v-if="isSlice">
        <select class="h-5 shrink-0 rounded bg-input/60 px-1 text-[11px] text-foreground outline-none"
          :value="slice.orientation" @change="setOrientation(($event.target as HTMLSelectElement).value)">
          <option v-for="o in orientations" :key="o" :value="o">{{ o }}</option>
        </select>
        <input v-if="!narrow" type="range" class="h-1 min-w-10 flex-1 cursor-pointer accent-highlight" data-name="sliceOffsetSlider"
          :min="slice.offsetRange?.[0] ?? 0" :max="slice.offsetRange?.[1] ?? 0"
          :step="slice.offsetResolution || 0.1" :value="slice.offset ?? 0"
          @input="setOffset(Number(($event.target as HTMLInputElement).value))" />
        <span class="shrink-0 text-right text-[11px] text-muted-foreground tabular-nums" :class="narrow ? 'flex-1' : 'w-[74px]'">{{ offsetText }}</span>
        <select class="h-5 max-w-[110px] shrink rounded bg-input/60 px-1 text-[11px] text-foreground outline-none"
          title="Background volume" :value="slice.backgroundVolumeID ?? ''"
          @change="setLayer('background', ($event.target as HTMLSelectElement).value)">
          <option value="">None</option>
          <option v-for="v in volumes" :key="v.id" :value="v.id">{{ v.name }}</option>
        </select>
      </template>
      <template v-else-if="isThreeD">
        <div class="flex-1" />
      </template>
      <div v-else class="flex-1" />
      <button type="button" class="text-muted-foreground hover:text-highlight" title="Reset view" @click="resetView"><ScanSearch :size="13" /></button>
      <button type="button" class="text-muted-foreground hover:text-highlight" :title="maximized ? 'Restore view layout' : 'Maximize view'"
        @click="maximize"><Minimize2 v-if="maximized" :size="13" /><Maximize2 v-else :size="13" /></button>
      <Pin v-if="false" :size="13" />
    </div>
    <!-- Where the views share a canvas, the pointer must reach it through this one -->
    <div ref="container" class="relative min-h-0 flex-1 overflow-hidden" :class="{ 'pointer-events-none': sharedRendering }">
      <canvas v-if="(isSlice || isThreeD) && !sharedRendering" :id="canvasId" :key="canvasKey" ref="viewCanvas" class="sw-view-canvas" tabindex="-1"
        @contextmenu.prevent @pointerdown="onCanvasPointerDown" @pointerup="onCanvasPointerUp"
        @pointercancel="onCanvasPointerUp" @webglcontextlost="onContextLost" @webglcontextrestored="remakeView" />
      <!-- In shared mode the view is drawn on the grid's canvas, behind this space -->
      <div v-else-if="isSlice || isThreeD" class="h-full w-full" />
      <TableView v-else-if="isTable" :layout-name="view.layoutName ?? ''" />
      <PlotView v-else-if="isPlot" :layout-name="view.layoutName ?? ''" />
      <div v-else class="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        {{ view.className }} is shown in the module panel
      </div>
      <TouchMagnifier :canvas="viewCanvas" :position="magnifierPosition" :render="renderView" :offset="magnifierOffset" />
    </div>
  </div>
</template>

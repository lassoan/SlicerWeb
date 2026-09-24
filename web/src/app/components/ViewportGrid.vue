<script setup lang="ts">
// The grid of views. Where the views share one WebGL context (Rendering settings), the grid holds
// the canvas they all draw into, behind them, and what a pointer does over a view - choosing it,
// keeping a drag, a double tap - is settled here, by which view's rectangle it is in.
import { inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SlicerBridge } from "@/core/bridge";
import { store, type LayoutTreeNode } from "../store";
import LayoutNode from "./LayoutNode.vue";
import { SHARED_CANVAS_ID, sharedCanvas, sharedCanvasLayout, sharedRendering } from "./sharedCanvas";

defineProps<{ node: LayoutTreeNode }>();
const bridge = inject<SlicerBridge>("bridge")!;
const grid = ref<HTMLDivElement>();
const canvasElement = ref<HTMLCanvasElement | null>(null);
let observer: ResizeObserver | null = null;

/** The canvas covers the whole grid; its drawing buffer is the grid in device pixels. */
async function sizeCanvas() {
  const canvas = canvasElement.value;
  if (!canvas || !grid.value) return;
  const rect = grid.value.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const [width, height] = [Math.max(1, Math.round(rect.width * dpr)), Math.max(1, Math.round(rect.height * dpr))];
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  await bridge.call("attachSharedCanvas", ["#" + SHARED_CANVAS_ID, width, height]);
  sharedCanvasLayout.value++;   // the views send their rectangles again
}

watch(sharedRendering, async (shared) => {
  if (shared) {
    await nextTick();
    sharedCanvas.value = canvasElement.value;
    await sizeCanvas();
  } else {
    sharedCanvas.value = null;
    await bridge.call("detachSharedCanvas").catch(() => {});
  }
});

// A new layout puts the views elsewhere, even those that keep their size
watch(() => store.layout, async () => {
  if (!sharedRendering.value) return;
  await nextTick();
  await sizeCanvas();
}, { deep: true });

onMounted(async () => {
  observer = new ResizeObserver(() => sizeCanvas());
  if (grid.value) observer.observe(grid.value);
  if (sharedRendering.value) {
    sharedCanvas.value = canvasElement.value;
    await sizeCanvas();
  } else {
    // The grid is made anew when the setting changes: a canvas of a previous life is let go here
    await bridge.call("detachSharedCanvas").catch(() => {});
  }
});
onBeforeUnmount(async () => {
  observer?.disconnect();
  sharedCanvas.value = null;
  if (sharedRendering.value) await bridge.call("detachSharedCanvas").catch(() => {});
});

// ---------------------------------------------------------------- input, in shared mode
/** The view a point of the page is over: the views report where they are (see sharedCanvas.ts). */
function viewAt(clientX: number, clientY: number) {
  for (const [layoutName, rect] of Object.entries(store.viewRects)) {
    if (clientX >= rect.left && clientX < rect.left + rect.width && clientY >= rect.top && clientY < rect.top + rect.height) {
      return layoutName;
    }
  }
  return "";
}

function onPointerDown(event: PointerEvent) {
  const layoutName = viewAt(event.clientX, event.clientY);
  if (layoutName) store.activeView = layoutName;
  // The keys go to the view the pointer is over, through the canvas (without scrolling to it)
  canvasElement.value?.focus({ preventScroll: true });
  // The drag is followed even when the pointer leaves the canvas
  try {
    canvasElement.value?.setPointerCapture(event.pointerId);
  } catch {
    // no capture for this pointer: the view still gets what happens over the canvas
  }
}
function onPointerUp(event: PointerEvent) {
  try {
    if (canvasElement.value?.hasPointerCapture?.(event.pointerId)) canvasElement.value.releasePointerCapture(event.pointerId);
  } catch {
    // already released
  }
}

// Double tap (a touch screen has no double click, which maximizes a view in Slicer)
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DISTANCE = 30;
let lastTap: { time: number; x: number; y: number } | null = null;
function onTouchEnd(event: TouchEvent) {
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
  const layoutName = viewAt(touch.clientX, touch.clientY);
  const rect = store.viewRects[layoutName];
  if (!layoutName || !rect) return;
  lastTap = null;
  const dpr = window.devicePixelRatio || 1;
  bridge.call("viewDoubleClick", [layoutName, (touch.clientX - rect.left) * dpr, (touch.clientY - rect.top) * dpr]);
}
</script>

<template>
  <div ref="grid" class="relative flex h-full w-full p-[2px]">
    <!-- Behind the views, covering all of them: what every view of the layout is drawn into -->
    <canvas v-if="sharedRendering" :id="SHARED_CANVAS_ID" ref="canvasElement" class="absolute inset-0 h-full w-full"
      tabindex="-1" @contextmenu.prevent @pointerdown="onPointerDown" @pointerup="onPointerUp"
      @pointercancel="onPointerUp" @touchend="onTouchEnd" />
    <!-- Over the canvas: the frames and bars of the views. Where they share the canvas the pointer
         goes through them to it, and only the bars take it back (Viewport.vue). -->
    <LayoutNode :node="node" class="relative h-full w-full" :class="{ 'pointer-events-none': sharedRendering }" />
  </div>
</template>

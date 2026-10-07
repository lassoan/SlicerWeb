<script setup lang="ts">
/**
 * Magnified view of the image under the finger, shown in a corner of the view (a fingertip covers
 * what it points at, and a magnifier that followed the finger would hide what is next to it). It
 * starts in the corner opposite to where the finger landed and stays on that side; it only moves
 * to the other corner of that side, vertically, when the finger comes close to it. It is used
 * while control points are placed or moved: a region of the rendered view is read back and drawn
 * enlarged, the point under the finger at its center.
 */
import { onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  /** Canvas of the view to magnify. */
  canvas: HTMLCanvasElement | null;
  /** Position in the viewport (CSS pixels, relative to the container), or null when hidden. */
  position: { x: number; y: number } | null;
  /** Size of the viewport (CSS pixels): the magnifier goes in the corner opposite to the position. */
  bounds?: { width: number; height: number };
  /** Size of the magnified region in device pixels of the view (about a fingertip wide). */
  region?: number;
  /** Renders the view before the pixels are read (the drawing buffer is not preserved). */
  render: () => Promise<unknown>;
  /**
   * Where the container is on the canvas (CSS pixels from its top left): a view drawn on the
   * canvas the views share is read from its rectangle of it. None for a canvas of the view's own.
   */
  offset?: { x: number; y: number };
}>();

const SIZE = 132; // diameter of the magnifier in CSS pixels
const MARGIN = 12; // distance between the magnifier and the edges of the view
const NEAR = 24; // how close the finger may come to the magnifier before it moves away
const view = ref<HTMLCanvasElement>();
const failed = ref(false);
let pending = false;

/** Rendered image of the view under the given point, drawn enlarged into the magnifier. */
async function update(x: number, y: number) {
  const canvas = props.canvas;
  const target = view.value;
  if (!canvas || !target || pending) return;
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
  if (!gl) {
    failed.value = true;
    return;
  }
  pending = true;
  try {
    // The drawing buffer is cleared when the page is composited, so the view is rendered here and
    // the pixels are read in the same task.
    await props.render();
    const region = props.region ?? 160;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / (rect.width * dpr);
    const centerX = Math.round((x + (props.offset?.x ?? 0)) * dpr * scaleX);
    const centerY = Math.round((y + (props.offset?.y ?? 0)) * dpr * scaleX);
    const left = Math.max(0, Math.min(canvas.width - region, centerX - region / 2));
    const bottom = Math.max(0, Math.min(canvas.height - region, canvas.height - centerY - region / 2));
    const pixels = new Uint8Array(region * region * 4);
    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(left, bottom, region, region, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
    // OpenGL reads bottom up
    const image = new ImageData(region, region);
    for (let row = 0; row < region; row++) {
      const source = (region - 1 - row) * region * 4;
      image.data.set(pixels.subarray(source, source + region * 4), row * region * 4);
    }
    const source = document.createElement("canvas");
    source.width = source.height = region;
    source.getContext("2d")!.putImageData(image, 0, 0);
    const context = target.getContext("2d")!;
    context.imageSmoothingEnabled = true;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0, region, region, 0, 0, target.width, target.height);
    failed.value = false;
  } catch (e) {
    console.warn("Magnifier: reading the view failed", e);
    failed.value = true;
  } finally {
    pending = false;
  }
}

/** The corner the magnifier is in: chosen when the finger lands, kept while it is down. */
const corner = ref<{ right: boolean; bottom: boolean } | null>(null);

/** The size of the view, or a guess that puts the given position in its middle. */
function bounds(position: { x: number; y: number }) {
  return props.bounds ?? { width: 2 * position.x, height: 2 * position.y + 1 };
}

/** Where the magnifier is with the finger at a position, in a corner. */
function rect(position: { x: number; y: number }, at: { right: boolean; bottom: boolean }) {
  const { width, height } = bounds(position);
  const far = (extent: number) => Math.max(0, extent - MARGIN - SIZE);
  return { left: at.right ? far(width) : MARGIN, top: at.bottom ? far(height) : MARGIN };
}

/** Whether the finger is within NEAR of the magnifier at a corner. */
function near(position: { x: number; y: number }, at: { right: boolean; bottom: boolean }) {
  const { left, top } = rect(position, at);
  const dx = Math.max(left - position.x, 0, position.x - (left + SIZE));
  const dy = Math.max(top - position.y, 0, position.y - (top + SIZE));
  return Math.hypot(dx, dy) < NEAR;
}

/** Where to put the magnifier for a finger position: see the component's description. */
function place(position: { x: number; y: number }, previous: { x: number; y: number } | null | undefined) {
  const { width, height } = bounds(position);
  if (!previous || !corner.value) {
    corner.value = { right: position.x < width / 2, bottom: position.y < height / 2 };
    return;
  }
  const other = { right: corner.value.right, bottom: !corner.value.bottom };
  if (near(position, corner.value) && !near(position, other)) corner.value = other;
}

watch(
  () => props.position,
  (position, previous) => {
    if (!position) {
      corner.value = null;
      return;
    }
    place(position, previous);
    update(position.x, position.y);
    // the first image can be read while the view is still rendering: refresh once
    window.setTimeout(() => props.position && update(props.position.x, props.position.y), 120);
  },
  { deep: true },
);
onBeforeUnmount(() => (pending = false));

const style = () => {
  const position = props.position!;
  const { left, top } = rect(position, corner.value ?? { right: false, bottom: false });
  return { left: `${left}px`, top: `${top}px`, width: `${SIZE}px`, height: `${SIZE}px` };
};
</script>

<template>
  <div v-if="position && !failed" class="pointer-events-none absolute z-30 overflow-hidden rounded-full border-2 border-primary shadow-lg"
    :style="style()" aria-hidden="true">
    <canvas ref="view" :width="SIZE * 2" :height="SIZE * 2" class="h-full w-full" />
  </div>
</template>

<script setup lang="ts">
/**
 * Magnified view of the image under the finger, shown above the touch position (a fingertip covers
 * what it points at). It is used while control points are placed or moved: a region of the rendered
 * view is read back and drawn enlarged.
 */
import { onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  /** Canvas of the view to magnify. */
  canvas: HTMLCanvasElement | null;
  /** Position in the viewport (CSS pixels, relative to the container), or null when hidden. */
  position: { x: number; y: number } | null;
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
const OFFSET = 28; // distance between the finger and the bottom of the magnifier
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

watch(
  () => props.position,
  (position) => {
    if (!position) return;
    update(position.x, position.y);
    // the first image can be read while the view is still rendering: refresh once
    window.setTimeout(() => props.position && update(props.position.x, props.position.y), 120);
  },
  { deep: true },
);
onBeforeUnmount(() => (pending = false));

const style = () => {
  const position = props.position!;
  return {
    left: `${position.x}px`,
    top: `${position.y - OFFSET - SIZE}px`,
    width: `${SIZE}px`,
    height: `${SIZE}px`,
  };
};
</script>

<template>
  <div v-if="position && !failed" class="pointer-events-none absolute z-30 -translate-x-1/2 overflow-hidden rounded-full border-2 border-primary shadow-lg"
    :style="style()" aria-hidden="true">
    <canvas ref="view" :width="SIZE * 2" :height="SIZE * 2" class="h-full w-full" />
    <!-- center of the magnified region, where the finger is -->
    <div class="absolute top-1/2 left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-highlight/80" />
  </div>
</template>

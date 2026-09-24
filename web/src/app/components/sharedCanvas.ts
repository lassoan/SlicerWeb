/* The canvas the views share when one WebGL context is used for all of them.
 *
 * A browser allows only so many contexts at a time - about eight on a phone - so a layout of nine
 * views cannot give each of them one of its own (see the Rendering settings). In shared mode the
 * viewport grid holds one canvas behind the views, each view draws in its own rectangle of it, and
 * the views tell the grid where they are.
 */
import { computed, ref } from "vue";
import { store } from "../store";

export const SHARED_CANVAS_ID = "slicer-views";

/** Whether the views share one canvas, as the application settings say. */
export const sharedRendering = computed(() => store.settings["Rendering/SharedWebGLContext"] === true);

/** The shared canvas element, while there is one, and its rectangle on the page. */
export const sharedCanvas = ref<HTMLCanvasElement | null>(null);
/** Bumped whenever the canvas moves or is resized: the views then send their rectangles again. */
export const sharedCanvasLayout = ref(0);

/** A view's rectangle on the shared canvas, in device pixels from its top left corner. */
export function rectOnSharedCanvas(element: HTMLElement): [number, number, number, number] | null {
  const canvas = sharedCanvas.value;
  if (!canvas) return null;
  const view = element.getBoundingClientRect();
  const whole = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return [
    Math.round((view.left - whole.left) * dpr),
    Math.round((view.top - whole.top) * dpr),
    Math.max(1, Math.round(view.width * dpr)),
    Math.max(1, Math.round(view.height * dpr)),
  ];
}

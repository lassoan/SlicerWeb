import type { SlicerBridge } from "@/core/bridge";

/**
 * Image of a view as it is on screen.
 *
 * The drawing buffer of a view is not kept after the page is composited (which is what a WebGL
 * canvas does unless it is asked to preserve it, at a cost to every frame), so canvas.toBlob() on it
 * gives an empty image. The view is rendered here and its pixels are read in the same task, then
 * turned the right way up (OpenGL reads bottom up).
 */
export async function captureView(bridge: SlicerBridge, layoutName: string): Promise<Blob | null> {
  const element = document.querySelector<HTMLElement>("#slicer-view-" + layoutName);
  const canvas = (element?.matches("canvas") ? element : element?.querySelector("canvas")) as HTMLCanvasElement | null;
  if (!canvas) return null;
  await bridge.call("renderView", [layoutName]).catch(() => {});
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
  if (!gl) return null;
  const { width, height } = canvas;
  const pixels = new Uint8Array(width * height * 4);
  const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);

  const image = new ImageData(width, height);
  for (let row = 0; row < height; row++) {
    const source = (height - 1 - row) * width * 4;
    image.data.set(pixels.subarray(source, source + width * 4), row * width * 4);
  }
  const target = document.createElement("canvas");
  target.width = width;
  target.height = height;
  target.getContext("2d")!.putImageData(image, 0, 0);
  return new Promise((resolve) => target.toBlob((blob) => resolve(blob), "image/png"));
}

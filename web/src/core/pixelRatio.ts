/* The pixel ratio the views are drawn at: the device's, or less (setting Rendering/MaximumPixelRatio).
 *
 * A phone's screen has three device pixels per CSS pixel or more, and drawing a 3D view at that
 * density costs nine times the pixels of a ratio of one - for a picture that looks hardly sharper
 * than at two. The ratio is read from window.devicePixelRatio by everything that sizes a view or
 * maps the pointer into one: the page, Emscripten and VTK (vtkWebAssemblyRenderWindowInteractor
 * scales pointer coordinates by it), and Slicer's Python code (markups glyph sizes). So the limit
 * is applied there, once, and they all agree on it.
 */

let maximum = 0;
let installed = false;
let deviceRatio = () => window.devicePixelRatio || 1;

/** The screen's own density, whatever the views are drawn at. */
export function devicePixelRatio() {
  return deviceRatio() || 1;
}

/** Draw the views at no more than *ratio* device pixels per CSS pixel (0: the device's ratio). */
export function limitPixelRatio(ratio: number) {
  maximum = ratio > 0 ? ratio : 0;
  if (installed) return;
  const descriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio")
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), "devicePixelRatio");
  if (!descriptor || descriptor.configurable === false) return;
  const getter = descriptor.get;
  deviceRatio = getter ? () => Number(getter.call(window)) : () => Number(descriptor.value);
  // (the device's ratio is read every time: it changes with the browser's zoom, or on another screen)
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    enumerable: true,
    get: () => {
      const ratio = deviceRatio() || 1;
      return maximum > 0 ? Math.min(ratio, maximum) : ratio;
    },
  });
  installed = true;
}

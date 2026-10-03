// Ambient shadows on a segmentation drawn at a lower resolution ("Resolution while rotating": half).
// The image of the lower resolution has its color, depth and normal in three color buffers. VTK's
// cache of draw buffers kept those of the shadows' framebuffer when the image's framebuffer was
// bound, and the call that switches on the second and third was skipped: only the color was
// written, the shadows had no depths and normals there, and they were gone while the camera moved.
// A scene file can be checked instead of the generated one: give its address with --scene (and
// with --gpu, on the graphics card rather than in software).
// Usage: node tests/shadows-reduced-resolution.mjs [url] [--scene <scene url>] [--gpu]
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const scene = option("--scene");
const base = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--scene") ?? "http://localhost:5173/";
const gpu = argv.includes("--gpu");
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: gpu ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 300)));
let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ": " + detail}`);
};
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);

await page.goto(base + (scene ? "?url=" + encodeURIComponent(scene) : "?sample="));
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 600000 });
if (scene) {
  await page.waitForFunction(async () => Number(await window.slicerWeb.bridge.evalPython("len(slicer.util.getNodesByClass('vtkMRMLSegmentationNode'))", "eval")) > 0, null, { timeout: 600000, polling: 1000 });
  await page.waitForFunction(() => !document.querySelector("[data-name=activity]"), null, { timeout: 600000 });
}
await page.waitForTimeout(2000);

// Segments that shade each other (two touching spheres on a slab), clipped
if (scene) await exec(`
lm = slicer.app.layoutManager()
lm.setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutOneUp3DView)
lm.threeDWidget(0).mrmlViewNode().SetShadowsVisibility(True)
`);
else await exec(`
import numpy as np, slicer, vtk
volume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "ref")
slicer.util.updateVolumeFromArray(volume, np.zeros((70, 80, 80), dtype=np.int16))
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "seg")
seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(volume)
k, j, i = np.mgrid[0:70, 0:80, 0:80]
slab = (k > 8) & (k < 18) & (i > 5) & (i < 75) & (j > 5) & (j < 75)
sphere1 = (i - 28) ** 2 + (j - 40) ** 2 + (k - 32) ** 2 < 15 ** 2
sphere2 = ((i - 52) ** 2 + (j - 40) ** 2 + (k - 32) ** 2 < 15 ** 2) & ~sphere1
for name, mask, color in (("slab", slab & ~sphere1 & ~sphere2, (0.9, 0.9, 0.9)), ("sphere1", sphere1, (0.9, 0.9, 0.9)), ("sphere2", sphere2, (0.9, 0.9, 0.9))):
    segmentId = seg.GetSegmentation().AddEmptySegment(name, name, color)
    slicer.util.updateSegmentBinaryLabelmapFromArray(mask.astype(np.uint8), seg, segmentId, volume)
seg.GetDisplayNode().SetPreferredDisplayRepresentationName3D("Binary labelmap")
# clipped, as the scene this was found with
clipNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLClipNode")
plane = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsPlaneNode")
plane.SetCenter(0, 0, 0)
plane.SetNormal(0, 1, 0)
plane.GetDisplayNode().SetVisibility(False)
clipNode.SetClippingNodeState(plane, slicer.vtkMRMLClipNode.ClipPositiveSpace)
seg.GetDisplayNode().SetAndObserveClipNodeID(clipNode.GetID())
seg.GetDisplayNode().SetClipping(True)
lm = slicer.app.layoutManager()
lm.setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutOneUp3DView)
view = lm.threeDWidget(0)
view.mrmlViewNode().SetShadowsVisibility(True)
camera = view._view.GetRenderWindow().GetRenderers().GetFirstRenderer().GetActiveCamera()
view.threeDView().resetFocalPoint()
view._view.ResetCamera(slicer.vtkMRMLCameraNode.Anterior)
camera.Elevation(35)
camera.Zoom(1.3)
`);
await page.waitForTimeout(2000);

/** The 3D view as drawn after a few frames at an image sample distance (shadows as they are). */
const image = (name, distance) => page.evaluate(async ([name, distance]) => {
  await window.slicerWeb.bridge.evalPython(`[a.GetMapper().SetImageSampleDistance(${distance}) for a in slicer.app.layoutManager().threeDWidget(0)._view.GetRenderWindow().GetRenderers().GetFirstRenderer().GetActors() if a.GetMapper() and a.GetMapper().IsA("vtkSegmentationLabelmapSurfaceMapper")]`, "exec");
  for (let i = 0; i < 3; i++) await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host.matches("canvas") ? host : host.querySelector("canvas");
  const gl = canvas.getContext("webgl2");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  (window.__images ??= {})[name] = pixels;
}, [name, distance]);
/** Mean darkening of the segments (not the blue background) by the shadows, between two images (0..255 per channel). */
const darkening = (offName, onName) => page.evaluate(([offName, onName]) => {
  const off = window.__images[offName], on = window.__images[onName];
  let sum = 0, n = 0;
  for (let p = 0; p < off.length; p += 4) {
    const background = off[p + 2] > off[p] + 25 && off[p + 2] > off[p + 1] + 10;
    if (background) continue;
    sum += (off[p] + off[p + 1] + off[p + 2] - on[p] - on[p + 1] - on[p + 2]) / 3;
    n++;
  }
  return { darkening: n ? sum / n : 0, pixels: n };
}, [offName, onName]);

// With shadows (on since the start, with fewer samples as while the camera moves: setting
// Rendering/FastShadowsWhileMoving), at full and at half resolution; then without, for comparison.
// Turning the shadows on makes their framebuffers anew, which would hide what earlier frames leave
// in the cache, so they are turned off only at the end.
await exec(`slicer.app.layoutManager().threeDWidget(0)._view.SetShadowsKernelSize(32)`);
await image("on1", 1);
await image("on2", 2);
await exec(`slicer.app.layoutManager().threeDWidget(0).mrmlViewNode().SetShadowsVisibility(False)`);
await image("off2", 2);
await image("off1", 1);
const full = await darkening("off1", "on1");
const half = await darkening("off2", "on2");
check("the segments are drawn", full.pixels > 5000 && half.pixels > 5000, `${full.pixels} and ${half.pixels} pixels`);
check("shadows darken the segments at full resolution", full.darkening > 3, full.darkening.toFixed(2));
check("and about as much at half resolution", half.darkening > 0.6 * full.darkening, `${half.darkening.toFixed(2)} vs ${full.darkening.toFixed(2)}`);

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failures ? 1 : 0);

// Application settings that make rendering faster:
// - Rendering/MaximumPixelRatio: on a screen of three device pixels per point, the views are drawn
//   with two (the default), and with three or one when chosen - the canvas, VTK's render window,
//   and the pointer (a click picks where it lands) all agree.
// - Segmentations/ImageSampleDistanceWhileMoving: while the camera of a 3D view is dragged, a
//   segmentation shown as binary labelmap is drawn with rays for every n-th pixel, and in full when
//   the drag ends (a surface is still drawn while moving; nothing is drawn at the lower resolution
//   when the setting is 1).
// Usage: node tests/rendering-performance-settings.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 3 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 300)));
page.on("console", (m) => {
  const t = m.text();
  if (/INVALID_OPERATION|INVALID_ENUM|INVALID_VALUE|INVALID_FRAMEBUFFER|Shader failed|vtkSegmentationLabelmapSurfaceMapper|ERROR/.test(t)) console.log("[console] " + t.slice(0, 300));
});
let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ": " + detail}`);
};
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);
const value = async (expr) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr)).replace(/^['"]|['"]$/g, "");
// Settings are changed in the Application settings dialog, as a user does
const fields = {
  "Rendering/MaximumPixelRatio": ["Rendering", "maximumPixelRatio"],
  "Segmentations/ImageSampleDistanceWhileMoving": ["Segmentations", "imageSampleDistanceWhileMoving"],
};
const openSettings = async () => {
  await page.getByLabel("Application menu").click();
  await page.locator("[role=menuitem]", { hasText: /application settings/i }).first().click();
  const dialog = page.locator("[data-name=settings-dialog]");
  await dialog.waitFor({ timeout: 10000 });
  return dialog;
};
const setSetting = async (key, v) => {
  const [section, field] = fields[key];
  const dialog = await openSettings();
  await dialog.locator("nav").getByText(section, { exact: true }).click();
  await dialog.locator(`[data-name=${field}]`).selectOption(String(v));
  await dialog.getByLabel("Close").click();
};

await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

// A segmentation shown as binary labelmap, in a 3D view on its own
await exec(`
import numpy as np, slicer
volume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "ref")
slicer.util.updateVolumeFromArray(volume, np.zeros((60, 60, 60), dtype=np.int16))
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "seg")
seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(volume)
k, j, i = np.mgrid[0:60, 0:60, 0:60]
sphere = ((i - 30) ** 2 + (j - 30) ** 2 + (k - 30) ** 2 < 20 ** 2).astype(np.uint8)
segmentId = seg.GetSegmentation().AddEmptySegment("sphere", "sphere", (0.9, 0.2, 0.1))
slicer.util.updateSegmentBinaryLabelmapFromArray(sphere, seg, segmentId, volume)
seg.GetDisplayNode().SetPreferredDisplayRepresentationName3D("Binary labelmap")
slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutOneUp3DView)
slicer.app.layoutManager().threeDWidget(0).threeDView().resetFocalPoint()
`);
await page.waitForTimeout(3000);

// ------------------------------------------------------------------ pixel ratio
const sizes = () => page.evaluate(async () => {
  const host = document.querySelector("#slicer-view-1");
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const rect = canvas.getBoundingClientRect();
  return { ratio: window.devicePixelRatio, canvas: [canvas.width, canvas.height], css: [rect.width, rect.height] };
});
const renderWindowSize = async () => JSON.parse(await value(`__import__("json").dumps(list(slicer.app.layoutManager().threeDWidget(0).threeDView().renderWindow().GetSize()))`));
const checkRatio = async (expected) => {
  const s = await sizes();
  check(`views drawn at ${expected} pixels per point`, Math.abs(s.ratio - expected) < 1e-6, `window.devicePixelRatio ${s.ratio}`);
  check(`  the canvas has ${expected} pixels per point`, Math.abs(s.canvas[0] - s.css[0] * expected) <= 2 && Math.abs(s.canvas[1] - s.css[1] * expected) <= 2,
    `canvas ${s.canvas} for ${s.css.map((v) => v.toFixed(1))} points`);
  const rw = await renderWindowSize();
  check("  and VTK's render window as many", Math.abs(rw[0] - s.canvas[0]) <= 2 && Math.abs(rw[1] - s.canvas[1]) <= 2, `render window ${rw}`);
  // A click in the middle of the view lands in the middle of the render window (pointer coordinates agree)
  const host = await page.locator("#slicer-view-1").boundingBox();
  await exec(`
import vtk
_iren = slicer.app.layoutManager().threeDWidget(0).threeDView().interactor()
_clicks = []
_clickTag = _iren.AddObserver(vtk.vtkCommand.LeftButtonPressEvent, lambda c, e: _clicks.append(c.GetEventPosition()), 1.0)
`);
  await page.mouse.click(host.x + host.width / 2, host.y + host.height / 2);
  await page.waitForTimeout(300);
  const click = JSON.parse(await value(`__import__("json").dumps(list(_clicks[-1]) if _clicks else None)`));
  await exec("_iren.RemoveObserver(_clickTag)");
  check("  a click in the middle of the view is in the middle of the render window", !!click && Math.abs(click[0] - rw[0] / 2) <= 3 * expected && Math.abs(click[1] - rw[1] / 2) <= 3 * expected,
    `event position ${click} in ${rw}`);
};
check("the default limit is 2", (await page.evaluate(() => window.slicerWeb.store.settings["Rendering/MaximumPixelRatio"])) === 2);
await checkRatio(2);
await setSetting("Rendering/MaximumPixelRatio", 0);
await page.waitForFunction(() => document.querySelector("#slicer-view-1"), null, { timeout: 60000 });
await page.waitForTimeout(3000);
await checkRatio(3);
await setSetting("Rendering/MaximumPixelRatio", 1);
await page.waitForTimeout(3000);
await checkRatio(1);
await setSetting("Rendering/MaximumPixelRatio", 2);
await page.waitForTimeout(3000);

// ------------------------------------------------------------------ resolution while moving
const mapperDistance = () => value(`str([a.GetMapper().GetImageSampleDistance() for a in slicer.app.layoutManager().threeDWidget(0).threeDView().renderWindow().GetRenderers().GetFirstRenderer().GetActors() if a.GetMapper() and a.GetMapper().IsA("vtkSegmentationLabelmapSurfaceMapper")])`);
const redPixels = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host.matches("canvas") ? host : host.querySelector("canvas");
  const gl = canvas.getContext("webgl2");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let red = 0;
  for (let p = 0; p < pixels.length; p += 4) if (pixels[p] > 2 * pixels[p + 1] && pixels[p] > 2 * pixels[p + 2] && pixels[p] > 60) red++;
  return red;
});
check("the default resolution while moving is half", (await page.evaluate(() => window.slicerWeb.store.settings["Segmentations/ImageSampleDistanceWhileMoving"])) === 2);
const still = await redPixels();
check("the segmentation is drawn", still > 1000, `${still} red pixels`);
check("in full while the camera is still", (await mapperDistance()) === "[1.0]", await mapperDistance());
const view = await page.locator("#slicer-view-1").boundingBox();
const [cx, cy] = [view.x + view.width / 2, view.y + view.height / 2];
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 15, cy, { steps: 3 });
await page.waitForTimeout(300);
check("at half the resolution while the camera is dragged", (await mapperDistance()) === "[2.0]", await mapperDistance());
const moving = await redPixels();
check("  and still drawn", moving > 0.5 * still, `${moving} red pixels (${still} still)`);
await page.mouse.up();
await page.waitForTimeout(500);
check("in full again when the drag ends", (await mapperDistance()) === "[1.0]", await mapperDistance());

await setSetting("Segmentations/ImageSampleDistanceWhileMoving", 1);
await page.waitForTimeout(300);
check("Python sees the setting", (await value(`str(slicer.app.userSettings().value("Segmentations/ImageSampleDistanceWhileMoving"))`)) === "1");
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 15, cy, { steps: 3 });
await page.waitForTimeout(300);
check("set to full, the drag keeps full resolution", (await mapperDistance()) === "[1.0]", await mapperDistance());
await page.mouse.up();
await setSetting("Segmentations/ImageSampleDistanceWhileMoving", 2);

// ------------------------------------------------------------------ fast shadows while moving
const kernelSize = () => value(`str(slicer.app.layoutManager().threeDWidget(0)._view.GetShadowsKernelSize())`);
await exec(`slicer.app.layoutManager().threeDWidget(0).mrmlViewNode().SetShadowsVisibility(True)`);
await page.waitForTimeout(1000);
const drag = async (during) => {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 15, cy, { steps: 3 });
  await page.waitForTimeout(300);
  const result = await during();
  await page.mouse.up();
  await page.waitForTimeout(500);
  return result;
};
check("fast shadows while moving are on by default", (await page.evaluate(() => window.slicerWeb.store.settings["Rendering/FastShadowsWhileMoving"])) === true);
check("shadows take 320 samples while still", (await kernelSize()) === "320", await kernelSize());
const kernelWhileDragging = await drag(kernelSize);
check("  32 while the camera is dragged", kernelWhileDragging === "32", kernelWhileDragging);
const shadowedWhileDragging = await drag(redPixels);
check("  and the segmentation is still drawn with shadows on", shadowedWhileDragging > 0.5 * still, `${shadowedWhileDragging} red pixels`);
check("  320 again when the drag ends", (await kernelSize()) === "320", await kernelSize());
{
  const dialog = await openSettings();
  await dialog.locator("nav").getByText("Rendering", { exact: true }).click();
  await dialog.locator("[data-name=fastShadowsWhileMoving] input[type=checkbox], label:has-text('Fast shadows while rotating') input[type=checkbox]").first().click();
  await dialog.getByLabel("Close").click();
  await page.waitForTimeout(300);
}
check("turned off, Python sees it", (await value(`str(slicer.app.userSettings().value("Rendering/FastShadowsWhileMoving"))`)) === "False");
const kernelWhileDraggingOff = await drag(kernelSize);
check("  and shadows keep 320 samples while dragged", kernelWhileDraggingOff === "320", kernelWhileDraggingOff);
{
  const dialog = await openSettings();
  await dialog.locator("nav").getByText("Rendering", { exact: true }).click();
  await dialog.locator("label:has-text('Fast shadows while rotating') input[type=checkbox]").first().click();
  await dialog.getByLabel("Close").click();
}
await exec(`slicer.app.layoutManager().threeDWidget(0).mrmlViewNode().SetShadowsVisibility(False)`);

// ------------------------------------------------------------------ the dialog offers both
const dialog = await openSettings();
await dialog.locator("nav").getByText("Rendering", { exact: true }).click();
check("the Rendering section offers the resolution of the views", await dialog.locator("[data-name=maximumPixelRatio]").isVisible());
check("  showing 2", (await dialog.locator("[data-name=maximumPixelRatio]").inputValue()) === "2");
check("  and says what the screen has", await dialog.getByText("This screen has 3 pixels per point").isVisible());
await dialog.locator("nav").getByText("Segmentations", { exact: true }).click();
check("the Segmentations section offers the resolution while rotating", (await dialog.locator("[data-name=imageSampleDistanceWhileMoving]").inputValue()) === "2");
await dialog.locator("[data-name=imageSampleDistanceWhileMoving]").selectOption("3");
await page.waitForTimeout(300);
check("  chosen there, Python sees it", (await value(`str(slicer.app.userSettings().value("Segmentations/ImageSampleDistanceWhileMoving"))`)) === "3");
await dialog.locator("[data-name=imageSampleDistanceWhileMoving]").selectOption("2");

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failures ? 1 : 0);

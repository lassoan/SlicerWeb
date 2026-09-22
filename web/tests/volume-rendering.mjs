// Volume rendering: the volume is drawn, not a solid block. Two things used to go wrong - the
// preset chosen for the volume was replaced by a ramp made from its window and level, and 16 bit
// volumes never reached the graphics card at all (see patches/VTK/0007-...) - and either way a
// volume came out as a featureless box. The cropping region is also only made when asked for.
// Usage: node tests/volume-rendering.mjs [url] [sample] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const sample = process.argv[3] && !process.argv[3].endsWith(".png") ? process.argv[3] : "MRHead";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 160)));
const glErrors = [];
const shaderErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/INVALID_OPERATION|INVALID_ENUM|INVALID_VALUE/.test(t)) glErrors.push(t.slice(0, 160));
  if (/Shader failed to compile|Shader compilation failed/.test(t)) shaderErrors.push(t.slice(0, 200));
});
await page.goto(base + "?sample=" + sample);
await page.waitForFunction(() => document.querySelector("#slicer-view-Red") && window.slicerWeb?.bridge, null, { timeout: 300000 });
await page.waitForTimeout(6000);

const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);
const text = async (expr) => String(await value(expr)).replace(/^['"]|['"]$/g, "");
const number = async (expr) => Number(await value(expr));
const call = (method, args) => page.evaluate(([m, a]) => window.slicerWeb.bridge.call(m, a), [method, args]);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

/** What the 3D view is showing: how many pixels are not the background, and how varied they are. */
const rendered = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  if (!gl) return { drawn: 0, shades: 0 };
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const shades = new Set();
  let drawn = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    // the background is a blue-grey gradient: anything warmer than it came from the volume
    if (r > b + 12) { drawn++; shades.add((r >> 4) * 256 + (g >> 4) * 16 + (b >> 4)); }
  }
  return { drawn, shades: shades.size, total: canvas.width * canvas.height };
});

const volumeId = await text(`__import__("slicer").util.getNodesByClass("vtkMRMLScalarVolumeNode")[0].GetID()`);

// what the module panel asks for before it can show anything
const info = await page.evaluate(([id]) => window.slicerWeb.bridge.call("volumeRenderingInfo", [id]), [volumeId])
  .catch((e) => ({ error: String(e.message).slice(0, 120) }));
check("the panel can read the state of the volume",
  !info.error && Array.isArray(info.presets) && info.presets.length > 0 && typeof info.quality === "number",
  info.error ?? `${info.presets.length} presets, quality ${info.quality}, aiming for ${info.expectedFPS} fps`);
check("no cropping region before anything is cropped",
  (await number(`__import__("slicer").mrmlScene.GetNumberOfNodesByClass("vtkMRMLMarkupsROINode")`)) === 0);

await call("setVolumeRendering", [volumeId, { visible: true }]);
await page.waitForTimeout(4000);

const preset = await text(`
(lambda d: d.GetVolumePropertyNode().GetName())(
    __import__("slicer").app.applicationLogic().GetModuleLogic("VolumeRendering").GetFirstVolumeRenderingDisplayNode(
        __import__("slicer").util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]))`);
check("the volume gets the preset that suits it", /^(MR-Default|CT-)/.test(preset), preset);

const view = await rendered();
check("the 3D view draws the volume", view.drawn > 2000, `${view.drawn} of ${view.total} pixels`);
check("and it has the shading of a volume, not one flat colour", view.shades > 20, `${view.shades} shades`);
check("no GL errors while it rendered", glErrors.length === 0, glErrors.slice(0, 2).join(" | "));

// while the camera is being moved the volume is rendered with fewer rays and bigger steps, and
// goes back to full detail when the movement stops. VTK cannot decide this for itself in a
// browser - it measures how long the last frame took, and WebGL returns before the frame is drawn
// - so the view does it on what the interactor says (slicerweb/volume_quality.py).
const mapperState = () => text(`
(lambda m: "%.0f|%.2f" % (m.GetImageSampleDistance(), m.GetSampleDistance()))(
    [v for v in __import__("slicer").app.layoutManager().views().values() if v.IsA("vtkSlicerWebThreeDView")][0]
    .GetRenderWindow().GetRenderers().GetItemAsObject(0).GetVolumes().GetItemAsObject(0).GetMapper())`);
const still = await mapperState();
const canvas = await page.locator("#slicer-view-1").boundingBox();
const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 5; i++) { await page.mouse.move(cx + i * 9, cy + i * 5); await page.waitForTimeout(60); }
const moving = await mapperState();
await page.mouse.up();
await page.waitForTimeout(600);
const afterwards = await mapperState();
const [stillRays, stillStep] = still.split("|").map(Number);
const [movingRays, movingStep] = moving.split("|").map(Number);
check("moving the camera renders the volume more coarsely",
  movingRays > stillRays && movingStep > stillStep,
  `still: every ${stillRays} px at ${stillStep} mm, moving: every ${movingRays} px at ${movingStep} mm`);
check("and it goes back to full detail when the camera stops", afterwards === still, `${afterwards} against ${still}`);

// Coarse frames have to follow the camera. They did not: VTK caches the draw buffer per binding
// point and refreshed it from GL_DRAW_BUFFER, which OpenGL ES does not have, so the reduced
// resolution buffer stayed switched off after its first use and every later frame repeated the
// first one (patches/VTK/0008-...). Only the volume's own pixels are compared, so a rotating
// bounding box cannot make this pass.
const setRays = (n) => text(`
(lambda m: (m.SetAutoAdjustSampleDistances(False), m.SetImageSampleDistance(${n}), "")[2])(
    [v for v in __import__("slicer").app.layoutManager().views().values() if v.IsA("vtkSlicerWebThreeDView")][0]
    .GetRenderWindow().GetRenderers().GetItemAsObject(0).GetVolumes().GetItemAsObject(0).GetMapper())`);
const volumePixels = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const px = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let hash = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > px[i + 2] + 12) hash = (hash * 31 + i + px[i]) % 1000000007;
  }
  return hash;
});
const turn = () => text(`
(lambda c: (c.Azimuth(60), "")[1])(
    [v for v in __import__("slicer").app.layoutManager().views().values() if v.IsA("vtkSlicerWebThreeDView")][0]
    .GetRenderWindow().GetRenderers().GetItemAsObject(0).GetActiveCamera())`);
await setRays(3);
const coarseHere = await volumePixels();
await turn();
const coarseTurned = await volumePixels();
await setRays(1);
const fineTurned = await volumePixels();
check("a coarsely rendered volume follows the camera", coarseHere !== coarseTurned && coarseTurned !== 0,
  `${coarseHere} then ${coarseTurned}`);
check("and full detail draws the same turned volume, not the old one", fineTurned !== coarseHere);

// the cropping region is made, and shown, when cropping is asked for
await call("setVolumeRendering", [volumeId, { croppingEnabled: true }]);
await page.waitForTimeout(1500);
check("cropping makes the region", (await number(`__import__("slicer").mrmlScene.GetNumberOfNodesByClass("vtkMRMLMarkupsROINode")`)) === 1);
check("and shows it", (await text(`
str(bool(__import__("slicer").util.getNodesByClass("vtkMRMLMarkupsROINode")[0].GetDisplayNode().GetVisibility()))`)) === "True");
await call("setVolumeRendering", [volumeId, { croppingEnabled: false }]);
await page.waitForTimeout(1000);
check("and hides it again when cropping is turned off", (await text(`
str(bool(__import__("slicer").util.getNodesByClass("vtkMRMLMarkupsROINode")[0].GetDisplayNode().GetVisibility()))`)) === "False");

// Clipping planes bring in a piece of shader that compared a float with an int literal, which
// GLSL ES refuses; the volume then vanished as soon as cropping was switched on. Cropping is
// turned on again here and the volume has to still be there (patches/VTK/0003-...).
await call("setVolumeRendering", [volumeId, { croppingEnabled: true }]);
await page.waitForTimeout(1500);
const cropped = await rendered();
check("the volume is still drawn once it is cropped", cropped.drawn > 1000, `${cropped.drawn} pixels`);
check("and its shaders compiled", shaderErrors.length === 0, shaderErrors.slice(0, 1).join(" "));

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

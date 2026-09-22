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
page.on("console", (m) => { if (/INVALID_OPERATION|INVALID_ENUM|INVALID_VALUE/.test(m.text())) glErrors.push(m.text().slice(0, 160)); });
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

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

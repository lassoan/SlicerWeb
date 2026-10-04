// Volume rendering with ambient shadows, rotated in a maximized 3D view. While the camera moves, a
// volume is rendered at a lower quality - into a framebuffer of the mapper's own, with as many color
// buffers as the render pass draws. The shadows' pass did not say how many, the framebuffer had none
// ("Failed to attach ImageSampleFBO"), and the mapper then used the framebuffer it had released: a
// "null function" error, and the view stayed black. Now the view follows the camera, without errors.
// Usage: node tests/volume-rendering-shadows.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(String(e)); console.log(`[pageerror] ${e}`); });
let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ": " + detail}`);
};

await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

// A volume (a bright ball in a dimmer box), volume rendered, with ambient shadows
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import numpy as np, slicer
k, j, i = np.mgrid[0:64, 0:64, 0:64]
a = np.where((i - 32) ** 2 + (j - 32) ** 2 + (k - 32) ** 2 < 18 ** 2, 1000, 0).astype(np.int16)
a[8:56, 8:20, 8:56] = 400
volume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "ball")
slicer.util.updateVolumeFromArray(volume, a)
logic = slicer.modules.volumerendering.logic()
vr = logic.CreateDefaultVolumeRenderingNodes(volume)
vr.GetVolumePropertyNode().Copy(logic.GetPresetByName("CT-Bone"))
vr.SetVisibility(True)
view = slicer.app.layoutManager().threeDWidget(0)
view.mrmlViewNode().SetShadowsVisibility(True)
view.threeDView().resetFocalPoint()
`, "exec"));
await page.waitForTimeout(3000);

const fboErrors = () => page.evaluate(() => window.slicerWeb.store.logs.filter((e) => /ImageSampleFBO|framebuffer is incomplete/.test(e.message)).map((e) => e.message.slice(0, 160)));
/** The 3D view as drawn: a checksum, and how much of it is not black. */
const image = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host.matches("canvas") ? host : host.querySelector("canvas");
  const gl = canvas.getContext("webgl2");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let sum = 0, lit = 0;
  for (let p = 0; p < pixels.length; p += 4) {
    sum = (sum * 31 + pixels[p] + 7 * pixels[p + 1] + 13 * pixels[p + 2]) % 1000000007;
    if (pixels[p] + pixels[p + 1] + pixels[p + 2] > 30) lit++;
  }
  return { sum, lit: lit / (pixels.length / 4) };
});
const drag = async () => {
  const box = await page.locator("#slicer-view-1").boundingBox();
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y, { steps: 5 });
  await page.waitForTimeout(400);
  const during = await image();
  await page.mouse.up();
  await page.waitForTimeout(800);
  return during;
};

// Maximized, as the button of the view does (the view is made again)
await page.evaluate(() => window.slicerWeb.bridge.call("maximizeView", ["1"]));
await page.waitForTimeout(3000);
let previous = await image();
check("maximized, the view is drawn", previous.lit > 0.3, `${Math.round(100 * previous.lit)}% lit`);
for (let n = 0; n < 3; n++) {
  const during = await drag();
  const after = await image();
  check(`rotation ${n + 1}: drawn while the camera moves`, during.lit > 0.3, `${Math.round(100 * during.lit)}% lit`);
  check(`  and follows the camera`, after.sum !== previous.sum && after.lit > 0.3, `${Math.round(100 * after.lit)}% lit`);
  previous = after;
}
const errors = await fboErrors();
check("no framebuffer errors", errors.length === 0, errors.slice(0, 2).join(" | "));
check("no errors in the page", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failures ? 1 : 0);

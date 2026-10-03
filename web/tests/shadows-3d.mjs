// Ambient shadows in 3D views: the "Shadows" settings in the menu of the 3D view (desktop Slicer's 3D view controller has
// them) turn them on and set how they look; the view shows them with screen-space ambient occlusion, on surface meshes and on the surfaces
// that the GPU computes from labelmaps alike.
// Usage: node tests/shadows-3d.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const glErrors = [];
page.on("pageerror", (e) => console.log("[pageerror] " + e));
page.on("console", (m) => {
  const t = m.text();
  if (/error|Error|ERROR/.test(t) && !/GL Driver/.test(t)) { glErrors.push(t.slice(0, 300)); console.log("[console] " + t.slice(0, 300)); }
});
await page.goto(base);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

// Two touching balls and a plate: crevices for ambient occlusion
await run(`
import numpy as np, slicer
volume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "ref")
slicer.util.updateVolumeFromArray(volume, np.zeros((60, 70, 80), dtype=np.int16))
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "seg")
seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(volume)
k, j, i = np.mgrid[0:60, 0:70, 0:80]
shapes = (("ball1", ((i - 30) ** 2 + (j - 35) ** 2 + (k - 30) ** 2 < 14 ** 2), (0.9, 0.3, 0.2)),
          ("ball2", ((i - 52) ** 2 + (j - 35) ** 2 + (k - 30) ** 2 < 11 ** 2), (0.3, 0.8, 0.3)),
          ("plate", (i > 8) & (i < 72) & (j > 8) & (j < 62) & (k > 8) & (k < 14), (0.8, 0.8, 0.3)))
taken = np.zeros_like(i, dtype=bool)
for name, mask, color in shapes:
    segmentId = seg.GetSegmentation().AddEmptySegment(name, name, color)
    slicer.util.updateSegmentBinaryLabelmapFromArray((mask & ~taken).astype(np.uint8), seg, segmentId, volume)
    taken |= mask
seg.CreateClosedSurfaceRepresentation()
slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutOneUp3DView)
view = slicer.app.layoutManager().threeDWidget(0).threeDView()
view.resetFocalPoint(); view.resetCamera()
c = view.renderWindow().GetRenderers().GetFirstRenderer().GetActiveCamera(); c.Elevation(-50); c.OrthogonalizeViewUp()
`);
await page.waitForTimeout(2000);

/** Mean brightness of the pixels that differ from the background, and their number. */
const measure = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const gl = canvas?.getContext("webgl2");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let n = 0, sum = 0;
  for (let p = 0; p < pixels.length; p += 4) {
    const [r, g, b] = [pixels[p], pixels[p + 1], pixels[p + 2]];
    if (b > r + 15 && b > g + 15) continue;   // the blue background
    n++; sum += r + g + b;
  }
  return { pixels: n, brightness: n ? sum / n : 0 };
});
const viewNode = `slicer.app.layoutManager().threeDWidget(0).mrmlViewNode()`;
const menuButton = page.locator("#slicer-view-1").locator("xpath=ancestor::div[contains(@class,'flex-col')][1]").locator("[data-name=viewMenu]");
const openMenu = async () => { await menuButton.click(); await page.waitForTimeout(400); };
await openMenu();
check("the 3D view's menu has the shadows settings", (await page.locator("[data-name=shadowsSettings]").count()) === 1);
await page.keyboard.press("Escape");
const shadowsCheckBox = page.locator("[data-name=shadowsVisibility]");

const darkening = async (representation) => {
  await run(`slicer.util.getNode("seg").GetDisplayNode().SetPreferredDisplayRepresentationName3D("${representation}")`);
  await page.waitForTimeout(1500);
  const off = await measure();
  await openMenu();
  await shadowsCheckBox.check();
  await page.waitForTimeout(1500);
  const on = await measure();
  await shadowsCheckBox.uncheck();
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
  return { off, on, darkening: 1 - on.brightness / off.brightness };
};
const closed = await darkening("Closed surface");
const labelmap = await darkening("Binary labelmap");
console.log("     closed surface:", JSON.stringify(closed));
console.log("     binary labelmap:", JSON.stringify(labelmap));
check("shadows darken closed surfaces", closed.darkening > 0.01, closed.darkening.toFixed(3));
check("and the surfaces computed on the GPU about as much", labelmap.darkening > 0.5 * closed.darkening && labelmap.darkening < 2 * closed.darkening,
  `${labelmap.darkening.toFixed(3)} vs ${closed.darkening.toFixed(3)}`);
check("without moving them", Math.abs(labelmap.on.pixels - labelmap.off.pixels) < 0.05 * labelmap.off.pixels, `${labelmap.on.pixels} vs ${labelmap.off.pixels} pixels`);

// The settings of the menu are the view node's
await openMenu();
await page.locator("[data-name=shadowsExpand]").click();
await page.waitForTimeout(300);
await shadowsCheckBox.check();
await page.waitForTimeout(800);
check("the check box turns shadows on in the view node", (await py(`${viewNode}.GetShadowsVisibility()`)) === "True");
const setSlider = async (name, value) => {
  await page.locator(`[data-name=${name}] input[type=number]`).fill(String(value));
  await page.locator(`[data-name=${name}] input[type=number]`).dispatchEvent("change");
  await page.waitForTimeout(600);
};
const before = await measure();
await setSlider("ambientShadowsIntensityScale", 2.5);
check("Intensity scale sets the view node", Number(await py(`${viewNode}.GetAmbientShadowsIntensityScale()`)) === 2.5);
const stronger = await measure();
check("and stronger shadows are darker", stronger.brightness < before.brightness, `${stronger.brightness.toFixed(1)} vs ${before.brightness.toFixed(1)}`);
await setSlider("ambientShadowsSizeScale", 0.5);
check("Size scale sets the view node", Number(await py(`${viewNode}.GetAmbientShadowsSizeScale()`)) === 0.5);
await setSlider("ambientShadowsVolumeOpacityThreshold", 30);
check("Volume opacity threshold is set in percent", Math.abs(Number(await py(`${viewNode}.GetAmbientShadowsVolumeOpacityThreshold()`)) - 0.3) < 1e-6);
await setSlider("ambientShadowsIntensityShift", 0.2);
check("Intensity shift sets the view node", Math.abs(Number(await py(`${viewNode}.GetAmbientShadowsIntensityShift()`)) - 0.2) < 1e-6);
await page.locator("[data-name=resetShadows]").click();
await page.waitForTimeout(800);
const reset = await py(`(lambda n: f"{n.GetAmbientShadowsSizeScale()} {n.GetAmbientShadowsVolumeOpacityThreshold()} {n.GetAmbientShadowsIntensityScale()} {n.GetAmbientShadowsIntensityShift()}")(${viewNode})`);
check("Reset sets the defaults", reset === "0.0 0.0 1.0 0.0", reset);

// Translucent segments with shadows on
await run(`slicer.util.getNode("seg").GetDisplayNode().SetOpacity3D(0.5)`);
await page.waitForTimeout(1500);
const translucent = await measure();
check("translucent segments are shown with shadows on", translucent.pixels > 0.5 * labelmap.off.pixels, `${translucent.pixels} pixels`);
if (shot) await page.locator("#slicer-view-1").screenshot({ path: shot });
check("no GL or shader errors", glErrors.length === 0, glErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

// Volume rendering with ambient shadows while the camera moves. A volume being rotated is rendered
// at a lower resolution (an image sample distance above one), into a framebuffer of the mapper's
// own: it had no depth buffer, and the positions and normals the shadows are computed from were
// clamped to 8 bits, so while rotating the shadows were gone and the volume was drawn brighter.
// And the mapper copies the depth of the scene with a blit, into a depth buffer of another format
// than that of the shadows' pass, which WebGL refuses: "glBlitFramebuffer: Depth/stencil buffer
// format combination not allowed for blit", every frame (VTK patches 0016, 0017).
// Usage: node tests/volume-rendering-shadows-moving.mjs [url] [--gpu]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const gpu = process.argv.includes("--gpu");
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: gpu ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
const glErrors = [];
page.on("console", (m) => { if (/GL_INVALID|glBlitFramebuffer/.test(m.text())) glErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ": " + detail}`);
};

await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

// A lattice of bars: every corner where they meet is darkened by the ambient shadows
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import numpy as np, slicer
k, j, i = np.mgrid[0:96, 0:96, 0:96]
bar = lambda c: (c % 16) < 5
a = np.where((bar(i) & bar(j)) | (bar(j) & bar(k)) | (bar(i) & bar(k)), 1000, 0).astype(np.int16)
a[:, :, :4] = 0
volume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "ball")
slicer.util.updateVolumeFromArray(volume, a)
logic = slicer.modules.volumerendering.logic()
vr = logic.CreateDefaultVolumeRenderingNodes(volume)
vr.GetVolumePropertyNode().Copy(logic.GetPresetByName("CT-Bone"))
vr.SetVisibility(True)
widget = slicer.app.layoutManager().threeDWidget(0)
widget.threeDView().resetFocalPoint()
camera = widget.threeDView().cameraNode().GetCamera() if hasattr(widget.threeDView(), "cameraNode") else None

def threeD():
    return [v for v in slicer.app.layoutManager().views().values() if v.IsA("vtkSlicerWebThreeDView")][0]

def mapper():
    renderers = threeD().GetRenderWindow().GetRenderers()
    for r in range(renderers.GetNumberOfItems()):
        volumes = renderers.GetItemAsObject(r).GetVolumes()
        if volumes.GetNumberOfItems():
            return volumes.GetItemAsObject(0).GetMapper()

def setQuality(imageSampleDistance, sampleDistance):
    """As the view does while the camera moves (slicerweb/volume_quality.py)"""
    m = mapper()
    m.SetAutoAdjustSampleDistances(False)
    m.SetLockSampleDistanceToInputSpacing(False)
    m.SetImageSampleDistance(imageSampleDistance)
    m.SetSampleDistance(sampleDistance)

def shadows(on):
    widget.mrmlViewNode().SetShadowsVisibility(on)
    widget.mrmlViewNode().SetAmbientShadowsSizeScale(3.0)
`, "exec"));
await page.waitForTimeout(3000);

/** How bright the volume is drawn: the mean of the pixels that are not background. */
const brightness = () => page.evaluate(async () => {
  for (let i = 0; i < 2; i++) await window.slicerWeb.bridge.call("renderView", ["1"]);   // (resources made on the first)
  const host = document.querySelector("#slicer-view-1");
  const canvas = host.matches("canvas") ? host : host.querySelector("canvas");
  const gl = canvas.getContext("webgl2");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let sum = 0, n = 0;
  for (let p = 0; p < pixels.length; p += 4) {
    const [r, g, b] = [pixels[p], pixels[p + 1], pixels[p + 2]];
    if (b > r + 25) continue;   // the blue background
    sum += (r + g + b) / 3; n++;
  }
  return n ? sum / n : -1;
});
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);

const results = {};
for (const on of [false, true]) {
  await run(`shadows(${on ? "True" : "False"})`);
  for (const [isd, sd] of [[1, 0.5], [3, 2.0]]) {
    await run(`setQuality(${isd}, ${sd})`);
    await page.waitForTimeout(500);
    results[`${on ? "shadows" : "none"}-${isd}`] = await brightness();
  }
}
const fmt = (v) => v.toFixed(1);
const shadowsStill = results["shadows-1"], shadowsMoving = results["shadows-3"];
const plainStill = results["none-1"], plainMoving = results["none-3"];
console.log(`brightness: without shadows ${fmt(plainStill)} still, ${fmt(plainMoving)} moving; with shadows ${fmt(shadowsStill)} still, ${fmt(shadowsMoving)} moving`);
check("the shadows darken the volume", plainStill - shadowsStill > 5, `${fmt(plainStill)} -> ${fmt(shadowsStill)}`);
// (the longer steps taken while moving change how the volume looks by themselves: what is compared is
// how much the shadows darken it - nothing at all, before)
check("and still do at the lower resolution used while moving (it is not drawn brighter)",
  plainMoving - shadowsMoving > 0.5 * (plainStill - shadowsStill),
  `darkened by ${fmt(plainStill - shadowsStill)} still, by ${fmt(plainMoving - shadowsMoving)} moving`);
check("no WebGL errors (the depth of the scene is copied for the volume)", glErrors.length === 0, glErrors.slice(0, 2).join(" | "));

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "ALL PASSED");
process.exit(failures ? 1 : 0);

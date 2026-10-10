// The panel's Rendering section: the headset's resolution, changed in the session (a new layer for
// the 3D view, at that scale), and the volume rendering's frame rate target - a slider dragged with
// the ray - which the volume rendering is kept at: coarser when the frames come slower than the
// target, finer when they come well faster, and as Slicer had it again when the session ends.
//
// Usage: node tests/xr/rendering-xr.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=MRHead&layout=OneUp3D";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => {
  if (m.type() === "error" || /resolution/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const python = (expression) => page.evaluate((e) => window.slicerWeb.bridge.evalPython(e, "eval"), expression);
let time = 0;
const frames = (count) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start: (time += count * 14) });
/** Aims the ray at a point of a button of the panel (fraction across it, 0.5 down it). */
const aim = (id, across = 0.5) => page.evaluate(({ id, across }) => {
  const { M } = window.slicerXR.internals;
  const panel = window.slicerXR.session.panel;
  const button = panel.buttons.find((b) => b.id === id);
  const x = ((button.x + button.width * across) / panel.layoutWidth - 0.5) * panel.widthM;
  const y = (0.5 - (button.y + button.height * 0.75) / panel.height) * panel.heightM;
  const target = M.point(panel.roomFromPanel, [x, y, 0]);
  const origin = [0.1, 1.0, -0.25];
  const z = [0, 1, 2].map((i) => origin[i] - target[i]);
  const zz = z.map((v) => v / Math.hypot(...z));
  let xx = [zz[2], 0, -zz[0]];
  xx = xx.map((v) => v / Math.hypot(...xx));
  const yy = [zz[1] * xx[2] - zz[2] * xx[1], zz[2] * xx[0] - zz[0] * xx[2], zz[0] * xx[1] - zz[1] * xx[0]];
  window.__xrMock.rayMatrix = new Float32Array([...xx, 0, ...yy, 0, ...zz, 0, ...origin, 1]);
}, { id, across });
const trigger = (type) => page.evaluate((type) => window.__xrMock.session.dispatch(type, { inputSource: window.__xrMock.controller }), type);
const mapper = () => python("(lambda m: [m.GetImageSampleDistance(), round(m.GetSampleDistance(), 4), m.GetAutoAdjustSampleDistances()])(slicerXR._volumeMappers()[0]) if slicerXR._volumeMappers() else None")
  .then((s) => JSON.parse(s.replace(/True/g, "true").replace(/False/g, "false").replace("None", "null")));
/** Frames for a while at this rate (frames per real second). */
const paced = async (fps, seconds) => {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await frames(1);
    await page.waitForTimeout(1000 / fps);
  }
};

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
check(await page.locator("#slicer-xr select").count() === 0, "the page has no resolution selector any more");
for (let i = 0; i < 300 && Number(await python("len(slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode'))")) === 0; i++) await page.waitForTimeout(1000);
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(3);
const original = await mapper();
check(original !== null, `MRHead is volume rendered in the session (rays 1 per ${original?.[0]} px, step ${original?.[1]} mm)`);
check(await page.evaluate(() => window.__xrMock.layerOptions.framebufferScaleFactor) === 0.7, "the headset starts at Balanced (70%)");

// The View category has the resolution and the frame rate target
await page.evaluate(() => window.slicerXR.session.panel.setCategory("view"));
await frames(1);

// Resolution: Quality, in the session
await aim("resolution:1");
await frames(1);
await trigger("selectstart");
await trigger("selectend");
await page.evaluate(() => (window.__xrMock.rayMatrix = null));
await frames(3);
const scale = await page.evaluate(() => window.__xrMock.layerOptions.framebufferScaleFactor);
const used = await page.evaluate(() => window.__xrMock.session.renderState.baseLayer === window.__xrMock.layer || window.__xrMock.session.renderState.layers?.[0] === window.__xrMock.layer);
const drawn = await page.evaluate(() => {
  const { W, H, gl, layer } = window.__xrMock;
  const pixels = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.framebuffer);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) n++;
  return n;
});
check(scale === 1 && used, "Quality 100% on the panel gives the 3D view a new layer at full resolution, in the session");
check(drawn > 0.9 * 320 * 360, `and the frames go on being drawn into it (${drawn} pixels)`);
const coverage = await page.evaluate(() => window.__xrMock.coverage());
const eye = await page.evaluate(() => [window.__xrMock.layer.eyeW, window.__xrMock.layer.eyeH]);
check(coverage.every((c) => c > 0.97), `the whole of each eye is drawn at its new size ${eye.join("x")}, not a cropped image (${coverage.map((c) => (100 * c).toFixed(0) + "%").join(", ")})`);
// And back to Speed: smaller than the first
await aim("resolution:0.5");
await frames(1);
await trigger("selectstart");
await trigger("selectend");
await page.evaluate(() => (window.__xrMock.rayMatrix = null));
await frames(3);
const coverageSpeed = await page.evaluate(() => window.__xrMock.coverage());
check(coverageSpeed.every((c) => c > 0.97), `and at Speed too (${coverageSpeed.map((c) => (100 * c).toFixed(0) + "%").join(", ")})`);
await aim("resolution:1");
await frames(1);
await trigger("selectstart");
await trigger("selectend");
await page.evaluate(() => (window.__xrMock.rayMatrix = null));
await frames(3);
check(await page.evaluate(() => localStorage.getItem("slicerxr.resolution")) === "1", "the resolution is remembered");

// The slider: dragged with the ray, from the left (no target) to about 30 fps
await aim("fps", 0.0);
await frames(1);
await trigger("selectstart");
await frames(1);
check(await page.evaluate(() => window.slicerXR.session.panel.fpsTarget) === 0, "at its left end the slider sets no target (full detail)");
await aim("fps", 4 / 15);
await frames(2);
await trigger("selectend");
await page.evaluate(() => (window.__xrMock.rayMatrix = null));
const target = await page.evaluate(() => window.slicerXR.session.panel.fpsTarget);
check(target === 30, `dragged along, it sets the target (${target} fps)`);
check(await page.evaluate(() => localStorage.getItem("slicerxr.fpsTarget")) === "30", "the target is remembered");

// Frames slower than the target: the volume is drawn coarser
await paced(8, 4.5);
const coarse = await mapper();
const stats = await page.evaluate(() => window.slicerXR.session.panel.renderStats);
check(coarse[0] > original[0] && coarse[1] > original[1] && !coarse[2],
  `frames slower than the target make the volume coarser (rays 1 per ${coarse[0]} px, step ${coarse[1]} mm; "${stats}")`);

// Frames well faster than the target: finer again
await page.evaluate(() => window.slicerXR.session.panel.setFpsTarget(15));
await paced(60, 6);
const finer = await mapper();
check(finer[0] < coarse[0], `frames well faster than the target make it finer again (rays 1 per ${finer[0]} px)`);

await page.evaluate(() => window.__xrMock.session.end());
await page.waitForTimeout(500);
const after = await python("(lambda m: [m.GetImageSampleDistance(), round(m.GetSampleDistance(), 4)])(slicer.app.layoutManager().views()['1'].GetRenderer().GetVolumes().GetItemAsObject(0).GetMapper())");
const restored = JSON.parse(after);
check(restored[0] === original[0] && Math.abs(restored[1] - original[1]) < 1e-6, `after the session the volume is drawn as Slicer had it (${after})`);
await browser.close();
process.exit(failed ? 1 : 0);

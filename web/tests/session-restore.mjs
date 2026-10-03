// The scene is kept when the page goes into the background and offered back at the next start -
// what a phone reclaiming the tab costs is then the start-up, not the work. The module that was open
// is opened again with it.
// Usage: node tests/session-restore.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
/** Hide the page the way switching applications does: the document says so and tells its listeners. */
const hide = (page) => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
const nodes = (page) => page.evaluate(() => window.slicerWeb.bridge.evalPython(
  'sorted(n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLStorableNode") if n.IsA("vtkMRMLVolumeNode") or n.IsA("vtkMRMLMarkupsNode"))', "eval"));

// A session with something in it
let page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
// what the question about restoring is answered: nothing to restore yet at first
let answer = "dismiss";
let offered = "";
page.on("dialog", (d) => { offered = d.message(); d[answer](); });
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(6000);
await page.evaluate(() => window.slicerWeb.bridge.evalPython(
  'n = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode", "Measurement"); n.AddControlPoint(0, 0, 0); n.AddControlPoint(10, 0, 0)', "exec"));
// and a segmentation, a green ball in the middle of the volume
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import numpy as np, slicer
volume = slicer.util.getNode("CT-chest")
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Segmentation")
seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(volume)
segmentId = seg.GetSegmentation().AddEmptySegment("ball", "ball", (0.1, 0.9, 0.1))
shape = slicer.util.arrayFromVolume(volume).shape
k, j, i = np.indices(shape)
c = np.array(shape) // 2
slicer.util.updateSegmentBinaryLabelmapFromArray((((k - c[0]) ** 2 + (j - c[1]) ** 2 + (i - c[2]) ** 2) < 40 ** 2).astype(np.uint8), seg, segmentId, volume)
`, "exec"));
await page.waitForTimeout(1000);
/** Pixels of the segment's color in the Red slice view. */
const segmentPixels = (page) => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["Red"]);
  const host = document.querySelector("#slicer-view-Red");
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const gl = canvas?.getContext("webgl2");
  if (!gl) return -1;
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let count = 0;
  for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 1] > pixels[p] + 50 && pixels[p + 1] > pixels[p + 2] + 50) count++;
  return count;
});
const segmentPixelsBefore = await segmentPixels(page);
const rows = (page) => page.locator(".sw-row").count();
const before = await nodes(page);
const rowsBefore = await rows(page);
console.log("scene:", before, `(${rowsBefore} rows in the data tree)`);

// with a module open, which comes back with the scene
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Markups"; });
await page.waitForTimeout(1500);

// Going into the background keeps it
const t0 = Date.now();
await hide(page);
let info = null;
for (let i = 0; i < 60 && !info; i++) {
  await page.waitForTimeout(1000);
  info = await page.evaluate(() => window.slicerWeb.bridge.call("sessionInfo"));
}
if (!info) { console.log("nothing was kept"); process.exit(1); }
console.log(`kept in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${info.count} node(s), ${(info.bytes / 1048576).toFixed(1)} MB`);
check("the scene was kept", info.count >= 2, true);
await page.waitForTimeout(1500); // for IndexedDB to take it
const again = await page.evaluate(() => window.slicerWeb.bridge.call("saveSession"));
check("hidden again with nothing changed, nothing is written", again.reason, "nothing changed");

// The next start of the tab (a reload: a session is the tab's own) offers it back
answer = "accept";
offered = "";
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText), null, { timeout: 120000 });
await page.waitForTimeout(6000);
check("the next start asks about it", /Restore the scene/.test(offered), true);
console.log("asked:", offered.replace(/\s+/g, " "));
const after = await nodes(page);
check("and brings it back whole", JSON.stringify(after), JSON.stringify(before));
const segmentPixelsAfter = await segmentPixels(page);
check("and the segmentation is shown in the slice views at once", segmentPixelsBefore > 100 && Math.abs(segmentPixelsAfter - segmentPixelsBefore) < 0.05 * segmentPixelsBefore, true);
console.log(`segment pixels in the Red view: ${segmentPixelsBefore} before, ${segmentPixelsAfter} after`);
check("with the module that was open", await page.evaluate(() => window.slicerWeb.store.activeModule), "Markups");
check("rather than the sample the address names as well", (after.match(/CT-chest/g) ?? []).length, 1);
// A bundle comes in inside a batch, and its subject hierarchy items are resolved only once the
// batch has ended: nothing must make items for its nodes before then, or each is listed twice.
check("and the data tree lists each node once", await rows(page), rowsBefore);

// Declining forgets it
answer = "dismiss";
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(3000);
check("declining forgets it", await page.evaluate(() => window.slicerWeb.bridge.call("sessionInfo")), null);
await page.close();

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

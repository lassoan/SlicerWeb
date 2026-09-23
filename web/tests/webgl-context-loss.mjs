// A view whose WebGL context is lost - a phone's browser lets go of the GPU while the page is in
// the background - is made again and shows what it showed, rather than a sad face.
// Usage: node tests/webgl-context-loss.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(6000);

/**
 * Whether the red view shows anything: the size of a screenshot of it. A view of nothing is a
 * black rectangle and compresses to almost nothing; a slice of a CT does not. (Reading the
 * canvas's pixels directly finds a cleared buffer, the drawing buffer not being preserved.)
 */
const drawn = async () => (await page.locator("#slicer-view-Red").screenshot({ type: "png" })).length;
await page.evaluate(() => window.slicerWeb.bridge.call("renderView", ["Red"]));
await page.waitForTimeout(500);
const before = await drawn();
console.log(`red view screenshot before: ${before} bytes`);
check("the view shows the volume", before > 5000, true);

// The GPU goes, as it does in the background, and comes back
const oldCanvas = await page.evaluate(() => { window.__oldCanvas = document.querySelector("#slicer-view-Red"); return true; });
await page.evaluate(() => {
  const gl = document.querySelector("#slicer-view-Red").getContext("webgl2");
  const ext = gl.getExtension("WEBGL_lose_context");
  ext.loseContext();
  setTimeout(() => ext.restoreContext(), 300);
});
await page.waitForTimeout(4000);
check("the view was made again on a new canvas", await page.evaluate(() => document.querySelector("#slicer-view-Red") !== window.__oldCanvas), true);
await page.evaluate(() => window.slicerWeb.bridge.call("renderView", ["Red"]));
await page.waitForTimeout(800);
const after = await drawn();
console.log(`red view screenshot after: ${after} bytes`);
check("and shows the volume again", after > 5000, true);
check("its context is live", await page.evaluate(() => !document.querySelector("#slicer-view-Red").getContext("webgl2").isContextLost()), true);
// the view still answers for its scene
check("it is still the red slice view of the scene",
      await page.evaluate(() => window.slicerWeb.bridge.evalPython('slicer.app.layoutManager().sliceWidget("Red").sliceLogic().GetBackgroundLayer().GetVolumeNode().GetName()', "eval")), "'CT-chest'");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

// The scene is kept when the page goes into the background and offered back at the next start -
// what a phone reclaiming the tab costs is then the start-up, not the work.
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
page.on("dialog", (d) => { console.log(`[dialog] ${d.message().split("\n")[0]}`); d.dismiss(); }); // nothing to restore yet
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(6000);
await page.evaluate(() => window.slicerWeb.bridge.evalPython(
  'n = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode", "Measurement"); n.AddControlPoint(0, 0, 0); n.AddControlPoint(10, 0, 0)', "exec"));
await page.waitForTimeout(500);
const before = await nodes(page);
console.log("scene:", before);

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
await page.close();

// The next start offers it back
page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let offered = "";
page.on("dialog", (d) => { offered = d.message(); d.accept(); });
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText), null, { timeout: 120000 });
await page.waitForTimeout(6000);
check("the next start asks about it", /Restore the scene/.test(offered), true);
console.log("asked:", offered.replace(/\s+/g, " "));
const after = await nodes(page);
check("and brings it back whole", JSON.stringify(after), JSON.stringify(before));
check("rather than the sample the address names as well", (after.match(/CT-chest/g) ?? []).length, 1);
await page.close();

// Declining forgets it
page = await context.newPage();
page.on("dialog", (d) => d.dismiss());
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(3000);
check("declining forgets it", await page.evaluate(() => window.slicerWeb.bridge.call("sessionInfo")), null);
await page.close();

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

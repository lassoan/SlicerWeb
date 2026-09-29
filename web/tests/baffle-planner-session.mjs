// Baffle Planner in a restored session: a baffle drawn with auto-update, the session kept while
// another module was open, then Baffle Planner opened and the page reloaded at once (nothing is
// written on the way out), and the session restored. Baffle Planner is open again, its selectors show the curve
// and the baffle model, Update is enabled, and moving a point of the curve updates the baffle - the
// module sets itself up again from its parameter node (as it does in desktop Slicer since the fix).
// Usage: node tests/baffle-planner-session.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const errors = [];
// what the question about restoring the last session is answered
let restore = false;
const open = async () => {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && /Traceback|Error in/.test(m.text())) errors.push(m.text().slice(0, 500)); });
  page.on("dialog", (d) => (restore ? d.accept() : d.dismiss()));
  await page.goto(base + "?sample=&extensions=SlicerHeart");
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
  await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "BafflePlanner"), null, { timeout: 120000 });
  return page;
};
const py = async (page, code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^['"]|['"]$/g, "");
const exec = (page, code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const state = (page) => py(page, `repr((lambda w: (
  (lambda n: n.GetName() if n else None)(w.ui.inputCurveSelector.currentNode()),
  (lambda n: n.GetName() if n else None)(w.ui.outputBaffleModelSelector.currentNode()),
  bool(w.ui.updateButton.enabled), int(w.ui.updateButton.checkState)))(slicer.modules.BafflePlannerWidget))`);

// a baffle drawn with auto-update
let page = await open();
await page.evaluate(() => { window.slicerWeb.store.activeModule = "BafflePlanner"; });
await page.waitForTimeout(3000);
await exec(page, `
import math
w = slicer.modules.BafflePlannerWidget
curve = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsClosedCurveNode", "Contour")
curve.CreateDefaultDisplayNodes()
for i in range(12):
    a = 2 * math.pi * i / 12
    curve.AddControlPoint([30 * math.cos(a), 20 * math.sin(a), 5 * math.sin(2 * a)])
w.ui.inputCurveSelector.setCurrentNode(curve)
`);
await page.locator(".sw-panel-scroll").last().locator("[data-name=outputBaffleModelSelector] select").selectOption("__create__");
await page.waitForTimeout(2000);
check("drawn: curve, baffle, Update enabled, auto-update", await state(page), "('Contour', 'Baffle', True, 2)");
const width = (page) => py(page, "round(slicer.util.getNode('Baffle').GetPolyData().GetBounds()[1], 1)");
check("the baffle follows the curve", await width(page), "30.0");

// into the background, with another module open: kept
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Data"; });
await page.waitForTimeout(1000);
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
let info = null;
for (let i = 0; i < 60 && !info; i++) {
  await page.waitForTimeout(1000);
  info = await page.evaluate(() => window.slicerWeb.bridge.call("sessionInfo"));
}
check("the session is kept", info?.count > 0, true);
await page.waitForTimeout(1500);

// back to Baffle Planner, and the page reloaded right away: nothing more is kept on the way out
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  window.slicerWeb.store.activeModule = "BafflePlanner";
});
await page.waitForTimeout(300);
restore = true;
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(6000);
check("Baffle Planner is open again", await page.evaluate(() => window.slicerWeb.store.activeModule), "BafflePlanner");
check("restored: curve, baffle, Update enabled, auto-update", await state(page), "('Contour', 'Baffle', True, 2)");
await exec(page, `slicer.util.getNode("Contour").SetNthControlPointPosition(0, [45, 0, 0])`);
await page.waitForTimeout(1500);
check("moving a point of the curve updates the baffle", await width(page), "45.0");
check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

// In the rotate/pan/zoom mouse mode a left-click-and-drag pans a slice view (as it rotates a 3D
// view); in the Scroll and window/level modes the left drag keeps doing what those modes do.
// With --shared, the views share one WebGL context (Rendering settings).
// Usage: node tests/slice-left-drag-pan.mjs [url] [--shared]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shared = process.argv.includes("--shared");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);

await page.goto(base + "?sample=MRHead&layout=FourUp");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(3000);
if (shared) {
  await page.evaluate(() => { window.slicerWeb.store.settings = { ...window.slicerWeb.store.settings, "Rendering/SharedWebGLContext": true }; });
  await page.waitForTimeout(8000);
}
const box = shared
  ? await page.evaluate(() => { const r = window.slicerWeb.store.viewRects.Red; return { x: r.left, y: r.top, width: r.width, height: r.height }; })
  : await page.locator("#slicer-view-Red").boundingBox();
const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];

/** Where the Red view is panned to (its XYZ origin, which a pan moves), its offset, and the window of its volume. */
const state = async () => JSON.parse(await py(`__import__("json").dumps((lambda n, l: [[round(v, 1) for v in n.GetXYZOrigin()], round(l.GetSliceOffset(), 1), round(slicer.util.getNode("MR-head").GetDisplayNode().GetWindow(), 1)])(slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeRed"), slicer.app.layoutManager().sliceWidget("Red").sliceLogic()))`));
const mode = async (m) => { await page.evaluate((v) => window.slicerWeb.bridge.call("setInteractionMode", [v]), m); await page.waitForTimeout(400); };
async function drag(dx, dy) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(cx + (dx * i) / 8, cy + (dy * i) / 8); await page.waitForTimeout(40); }
  await page.mouse.up();
  await page.waitForTimeout(600);
}
const reset = () => exec('slicer.app.layoutManager().sliceWidget("Red").sliceLogic().FitSliceToAll(); slicer.app.layoutManager().sliceWidget("Red").sliceLogic().SetSliceOffset(0)');
const moved = (a, b) => Math.hypot(b[0][0] - a[0][0], b[0][1] - a[0][1], b[0][2] - a[0][2]);

// ---- rotate/pan/zoom: pans
await mode("ViewTransform");
await reset();
let before = await state();
await drag(80, 40);
let after = await state();
console.log(`     slice origin ${before[0]} -> ${after[0]}`);
check("a left drag in the rotate/pan/zoom mode pans the slice", moved(before, after) > 20, true);
check("without browsing slices", after[1], before[1]);
check("or changing the window", after[2], before[2]);

// by touch: one finger pans too
await reset();
before = await state();
const cdp = await context.newCDPSession(page);
const point = (x, y) => ({ x, y, id: 1, radiusX: 10, radiusY: 10, force: 1 });
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(cx, cy)] });
for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(cx - 10 * i, cy)] }); await page.waitForTimeout(40); }
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(600);
after = await state();
check("so does a finger", moved(before, after) > 20, true);

// ---- the other modes keep their left drag
await mode("Scroll");
await reset();
before = await state();
await drag(0, -60);
after = await state();
check("Scroll mode: the left drag browses the slices", Math.abs(after[1] - before[1]) > 5, true);
check("and does not pan", moved(before, after) < 1, true);

await mode("AdjustWindowLevel");
await reset();
before = await state();
await drag(60, 0);
after = await state();
check("window/level mode: the left drag changes the window", after[2] !== before[2], true);
check("and does not pan", moved(before, after) < 1, true);

// ---- with the crosshair shown, the left drag moves the crosshair instead
await mode("ViewTransform");
await reset();
await exec('slicer.util.getNodesByClass("vtkMRMLCrosshairNode")[0].SetCrosshairMode(slicer.vtkMRMLCrosshairNode.ShowBasic)');
await page.waitForTimeout(300);
const crosshair = async () => JSON.parse(await py('__import__("json").dumps([round(v, 1) for v in slicer.util.getNodesByClass("vtkMRMLCrosshairNode")[0].GetCrosshairRAS()])'));
before = await state();
const crossBefore = await crosshair();
await drag(50, -30);
after = await state();
const crossAfter = await crosshair();
console.log(`     crosshair ${crossBefore} -> ${crossAfter}`);
check("crosshair shown: the left drag moves the crosshair", Math.hypot(...crossAfter.map((v, i) => v - crossBefore[i])) > 10, true);
check("and does not pan", moved(before, after) < 1, true);
await exec('slicer.util.getNodesByClass("vtkMRMLCrosshairNode")[0].SetCrosshairMode(slicer.vtkMRMLCrosshairNode.NoCrosshair)');
await page.waitForTimeout(300);

// ---- and back (crosshair hidden, rotate/pan/zoom): it pans again
await mode("ViewTransform");
await reset();
before = await state();
await drag(-60, 0);
after = await state();
check("back in the rotate/pan/zoom mode: pans again", moved(before, after) > 20, true);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

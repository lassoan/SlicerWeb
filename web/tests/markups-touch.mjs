// Touch: tap places a control point, and dragging with a finger moves it (phone screen).
import { chromium } from "playwright-core";
const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (!/GL Driver/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 300)}`); });
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (c) => String(await page.evaluate((code) => window.slicerWeb.bridge.evalPython(code, "eval"), c)).replace(/^'|'$/g, "");
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json, vtk"));
// count interactor events
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
_counts = {}
_interactor = slicer.app.layoutManager().view("Red").GetInteractor()
def _count(name):
    def cb(caller, event):
        _counts[name] = _counts.get(name, 0) + 1
    return cb
_cbs = []
_log = []
def _any(caller, event):
    _log.append(event)
    _counts[event] = _counts.get(event, 0) + 1
_interactor.AddObserver(vtk.vtkCommand.AnyEvent, _any, 100.0)
`));
await page.evaluate(() => {
  window.__touch = { start: 0, move: 0, end: 0 };
  const c = document.querySelector("#slicer-view-Red");
  c.addEventListener("touchstart", () => window.__touch.start++, { passive: true });
  c.addEventListener("touchmove", () => window.__touch.move++, { passive: true });
  c.addEventListener("touchend", () => window.__touch.end++, { passive: true });
});
// place one point with a tap
await page.evaluate(() => window.slicerWeb.bridge.call("placeMarkup", ["vtkMRMLMarkupsFiducialNode", "P", false]));
const box = await page.locator("#slicer-view-Red").boundingBox();
const cdp = await context.newCDPSession(page);
const p = (x, y) => ({ x, y, id: 1, radiusX: 10, radiusY: 10, force: 1 });
const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5;
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p(cx, cy)] });
await page.waitForTimeout(60);
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(800);
console.log("pointers after first tap:", await py('json.dumps({"count": _interactor.GetPointersDownCount(), "index": _interactor.GetPointerIndex()})'));
console.log("points:", await py('slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode")[0].GetNumberOfControlPoints()'));
const before = await py('json.dumps([slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode")[0].GetNthControlPointPositionVector(0)[i] for i in range(3)])');
await page.evaluate(() => window.slicerWeb.bridge.call("setInteractionMode", ["ViewTransform"]));
await page.waitForTimeout(400);
// drag the control point with touch
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p(cx, cy)] });
await page.waitForTimeout(120);
for (let i = 1; i <= 12; i++) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p(cx - i * 6, cy - i * 4)] });
  await page.waitForTimeout(60);
}
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(800);
const after = await py('json.dumps([slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode")[0].GetNthControlPointPositionVector(0)[i] for i in range(3)])');
console.log("pointers after drag:", await py('json.dumps({"count": _interactor.GetPointersDownCount(), "index": _interactor.GetPointerIndex()})'));
console.log("before:", before, "after:", after);
console.log("events:", await py('json.dumps(_counts)'));
console.log("sequence:", (await py('json.dumps(_log[-25:])')).slice(0, 500));
console.log("pointers:", await py('json.dumps({"down": _interactor.GetPointerIndex(), "pos": list(_interactor.GetEventPosition())})'));
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
for (let i = 0; i < 8; i++) { await page.mouse.move(box.x + 20 + i * 5, box.y + 40 + i * 5); await page.waitForTimeout(50); }
await page.waitForTimeout(500);
console.log("events after mouse move:", await py('json.dumps(_counts)'));
console.log("browser touch events on canvas:", JSON.stringify(await page.evaluate(() => window.__touch)));
console.log("registered listeners:", JSON.stringify(await page.evaluate(() => {
  const ev = window.slicerWeb.pyodide?._module?.JSEvents?.eventHandlers ?? [];
  const counts = {};
  for (const h of ev) {
    const key = (h.eventTypeString || "?") + "@" + ((h.target && (h.target.id || h.target.nodeName)) || "?");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
})));
console.log("widget state:", await py('json.dumps({"interactionNode": slicer.app.applicationLogic().GetInteractionNode().GetCurrentInteractionMode()})'));
await browser.close();

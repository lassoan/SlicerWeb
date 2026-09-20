// Markups: place control points in a slice view and drag one; reports glyph size and moved distance.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const mobile = process.argv.includes("--mobile");
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext(mobile
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
  : { viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json"));
console.log("screen scale factor:", await py('slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeRed").GetScreenScaleFactor()'));

// Place two control points by clicking in the Red slice view
await page.evaluate(() => window.slicerWeb.bridge.call("placeMarkup", ["vtkMRMLMarkupsFiducialNode", "Test points", true]));
const box = await page.locator("#slicer-view-Red").boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
for (const [fx, fy] of [[0.4, 0.45], [0.6, 0.55]]) {
  await page.mouse.click(...at(fx, fy));
  await page.waitForTimeout(400);
}
await page.evaluate(() => window.slicerWeb.bridge.call("setInteractionMode", ["ViewTransform"]));
await page.waitForTimeout(500);
console.log("points:", await py('slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode")[0].GetNumberOfControlPoints()'));
const before = JSON.parse(await py('json.dumps([slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode")[0].GetNthControlPointPositionVector(0)[i] for i in range(3)])'));

// Drag the first control point
const [x0, y0] = at(0.4, 0.45);
const [x1, y1] = at(0.3, 0.3);
await page.mouse.move(x0, y0);
await page.waitForTimeout(300);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
  await page.waitForTimeout(60);
}
await page.mouse.up();
await page.waitForTimeout(800);
const after = JSON.parse(await py('json.dumps([slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode")[0].GetNthControlPointPositionVector(0)[i] for i in range(3)])'));
const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
console.log(`control point moved ${moved.toFixed(1)} mm (${before.map((v) => v.toFixed(0))} -> ${after.map((v) => v.toFixed(0))})`);
if (shot) await page.screenshot({ path: shot });
await browser.close();

// Two-finger pan test: drag two touch points by 100 CSS pixels on the Red slice view and compare the
// slice origin change with the finger movement (in mm).
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:4173/?sample=CTChest";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(url);
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 180000 });
await page.waitForTimeout(3000);
const py = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code);
const state = async () => JSON.parse((await py(`json.dumps([list(slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeRed").GetXYZOrigin()), slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeRed").GetFieldOfView()[0] / slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeRed").GetDimensions()[0]])`)).slice(1, -1));
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json"));
const box = await page.locator("#slicer-view-Red").boundingBox();
const [origin0, mmPerDevicePixel] = await state();
const cdp = await context.newCDPSession(page);
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const pts = (dx) => [{ x: cx - 30 + dx, y: cy, id: 1 }, { x: cx + 30 + dx, y: cy, id: 2 }];
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pts(0)[0]] });
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(0) });
const steps = 20, distance = 100;
for (let i = 1; i <= steps; i++) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts((distance * i) / steps) });
  await page.waitForTimeout(20);
}
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(500);
const [origin1] = await state();
const moved = Math.abs(origin1[0] - origin0[0]);
const expected = distance * 3 * mmPerDevicePixel;
console.log(`slice moved ${moved.toFixed(1)} mm, fingers moved ${expected.toFixed(1)} mm (ratio ${(moved / expected).toFixed(2)})`);
await browser.close();

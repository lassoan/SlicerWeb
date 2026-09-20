// Dragging in a view is followed outside it, and a release outside ends the drag: the view must not
// go on rotating when the cursor comes back with the button up.
// Usage: node tests/view-drag-capture.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json"));
const camera = async () => JSON.parse(await py('json.dumps([round(v, 2) for v in slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLCameraNode").GetPosition()])'));
const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]).toFixed(1);

const box = await page.locator("#slicer-view-1").boundingBox();
const start = [box.x + box.width * 0.5, box.y + box.height * 0.5];

// drag out of the view: the rotation must go on while the button is down
const before = await camera();
await page.mouse.move(...start);
await page.mouse.down();
for (let i = 1; i <= 5; i++) { await page.mouse.move(start[0] + i * 20, start[1]); await page.waitForTimeout(60); }
const insideView = await camera();
for (let i = 1; i <= 6; i++) { await page.mouse.move(box.x + box.width + i * 25, start[1]); await page.waitForTimeout(60); }
const outsideView = await camera();
console.log(`rotated inside the view: ${moved(before, insideView)} mm, then outside it: ${moved(insideView, outsideView)} mm`);

// release outside, then come back: nothing must move
await page.mouse.up();
await page.waitForTimeout(300);
const released = await camera();
for (let i = 5; i >= 0; i--) { await page.mouse.move(box.x + box.width * 0.5 + i * 30, start[1]); await page.waitForTimeout(60); }
await page.waitForTimeout(400);
const afterReturn = await camera();
console.log(`after releasing outside and moving back over the view: ${moved(released, afterReturn)} mm (must be 0.0)`);
await browser.close();

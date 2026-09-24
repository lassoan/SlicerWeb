// The Scroll mouse mode: dragging up and down in a slice view browses its slices, the height of
// the view mapped to the whole slice range (vtkMRMLSliceIntersectionWidget); in the usual mode
// the same drag does not scroll. The toolbar shows the mode, and a finger drags the same way.
// Usage: node tests/mouse-mode-scroll.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const offset = async () => Number(await py('slicer.app.layoutManager().sliceWidget("Red").sliceLogic().GetSliceOffset()'));
const mode = () => page.evaluate(() => window.slicerWeb.store.interactionMode);

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const box = await page.locator("#slicer-view-Red").boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
async function drag(dy) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx, cy + (dy * i) / 10);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
}

check("Scroll is the mode the application starts in", await mode(), "Scroll");
check("the slice bar has its offset slider on a wide view", await page.locator("[data-name=sliceOffsetSlider]").count() > 0, true);
const start = await offset();
await page.getByRole("button", { name: "Rotate / Pan / Zoom" }).first().click();
await page.waitForTimeout(500);
check("the toolbar enters the view transform mode", await mode(), "ViewTransform");
await drag(-100);
check("in which a drag does not scroll", await offset(), start);

await page.getByRole("button", { name: "Scroll slices" }).first().click();
await page.waitForTimeout(500);
check("and back to Scroll mode", await mode(), "Scroll");
check("as the interaction node says", await py('slicer.app.applicationLogic().GetInteractionNode().GetInteractionModeAsString(slicer.app.applicationLogic().GetInteractionNode().GetCurrentInteractionMode())'), "Scroll");
await drag(-100);
const up = await offset();
console.log(`     slice offset ${start.toFixed(1)} -> ${up.toFixed(1)} mm after dragging up`);
check("dragging up browses the slices", Math.abs(up - start) > 5, true);
await drag(100);
const down = await offset();
console.log(`     -> ${down.toFixed(1)} mm after dragging down`);
check("dragging down browses back", Math.abs(down - up) > 5 && Math.abs(down - start) < Math.abs(up - start), true);

// A finger does the same
const cdp = await context.newCDPSession(page);
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy, id: 0 }] });
for (let i = 1; i <= 10; i++) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx, y: cy - 8 * i, id: 0 }] });
  await page.waitForTimeout(40);
}
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(400);
const touched = await offset();
console.log(`     -> ${touched.toFixed(1)} mm after a finger dragged up`);
check("a finger dragging up browses the slices too", Math.abs(touched - down) > 5, true);

await page.getByRole("button", { name: "Rotate / Pan / Zoom" }).first().click();
await page.waitForTimeout(300);
check("back to the usual mode", await mode(), "ViewTransform");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

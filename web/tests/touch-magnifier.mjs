// Magnifier: while control points are placed or moved with a finger, the image under the finger is
// shown enlarged above it. With --shared, the views share one WebGL context (Rendering settings).
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const shared = process.argv.includes("--shared");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (m.type() === "error" && !/GL Driver/.test(m.text())) console.log(`[error] ${m.text().slice(0, 200)}`); });
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
if (shared) {
  await page.evaluate(() => { window.slicerWeb.store.settings = { ...window.slicerWeb.store.settings, "Rendering/SharedWebGLContext": true }; });
  await page.waitForTimeout(8000);
  console.log("views sharing a context:", await page.evaluate(() => window.slicerWeb.bridge.evalPython("slicer.app.layoutManager().sharedCanvas().GetNumberOfViews()", "eval")));
}
const cdp = await context.newCDPSession(page);
const box = shared
  ? await page.evaluate(() => { const r = window.slicerWeb.store.viewRects.Red; return { x: r.left, y: r.top, width: r.width, height: r.height }; })
  : await page.locator("#slicer-view-Red").boundingBox();
const point = (x, y) => ({ x, y, id: 1, radiusX: 12, radiusY: 12, force: 1 });
const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.55;
const magnifier = () => page.evaluate(() => {
  const el = document.querySelector(".rounded-full.border-2");
  if (!el) return null;
  const canvas = el.querySelector("canvas");
  const context = canvas.getContext("2d");
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) nonBlack++;
  const rect = el.getBoundingClientRect();
  return { visible: true, nonBlackFraction: +(nonBlack / (data.length / 4)).toFixed(2), bottom: Math.round(rect.bottom), left: Math.round(rect.left) };
});

// place a control point with a tap (place mode on)
await page.evaluate(() => window.slicerWeb.bridge.call("placeMarkup", ["vtkMRMLMarkupsFiducialNode", "Points", true]));
await page.waitForTimeout(300);
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(cx, cy)] });
await page.waitForTimeout(250);
await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(cx + 2, cy)] });
await page.waitForTimeout(400);
console.log("while placing:", JSON.stringify(await magnifier()), "finger y:", Math.round(cy));
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(600);
console.log("after touch end:", JSON.stringify(await magnifier()));
await page.evaluate(() => window.slicerWeb.bridge.call("setInteractionMode", ["ViewTransform"]));
await page.waitForTimeout(400);

// drag the control point
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(cx, cy)] });
await page.waitForTimeout(250);
for (let i = 1; i <= 6; i++) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(cx - i * 5, cy - i * 3)] });
  await page.waitForTimeout(120);
}
console.log("while dragging:", JSON.stringify(await magnifier()));
if (shot) await page.screenshot({ path: shot });
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(500);
console.log("after drag end:", JSON.stringify(await magnifier()));
// no magnifier when only panning the view
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(box.x + 20, box.y + 20)] });
await page.waitForTimeout(250);
await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(box.x + 40, box.y + 40)] });
await page.waitForTimeout(400);
console.log("while panning:", JSON.stringify(await magnifier()));
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await browser.close();

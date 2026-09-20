// Double tap on a view maximizes it, and restores the layout when tapped twice again (touch screen).
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv[3];
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelectorAll("canvas").length >= 4, null, { timeout: 300000 });
await page.waitForTimeout(3000);
const canvases = () => page.evaluate(() => [...document.querySelectorAll("canvas")].map((c) => c.id).join(","));
console.log("before:", await canvases());
const cdp = await context.newCDPSession(page);
async function doubleTap(box) {
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  for (let i = 0; i < 2; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await page.waitForTimeout(40);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(90);
  }
}
await doubleTap(await page.locator(process.env.VIEW ? "#slicer-view-" + process.env.VIEW : "#slicer-view-Red").boundingBox());
await page.waitForTimeout(2500);
console.log("after double tap:", await canvases());
if (shot) await page.screenshot({ path: shot });
await doubleTap(await page.locator(process.env.VIEW ? "#slicer-view-" + process.env.VIEW : "#slicer-view-Red").boundingBox());
await page.waitForTimeout(2500);
console.log("after second double tap:", await canvases());
await browser.close();

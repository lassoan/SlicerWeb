// Maximize button of the view controller: shows the view alone and restores the layout.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv[3];
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => document.querySelectorAll("canvas").length >= 4, null, { timeout: 300000 });
await page.waitForTimeout(3000);
const canvases = () => page.evaluate(() => [...document.querySelectorAll("canvas")].map((c) => c.id));
console.log("views:", (await canvases()).join(", "));
const red = page.locator("#slicer-view-Red").locator("xpath=ancestor::*[contains(@class,'min-h-0')][1]");
await page.getByTitle("Maximize view").first().click();
await page.waitForTimeout(2500);
console.log("after maximize:", (await canvases()).join(", "));
if (shot) await page.screenshot({ path: shot });
await page.getByTitle("Restore view layout").first().click();
await page.waitForTimeout(2500);
console.log("after restore:", (await canvases()).join(", "));
await browser.close();

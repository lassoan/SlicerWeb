// The toolbar must fit a phone held upright: the markup tools are a menu, and what does not fit is
// in an overflow menu.
// Usage: node tests/phone-toolbar.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const nav = page.locator("nav[aria-label='Toolbar']");
const fits = await nav.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
console.log(`toolbar: ${fits.scrollWidth} px of buttons in ${fits.clientWidth} px ${fits.scrollWidth <= fits.clientWidth + 1 ? "(fits)" : "(does not fit)"}`);
console.log("buttons shown:", await nav.locator("button").count());

// the markup menu places a markup
await page.getByRole("button", { name: /place markup/i }).click();
await page.waitForTimeout(300);
const items = await page.locator("[role='menuitem']").allInnerTexts();
console.log("markup menu:", items.join(", "));
if (shot) await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: 390, height: 260 } });
await page.getByRole("menuitem", { name: "Line" }).click();
await page.waitForTimeout(600);
console.log("interaction mode after choosing Line:", await page.evaluate(() => window.slicerWeb.store.interactionMode));
console.log("menu closed:", await page.locator("[role='menuitem']").count() === 0);

// the overflow menu holds what was dropped from the bar
await page.getByRole("button", { name: /^more$/i }).click();
await page.waitForTimeout(300);
console.log("more menu:", (await page.locator("[role='menuitem']").allInnerTexts()).join(", "));
await browser.close();

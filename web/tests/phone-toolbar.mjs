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

// the menus must work with a tap (they used to be cut off by the scrolling toolbar)
await page.getByRole("button", { name: /new markup/i }).tap();
await page.waitForTimeout(300);
const items = await page.locator("[role='menuitem']").allInnerTexts();
console.log("markup menu:", items.join(", "));
if (shot) await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: 390, height: 260 } });
await page.getByRole("menuitem", { name: "Line" }).tap();
await page.waitForTimeout(600);
console.log("interaction mode after choosing Line:", await page.evaluate(() => window.slicerWeb.store.interactionMode));
console.log("menu closed:", await page.locator("[role='menuitem']").count() === 0);

// the menus hold what was dropped from the bar: the mouse modes, the favourite modules
for (const name of [/mouse mode/i, /^modules$/i]) {
  await page.getByRole("button", { name }).tap();
  await page.waitForTimeout(300);
  console.log(`${name} menu:`, (await page.locator("[role='menuitem']").allInnerTexts()).join(", "));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}
// a slice view too narrow for the whole of its bar does without the offset slider
console.log("offset sliders on the phone:", await page.locator("[data-name=sliceOffsetSlider]").count(), "(none expected)");
// the layout list, hung under its button, in view
await page.getByRole("button", { name: "Layout" }).first().tap();
await page.waitForTimeout(400);
const layoutMenu = await page.locator("[data-name='layoutMenu']").boundingBox();
console.log("layout list in view:", !!layoutMenu && layoutMenu.x >= 0 && layoutMenu.x + layoutMenu.width <= 390 && layoutMenu.height > 200);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// the application menu at the end of the bar
await page.getByRole("button", { name: /application menu/i }).tap();
await page.waitForTimeout(300);
console.log("application menu:", (await page.locator("[role='menuitem']").allInnerTexts()).join(", "));
await page.locator("[data-name='menu:log']").tap();
await page.waitForTimeout(600);
console.log("log window opened from the menu:", await page.locator("[data-name='logWindow']").count() > 0);
await browser.close();

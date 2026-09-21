// The title bar of the module panel: the module that is open, the finder, the back and forward
// arrows and the list of modules used recently - the module toolbar of desktop Slicer, in the
// place where the panel's "Modules" tab label used to be.
// Usage: node tests/module-title-bar.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(1500);

const bar = page.locator("[data-name='moduleTitleBar']");
const title = () => bar.locator("[data-name='moduleTitle']").innerText();
console.log("title bar shows the module, not 'Modules':", await title());

// the title opens the finder; typing and Enter opens the first match
async function open(name) {
  await bar.locator("[data-name='moduleTitle']").click();
  await page.waitForTimeout(300);
  await page.keyboard.type(name);
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
}
await open("Volumes");
console.log("after opening Volumes:", await title());
await open("Markups");
console.log("after opening Markups:", await title());

// the arrows walk back and forth, as they do in the module toolbar of desktop Slicer
await bar.locator("[data-name='previousModule']").click();
await page.waitForTimeout(600);
console.log("back:", await title());
await bar.locator("[data-name='previousModule']").click();
await page.waitForTimeout(600);
console.log("back again:", await title());
console.log("back is disabled at the start:", await bar.locator("[data-name='previousModule']").isDisabled());
await bar.locator("[data-name='nextModule']").click();
await page.waitForTimeout(600);
console.log("forward:", await title());

// the list of the modules used recently
await bar.locator("[data-name='recentModules']").click();
await page.waitForTimeout(300);
const recent = await bar.locator("[data-name='recentModuleList'] button").allInnerTexts();
console.log("recently used:", JSON.stringify(recent));
await bar.locator("[data-name='recentModuleList'] button", { hasText: "Markups" }).first().click();
await page.waitForTimeout(700);
console.log("after picking Markups from the list:", await title());

// the search icon does what the title does
await bar.locator("[data-name='findModule']").click();
await page.waitForTimeout(400);
console.log("finder open from the search icon:", await page.locator("[data-name='moduleFinder']").count() > 0
  || await page.locator("input[placeholder*='odule']").count() > 0);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// and the help of the module that is open
await bar.locator("[data-name='moduleHelp']").click();
await page.waitForTimeout(400);
console.log("help shown:", (await page.locator("aside .bg-card").first().innerText().catch(() => "")).slice(0, 70));
if (shot) await page.screenshot({ path: shot });
await browser.close();

// While 3D Slicer is loading, the side panels are shown but cannot be used, as the toolbar and the
// views: only the buttons that collapse them work. Once it is ready, they can. A file dropped where
// nothing takes it does not have the browser open it in place of the application.
// Usage: node tests/panels-while-loading.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failed = false;
const check = (what, ok, detail) => { if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${detail}`); };

// what can be used in the panels: what is not disabled, not inert, and takes the pointer
const usable = () => page.evaluate(() => [...document.querySelectorAll("aside button, aside input, aside select, aside [tabindex]")]
  .filter((b) => !b.disabled && b.offsetParent && !b.closest("[inert]") && getComputedStyle(b).pointerEvents !== "none")
  .map((b) => b.getAttribute("aria-label") || b.title || b.textContent.trim().slice(0, 30)));

await page.goto(`${base}?sample=`);
await page.waitForSelector("aside", { timeout: 60000 });
await page.waitForTimeout(1000);
const loading = await page.evaluate(() => !window.slicerWeb?.bridge || !document.querySelector("canvas"));
const whileLoading = await usable();
check("while loading, only the collapse buttons can be used", loading && whileLoading.every((b) => b === "Collapse panel") && whileLoading.length === 2,
  `${loading ? "loading" : "already loaded"}: ${JSON.stringify(whileLoading)}`);
if (process.argv[3]) await page.screenshot({ path: process.argv[3] });
// a click on a button of the panel does nothing
const samples = page.locator("aside").getByRole("button", { name: /Sample data/i }).first();
await samples.click({ force: true, timeout: 2000 }).catch(() => {});
await page.waitForTimeout(300);
check("a click on one does nothing", await page.getByText("Sample data", { exact: false }).locator("visible=true").count() <= 1, "");
// the panel still collapses and opens
await page.locator("aside").first().getByTitle("Collapse panel").click();
await page.waitForTimeout(300);
// in its place, the strip that opens it again (and the other panel)
const collapsed = await page.evaluate(() => [...document.querySelectorAll("aside")].map((a) => Math.round(a.getBoundingClientRect().width)));
check("a panel still collapses", collapsed.length === 2 && collapsed[0] < 30, `widths of the panels: ${JSON.stringify(collapsed)}`);
await page.locator("aside").first().locator("button").first().click();
await page.waitForTimeout(300);

// a stray drop: its default (the browser opening the file) is prevented
const prevented = await page.evaluate(() => {
  const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
  document.querySelector("main").dispatchEvent(event);
  return event.defaultPrevented;
});
check("a file dropped where nothing takes it is not opened by the browser", prevented, `defaultPrevented: ${prevented}`);

await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(1500);
const ready = await usable();
check("once ready, the panels can be used", ready.some((b) => /Load files/i.test(b)) && ready.some((b) => /Find a module/i.test(b)), JSON.stringify(ready));
await browser.close();
console.log(failed ? "FAIL" : "ok");
process.exit(failed ? 1 : 0);

// The name and colour of a slice view open a menu, which holds the button that shows the slice in
// the 3D views (the image button of Slicer's slice controller).
// Usage: node tests/slice-view-menu.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);
const text = async (expr) => String(await value(expr)).replace(/^'|'$/g, "");

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

const visibleInPython = () => text(`str(bool(slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode().GetSliceVisible()))`);

const red = page.locator("[data-name='viewMenu']").first();
check("the slice name is a button", await red.count() > 0, await red.innerText().catch(() => ""));
check("it is hidden in 3D to begin with", (await visibleInPython()) === "False");

await red.click();
await page.waitForTimeout(300);
const item = page.locator("[data-name='menu:showIn3D']");
check("the menu offers showing it in 3D", await item.count() > 0, (await item.first().innerText().catch(() => "")).trim());

await item.first().click();
await page.waitForTimeout(500);
check("clicking it shows the slice in 3D", (await visibleInPython()) === "True");

// and off again
await red.click();
await page.waitForTimeout(300);
await page.locator("[data-name='menu:showIn3D']").first().click();
await page.waitForTimeout(500);
check("clicking it again hides it", (await visibleInPython()) === "False");

// the menu closes when the page is clicked elsewhere
await red.click();
await page.waitForTimeout(300);
await page.mouse.click(700, 500);
await page.waitForTimeout(300);
check("the menu closes when something else is clicked", (await page.locator("[data-name='menu:showIn3D']").count()) === 0);

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

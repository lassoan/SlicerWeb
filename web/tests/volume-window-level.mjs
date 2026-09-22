// Volumes module: the window and level can be set by the application, by window and level, or by
// the two ends of the displayed range (as qMRMLWindowLevelWidget does on the desktop).
// Usage: node tests/volume-window-level.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const py = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code);
const windowLevel = () => py('repr((round(slicer.util.getNode("CT-chest").GetDisplayNode().GetWindow()),'
  + ' round(slicer.util.getNode("CT-chest").GetDisplayNode().GetLevel()),'
  + ' slicer.util.getNode("CT-chest").GetDisplayNode().GetAutoWindowLevel()))');
let failures = 0;
const check = (what, got, expected) => {
  const ok = String(got).includes(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};

await page.evaluate(() => { window.slicerWeb.store.activeModule = "Volumes"; });
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
const mode = panel.locator("select").filter({ hasText: "Manual Min/Max" }).first();
check("the volume starts with an automatic window and level", await windowLevel(), ", 1)");

// Set the displayed range by its ends: -200 to 800 is a window of 1000 around a level of 300.
await mode.selectOption({ label: "Manual Min/Max" });
await page.waitForTimeout(600);
const boxes = panel.locator(".sw-slider input[type=number]");
await boxes.nth(0).fill("-200");
await boxes.nth(0).press("Enter");
await page.waitForTimeout(500);
await boxes.nth(1).fill("800");
await boxes.nth(1).press("Enter");
await page.waitForTimeout(700);
check("min -200 and max 800 make a window of 1000 at level 300", await windowLevel(), "(1000, 300, 0)");

// Back to the application's own choice, and back to window and level.
await mode.selectOption({ label: "Auto" });
await page.waitForTimeout(900);
check("Auto hands the choice back to the application", await windowLevel(), ", 1)");
await mode.selectOption({ label: "Manual" });
await page.waitForTimeout(600);
const rows = (await panel.innerText()).replace(/\s+/g, " ");
check("Manual shows a window and a level", /Window .*Level /.test(rows) ? "Window and Level" : rows.slice(0, 80), "Window and Level");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

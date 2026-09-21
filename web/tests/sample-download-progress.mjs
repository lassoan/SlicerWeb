// Clicking a data set in the Sample Data module: the page fetches the file while the window goes
// on drawing, the button it was asked from shows how far along it is, and the module carries on
// once the file is there (see slicerweb/downloads.py and qtcompat/core.py).
// Usage: node tests/sample-download-progress.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
await page.evaluate(() => { window.__logs = []; window.slicerWeb.bridge.events.on("log", (e) => window.__logs.push(e)); });
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);

// the Sample Data module, where Slicer's own data sets are listed
await page.locator("[data-name='moduleTitle']").click();
await page.getByPlaceholder("Search modules").fill("Sample Data");
await page.waitForTimeout(500);
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);

const button = page.locator("button", { hasText: /CT Cardio Sequence/ }).first();
console.log("the data set is offered:", (await button.count()) > 0);
const clicked = Date.now();
button.click({ noWaitAfter: true }).catch(() => {});

// Watched through the DOM only: asking Python anything costs the page the one thread it draws
// and downloads with, which is the very thing this is about.
let sawProgress = "";
let finishedAfter = -1;
for (let i = 0; i < 300; i++) {
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => {
    const el = document.querySelector("[data-progress]");
    return {
      busy: el ? { text: el.getAttribute("data-progress"), width: getComputedStyle(el).getPropertyValue("--sw-progress") } : null,
      downloaded: (window.__logs ?? []).some((l) => /^Downloaded /.test(String(l.message))),
    };
  });
  if (state.busy && !sawProgress) sawProgress = `${state.busy.text} (bar at ${state.busy.width})`;
  if (state.downloaded) { finishedAfter = (Date.now() - clicked) / 1000; break; }
}
console.log("the button said:", sawProgress || "(nothing)");
console.log(`the file arrived after ${finishedAfter.toFixed(1)} s`);

await page.waitForTimeout(4000);
console.log("sequences in the scene:", await value(`str(__import__("slicer").mrmlScene.GetNumberOfNodesByClass("vtkMRMLSequenceNode"))`));
console.log("and its browser:", await value(`str(__import__("slicer").mrmlScene.GetNumberOfNodesByClass("vtkMRMLSequenceBrowserNode"))`));
console.log("the page still answers:", (await value("2 + 2")) === "4");
console.log("nothing is left marked busy:", (await page.locator("[data-progress]").count()) === 0);
if (shot) await page.screenshot({ path: shot });
await browser.close();

// Downloading and loading data shows how far along it is, over the views (activity.ts,
// ActivityIndicator.vue, slicerweb/loading_progress.py): the download with the size that arrived,
// the loading with the files of the scene that were read, and the first display of what was loaded;
// the indicator goes away when it is done.
// Usage: node tests/load-progress.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};
await page.addInitScript(() => {
  window.__steps = [];
  const look = () => {
    const el = document.querySelector("[data-name=activity]");
    const text = el ? el.innerText.replace(/\s+/g, " ").trim() : "";
    if (text !== (window.__steps[window.__steps.length - 1] ?? null)) window.__steps.push(text);
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
});
// a scene (.mrb) of the application's sample data, opened from the address of the page
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 600000 });
await page.waitForFunction(() => window.__steps.some((s) => /^Loading/.test(s)), null, { timeout: 600000, polling: 200 });
await page.waitForFunction(() => window.__steps.length > 1 && !document.querySelector("[data-name=activity]"), null, { timeout: 600000, polling: 200 });
const steps = await page.evaluate(() => window.__steps);
console.log("     steps:", JSON.stringify(steps.filter((s, i) => i < 3 || /Loading|Displaying/.test(s) || i === steps.length - 1)));
check("the download is shown with the size that arrived", steps.some((s) => /^Downloading CTChest… .*(KB|MB)/.test(s)));
check("then the loading", steps.some((s) => /^Loading CTChest…/.test(s)));
check("then the first display of what was loaded", steps.some((s) => /^Displaying CTChest…/.test(s)));
check("and it goes away when it is done", await page.evaluate(() => !document.querySelector("[data-name=activity]")));
check("the data is loaded", (await page.evaluate(() => window.slicerWeb.bridge.evalPython(`str(len(slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")))`, "eval"))).includes("1"));

// A scene (.mrb) loaded with the URL button of the Data panel: the files of the scene are counted as they are read
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import os, slicer
os.makedirs("/data/save", exist_ok=True)
slicer.util.saveScene("/data/save/progress-test.mrb")
slicer.mrmlScene.Clear()
`, "exec"));
await page.evaluate(() => { window.__steps = [""]; });
page.once("dialog", (d) => d.accept("/data/save/progress-test.mrb"));
await page.locator("button", { hasText: /^URL$/ }).first().click();
await page.waitForFunction(() => window.__steps.length > 2 && !document.querySelector("[data-name=activity]"), null, { timeout: 600000, polling: 200 });
const sceneSteps = await page.evaluate(() => window.__steps);
console.log("     scene steps:", JSON.stringify(sceneSteps));
check("loading a scene shows the files of it that were read", sceneSteps.some((s) => /^Loading progress-test\.mrb… 100% \d+ of \d+ files read/.test(s)),
  sceneSteps.filter((s) => /read/.test(s)).join(" | "));
check("then its first display", sceneSteps.some((s) => /^Displaying progress-test\.mrb…/.test(s)));
check("and the scene is loaded", (await page.evaluate(() => window.slicerWeb.bridge.evalPython(`str(len(slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")))`, "eval"))).includes("1"));
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

// Scene Views: storing the scene keeps a picture of the view with it, the list shows that picture,
// and clicking a scene view puts the scene back as it was.
// Usage: node tests/scene-views.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForFunction(() => window.slicerWeb.bridge.evalPython(
  "str(__import__('slicer').mrmlScene.GetNumberOfNodesByClass('vtkMRMLScalarVolumeNode'))", "eval").then((v) => v !== "0"),
  null, { timeout: 300000, polling: 2000 });
await page.waitForTimeout(2000);
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);

// the toolbar button opens the module rather than saving a picture
await page.getByRole("button", { name: "Scene Views" }).click();
await page.waitForTimeout(1500);
console.log("the toolbar button opens:", await page.locator("[data-name='moduleTitle']").innerText());

// a scene view of the scene as it is, with the volume shown
await page.locator("[data-name='create']").click();
await page.waitForTimeout(2500);
console.log("scene views:", await value(`str(__import__("slicer").mrmlScene.GetNumberOfNodesByClass("vtkMRMLSceneViewNode"))`));
const thumbnail = await page.locator("[data-name^='sceneView:'] img").first();
console.log("the list shows a picture:", await thumbnail.count() > 0);
if (await thumbnail.count()) {
  const size = await thumbnail.evaluate((img) => `${img.naturalWidth}x${img.naturalHeight}`);
  console.log("picture size:", size);
}
console.log("stored with the node:", await value(`str(__import__("slicer").mrmlScene.GetFirstNodeByClass("vtkMRMLSceneViewNode").GetScreenShot().GetDimensions())`));
console.log("there is no Restore button:", await page.locator("button", { hasText: /^Restore$/ }).count() === 0);

// Change how the volume is shown, then click the scene view to put the scene back. A scene view
// holds what the views look like, not the data (storable nodes are left out of it on purpose).
const window_ = () => value(`str(round(__import__("slicer").mrmlScene.GetFirstNodeByClass("vtkMRMLScalarVolumeDisplayNode").GetWindow()))`);
const stored = await window_();
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import slicer
display = slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLScalarVolumeDisplayNode")
display.SetAutoWindowLevel(0)
display.SetWindow(999.0)
`));
await page.waitForTimeout(1000);
const changed = await window_();
await page.locator("[data-name^='sceneView:'] [data-name='restore']").first().click();
await page.waitForTimeout(3000);
const restored = await window_();
console.log(`window ${stored} -> ${changed} -> ${restored} after clicking the scene view`);
console.log("the scene view put it back:", restored === stored);

if (shot) await page.screenshot({ path: shot });
await browser.close();

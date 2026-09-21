// Clicking a node in the subject hierarchy opens its module and selects it there - also when that
// module is already the one on screen.
// Usage: node tests/hierarchy-selection.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

// two models and a markups node in the scene
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import slicer, vtk
for name, radius in (("Sphere A", 10), ("Sphere B", 20)):
    source = vtk.vtkSphereSource(); source.SetRadius(radius); source.Update()
    node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLModelNode", name)
    node.SetAndObserveMesh(source.GetOutput()); node.CreateDefaultDisplayNodes()
points = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "Points")
points.AddControlPoint(0, 0, 0)
`));
await page.waitForTimeout(1500);

const selected = () => page.evaluate(() => {
  const select = document.querySelector('.sw-panel-scroll select.sw-node-selector');
  const option = select?.selectedOptions?.[0];
  return { module: document.querySelector("[data-name='moduleTitle']")?.textContent?.trim(), node: option?.textContent?.trim() };
});
const clickInTree = (name) => page.locator(".sw-panel-scroll >> text=" + name).first().click();

await clickInTree("Sphere A");
await page.waitForTimeout(1200);
console.log("after clicking Sphere A (Models was not open):", JSON.stringify(await selected()));

await clickInTree("Sphere B");
await page.waitForTimeout(1200);
console.log("after clicking Sphere B (Models already open):", JSON.stringify(await selected()));

await clickInTree("Points");
await page.waitForTimeout(1500);
console.log("after clicking the markups node:           ", JSON.stringify(await selected()));

await clickInTree("Sphere A");
await page.waitForTimeout(1500);
console.log("back to Sphere A:                          ", JSON.stringify(await selected()));
await browser.close();

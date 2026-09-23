// Transforms: a transform is applied to a node from a list, and its interaction handles are shown
// and hidden. View Controllers: the properties of a chosen view are edited and reach the scene.
// Usage: node tests/transforms-and-views.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const open = async (name) => { await page.evaluate((n) => { window.slicerWeb.store.activeModule = n; }, name); await page.waitForTimeout(1500); };
const panel = () => page.locator(".sw-panel-scroll").last();

await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(5000);

// ---- Transforms
await page.evaluate(() => window.slicerWeb.bridge.evalPython('t = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLinearTransformNode", "Shift")', "exec"));
await open("Transforms");
await page.evaluate(() => { window.slicerWeb.store.selectedNodeID = null; });
await page.waitForTimeout(800);
// the transform is chosen in the panel's selector
const selector = panel().locator("select").first();
await selector.selectOption({ label: "Shift" }).catch(async () => {
  const options = await selector.locator("option").allInnerTexts();
  console.log("selector offers:", options.join(" | "));
});
await page.waitForTimeout(1200);
check("the transformable nodes are listed", await panel().locator("[data-name^='transform:']").count() > 0, true);
const row = panel().locator("[data-name='transform:vtkMRMLScalarVolumeNode1']").first(); // CT-chest
await row.locator("input[type=checkbox]").click();
await page.waitForTimeout(800);
check("ticking the volume applies the transform to it", await py('slicer.util.getNode("CT-chest").GetTransformNodeID() == slicer.util.getNode("Shift").GetID()'), "True");
await row.locator("input[type=checkbox]").click();
await page.waitForTimeout(800);
check("unticking removes it", await py('repr(slicer.util.getNode("CT-chest").GetTransformNodeID())'), "None");

const handles = panel().locator("[data-name='handlesVisible'] input[type=checkbox]").first();
const handlesShown = () => py('(lambda d: bool(d is not None and d.GetEditorVisibility()))(slicer.util.getNode("Shift").GetDisplayNode())');
check("handles start hidden", await handlesShown(), "False");
await handles.click();
await page.waitForTimeout(800);
check("showing the handles reaches the display node", await handlesShown(), "True");
await handles.click();
await page.waitForTimeout(800);
check("and hiding them again", await handlesShown(), "False");

// ---- View Controllers
await open("ViewControllers");
const viewSelect = panel().locator("select").first();
const viewOptions = await viewSelect.locator("option").allInnerTexts();
check("the views of the layout are offered", viewOptions.length, 4);
await viewSelect.selectOption({ label: viewOptions.find((o) => /Red|R \(/.test(o)) ?? viewOptions[0] });
await page.waitForTimeout(1000);
const orientation = panel().locator("select").filter({ hasText: "Sagittal" }).first();
await orientation.selectOption({ label: "Coronal" });
await page.waitForTimeout(1000);
check("changing the orientation reaches the slice node", await py('slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode().GetOrientation()'), "Coronal");
const ruler = panel().locator("select").filter({ hasText: "Thick" }).first();
await ruler.selectOption({ label: "Thick" });
await page.waitForTimeout(800);
check("and the ruler", await py('slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode().GetRulerType()'), "2");

await viewSelect.selectOption({ label: viewOptions.find((o) => /3D/.test(o)) });
await page.waitForTimeout(1000);
const box = panel().locator("label", { hasText: "bounding box" }).locator("input[type=checkbox]").first();
const boxBefore = await py('bool([v for v in slicer.util.getNodesByClass("vtkMRMLViewNode") if v.GetLayoutName() == "1"][0].GetBoxVisible())');
await box.click();
await page.waitForTimeout(800);
check("toggling the bounding box reaches the 3D view node", await py('bool([v for v in slicer.util.getNodesByClass("vtkMRMLViewNode") if v.GetLayoutName() == "1"][0].GetBoxVisible())'), boxBefore === "True" ? "False" : "True");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

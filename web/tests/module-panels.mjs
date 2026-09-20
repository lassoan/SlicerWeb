// The web GUIs of the core modules: each panel opens, shows the state of its nodes and acts on them.
// Usage: node tests/module-panels.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (m.type() === "error" && !/GL Driver|shader/i.test(m.text())) console.log(`[error] ${m.text().slice(0, 160)}`); });
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json, vtk, math"));

// nodes for the panels to show
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
text = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLTextNode", "Notes"); text.SetText("first line")
table = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLTableNode", "Measurements")
for name in ("Angle", "Sine"):
    column = vtk.vtkDoubleArray(); column.SetName(name); table.AddColumn(column)
for i in range(12):
    row = table.AddEmptyRow()
    table.SetCellText(row, 0, str(i * 30.0)); table.SetCellText(row, 1, "%.3f" % math.sin(math.radians(i * 30.0)))
chart = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLPlotChartNode", "Chart")
series = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLPlotSeriesNode", "Sine")
series.SetAndObserveTableNodeID(table.GetID()); series.SetXColumnName("Angle"); series.SetYColumnName("Sine")
chart.AddAndObservePlotSeriesNodeID(series.GetID())
sequence = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSequenceNode", "Frames")
for i in range(5):
    node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "F%d" % i)
    node.AddControlPoint(i * 5.0, 0.0, 0.0)
    sequence.SetDataNodeAtValue(node, str(i))
    slicer.mrmlScene.RemoveNode(node)
browserNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSequenceBrowserNode", "Browser")
browserNode.SetAndObserveMasterSequenceNodeID(sequence.GetID())
roi = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsROINode", "Crop ROI")
roi.SetCenter(0.0, 0.0, -150.0); roi.SetSize(120.0, 120.0, 60.0)
`));
await page.waitForTimeout(1500);

async function openModule(title) {
  if (await page.getByPlaceholder("Search modules").count() === 0) {
    await page.locator("button.h-8.w-full").first().click();
    await page.waitForTimeout(300);
  }
  await page.getByPlaceholder("Search modules").fill(title);
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  const active = await page.evaluate(() => window.slicerWeb.store.activeModule);
  if (active.toLowerCase() !== title.replace(/\s/g, "").toLowerCase()) console.log(`  (asked for ${title}, opened ${active})`);
}
const panelText = async () => (await page.locator(".sw-panel-scroll").last().innerText()).replace(/\s+/g, " ").slice(0, 150);

await openModule("Texts");
console.log("Texts:", await panelText());
await openModule("Colors");
console.log("Colors:", await panelText());
await openModule("Terminologies");
console.log("Terminologies:", await panelText());
await openModule("Tables");
console.log("Tables:", await panelText());
await openModule("Plots");
console.log("Plots:", await panelText());
await openModule("Sequences");
console.log("Sequences:", await panelText());
// play the sequence: the position must advance
await page.locator("[data-name='playButton']").click();
await page.waitForTimeout(1500);
await page.locator("[data-name='playButton']").click();
console.log("sequence item after playing:", await py('slicer.util.getNode("Browser").GetSelectedItemNumber()'));

await openModule("Scene Views");
await page.getByRole("button", { name: "Create scene view" }).click();
await page.waitForTimeout(1200);
console.log("Scene views:", await panelText());

await openModule("Crop Volume");
console.log("Crop Volume:", await panelText());
await page.locator("[data-name='applyCrop']").click();
await page.waitForFunction(() => !/Cropping/.test(document.body.innerText), null, { timeout: 120000 });
await page.waitForTimeout(1500);
console.log("cropped volumes:", await py('json.dumps([n.GetName() + " " + str(n.GetImageData().GetDimensions()) for n in slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode") if n.GetImageData()])'));
if (shot) await page.screenshot({ path: shot });
await browser.close();

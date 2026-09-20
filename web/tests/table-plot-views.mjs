// Table and plot views in the layout: a table is shown as a table and a chart is drawn, as the
// layouts of desktop Slicer show them.
// Usage: node tests/table-plot-views.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

// a table and a chart of two series over it
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import slicer, vtk, math
table = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLTableNode", "Measurements")
for name in ("Angle", "Sine", "Cosine"):
    column = vtk.vtkDoubleArray(); column.SetName(name); table.AddColumn(column)
for i in range(37):
    angle = i * 10.0
    row = table.AddEmptyRow()
    table.SetCellText(row, 0, str(angle))
    table.SetCellText(row, 1, "%.4f" % math.sin(math.radians(angle)))
    table.SetCellText(row, 2, "%.4f" % math.cos(math.radians(angle)))
chart = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLPlotChartNode", "Trigonometry")
chart.SetTitle("Trigonometry"); chart.SetXAxisTitle("Angle (deg)"); chart.SetYAxisTitle("Value")
for name, colour in (("Sine", (1.0, 0.4, 0.2)), ("Cosine", (0.3, 0.7, 1.0))):
    series = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLPlotSeriesNode", name)
    series.SetAndObserveTableNodeID(table.GetID())
    series.SetXColumnName("Angle"); series.SetYColumnName(name)
    series.SetPlotType(series.PlotTypeScatter if name == "Cosine" else series.PlotTypeLine)
    series.SetColor(*colour)
    chart.AddAndObservePlotSeriesNodeID(series.GetID())
`));
await page.waitForTimeout(1000);

// a layout with a table view, then one with a plot view
for (const [layout, name] of [["FourUpTable", "table"], ["Conventional plot", "plot"]]) {
  const applied = await page.evaluate(async (l) => {
    const layouts = window.slicerWeb.store.availableLayouts;
    const key = Object.keys(layouts).find((k) => k.toLowerCase() === l.replace(/\s/g, "").toLowerCase())
      ?? Object.keys(layouts).find((k) => /table/i.test(k) === /table/i.test(l) && /plot/i.test(k) === /plot/i.test(l));
    if (!key) return null;
    await window.slicerWeb.bridge.call("setLayout", [key]);
    return key;
  }, layout);
  await page.waitForTimeout(2500);
  const cells = await page.evaluate((k) => {
    const found = [];
    const walk = (n) => { if (n.type === "view") found.push({ name: n.layoutName, kind: n.kind }); (n.children ?? []).forEach(walk); };
    walk(window.slicerWeb.store.layout.description);
    return found;
  }, name);
  console.log(`  layout cells: ${JSON.stringify(cells)}`);
  const view = page.locator(`[data-name='${name}View']`).first();
  const present = await view.count();
  console.log(`layout ${applied}: ${name} view present: ${present > 0}`);
  if (!present) continue;
  if (name === "table") {
    const header = await view.locator("thead th").allInnerTexts();
    const firstRow = await view.locator("tbody tr").first().locator("td").allInnerTexts();
    console.log(`  columns: ${header.join(", ")}; first row: ${firstRow.join(", ")}`);
  } else {
    console.log("  plot view shows: " + (await view.innerText()).replace(/\s+/g, " ").slice(0, 120));
    const series = await view.locator("[data-name^='series:']").count();
    const points = await view.locator("[data-name^='series:'] circle").count();
    const title = await view.locator("svg text").first().textContent();
    console.log(`  chart "${title}": ${series} series, ${points} points drawn`);
  }
}
if (shot) await page.screenshot({ path: shot });
await browser.close();

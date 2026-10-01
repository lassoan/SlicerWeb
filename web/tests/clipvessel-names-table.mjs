// Clip Vessel (SlicerVMTK): the table of clip point names lists the clip points, renaming a vessel
// by typing into its cell renames the clip point, and clicking a row makes that point the active
// one. The table is a QTableWidget of editable items (QTableWidgetItem flags, cellChanged).
// Usage: node tests/clipvessel-names-table.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  const t = m.text();
  if ((m.type() === "error" && !/GL Driver|Feedback loop|shader|vtkOpenGL/i.test(t)) || /Traceback|Error in slot/.test(t)) errors.push(t.slice(0, 400));
});
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);

await page.goto(base + "?sample=&extensions=SlicerVMTK");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "ClipVessel"), null, { timeout: 120000 });
await page.evaluate(() => { window.slicerWeb.store.activeModule = "ClipVessel"; });
await page.waitForTimeout(3000);
await exec(`
w = slicer.util.getModuleWidget("ClipVessel")
points = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "Clip points")
for i, name in enumerate(["Outlet 1", "Outlet 2", "Outlet 3"]):
    points.AddControlPoint([10.0 * i, 0, 0], name)
w.ui.clipPointsMarkupsSelector.setCurrentNode(points)
`);
await page.waitForTimeout(2000);

const panel = page.locator(".sw-panel-scroll").last();
// the table is in Advanced > Vessel names, both collapsed at first
for (const section of ["Advanced", "Vessel names"]) {
  await panel.getByText(new RegExp(String.raw`^\W*${section}$`)).first().click();
  await page.waitForTimeout(800);
}
const fields = panel.locator("input[data-cell-edit]");
check("a row per clip point (names)", await fields.count(), 3);
check("names in the cells", JSON.stringify(await fields.evaluateAll((f) => f.map((x) => x.value))), '["Outlet 1","Outlet 2","Outlet 3"]');
check("the point column is not editable", await py(`int(w.ui.clipPointNamesTable.item(0, 0).flags() & qt.Qt.ItemIsEditable)`), "0");

// renamed by typing into the cell, as a user does
await fields.nth(1).click();
await fields.nth(1).fill("Left pulmonary artery");
await fields.nth(1).press("Enter");
await page.waitForTimeout(1500);
check("typing renames the clip point", await py(`points.GetNthControlPointLabel(1)`), "Left pulmonary artery");

// Escape puts the name back
await fields.nth(2).click();
await fields.nth(2).fill("typo");
await fields.nth(2).press("Escape");
await page.waitForTimeout(1000);
check("Escape keeps the name", await py(`points.GetNthControlPointLabel(2)`), "Outlet 3");
check("and shows it again", await fields.nth(2).inputValue(), "Outlet 3");

// renamed in the scene: the table follows
await exec(`points.SetNthControlPointLabel(0, "Aorta")`);
await page.waitForTimeout(1500);
check("a point renamed elsewhere is renamed in the table", await panel.locator("input[data-cell-edit]").first().inputValue(), "Aorta");

// a click on the point number of a row makes that point the active one
const numbers = panel.locator("td span", { hasText: /^3$/ });
await numbers.first().click();
await page.waitForTimeout(1500);
check("clicking a row selects it", await py(`str(sorted({i.row() for i in w.ui.clipPointNamesTable.selectedIndexes()}))`), "[2]");
check("and makes its point the active one", await py(`str(points.GetDisplayNode().GetActiveControlPoint())`), "2");

check("errors", errors.length ? errors.join("\n") : "none", "none");
await browser.close();
process.exit(failures ? 1 : 0);

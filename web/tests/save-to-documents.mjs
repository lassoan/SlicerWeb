// A file a module saves where the user said, in a path box meant for writing (ctkPathLineEdit with
// the Writable filter): Browse asks for a name, the file goes into the application's Documents
// folder, and what the module writes there is saved to the user's downloads - Baffle Planner's
// flattened baffle image, here (flattened without Flatten, which the browser cannot run). A name cannot lead out of that folder, and with the application
// setting (General) off, nothing is offered.
// Usage: node tests/save-to-documents.mjs [url]
import fs from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const downloads = [];
page.on("download", (d) => downloads.push(d));
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
// what the prompt of Browse is answered with
let answer = "";
page.on("dialog", (d) => d.accept(answer));

await page.goto(base + "?sample=&extensions=SlicerHeart");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "BafflePlanner"), null, { timeout: 120000 });
await page.evaluate(() => { window.slicerWeb.store.activeModule = "BafflePlanner"; });
await page.waitForTimeout(4000);
const panel = page.locator(".sw-panel-scroll").last();

// a closed curve, and the baffle and flattened models created in their selectors
await exec(`
import math
w = slicer.modules.BafflePlannerWidget
curve = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsClosedCurveNode", "Contour")
curve.CreateDefaultDisplayNodes()
for i in range(12):
    a = 2 * math.pi * i / 12
    curve.AddControlPoint([30 * math.cos(a), 20 * math.sin(a), 5 * math.sin(2 * a)])
w.ui.inputCurveSelector.setCurrentNode(curve)
`);
await page.waitForTimeout(1000);
await panel.locator("[data-name=outputBaffleModelSelector] select").selectOption("__create__");
await page.waitForTimeout(1000);
await panel.locator("[data-name=flattenedModelSelector] select").selectOption("__create__");
await page.waitForTimeout(1000);
await exec(`w.logic.updateOutputBaffleModel()`);
// Flatten runs the lscm program (Conformal Texture Mapping), which is not built for the browser, so
// the flattened baffle is made here instead: a flat disk, with two flattened fixed points on it
await exec(`
import vtk
disk = vtk.vtkDiskSource()
disk.SetInnerRadius(0)
disk.SetOuterRadius(25)
disk.SetCircumferentialResolution(48)
triangles = vtk.vtkTriangleFilter()
triangles.SetInputConnection(disk.GetOutputPort())
triangles.Update()
w.ui.flattenedModelSelector.currentNode().SetAndObservePolyData(triangles.GetOutput())
points = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "Flattened fixed points")
points.AddControlPoint([-10, 0, 0])
points.AddControlPoint([10, 0, 0])
w.logic.setOutputFlattenedFixedPointsNode(points)
`);
await page.waitForTimeout(1000);
check("there is a flattened baffle", await py("(lambda n: n.GetPolyData().GetNumberOfPoints() if n and n.GetPolyData() else 0)(w.ui.flattenedModelSelector.currentNode())"), (n) => Number(n) > 0);

// the flattened image file: a path box for writing
const pathBox = panel.locator("[data-name=flattenedBaffleImageFilePathLineEdit]");
check("the path box is one for writing", await py("w.ui.flattenedBaffleImageFilePathLineEdit.saveMode"), "True");
answer = "../../etc/baffle";
await pathBox.locator("[data-name=browse]").click();
await page.waitForTimeout(500);
check("Browse puts the named file into Documents, whatever the name says",
  await py("w.ui.flattenedBaffleImageFilePathLineEdit.currentPath"), "/home/pyodide/Documents/baffle.png");
check("the box shows only the file name", await pathBox.locator("[data-name=currentPath]").inputValue(), "baffle.png");

const download = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
await panel.getByRole("button", { name: "Save", exact: true }).click();
const saved = await download;
check("Save puts the image into the downloads", saved ? saved.suggestedFilename() : null, "baffle.png");
if (saved) {
  const bytes = fs.readFileSync(await saved.path());
  check("a PNG image", bytes.toString("latin1", 1, 4), "PNG");
}

// typed into the box: still in Documents
await pathBox.locator("[data-name=currentPath]").fill("/data/somewhere/else.png");
await pathBox.locator("[data-name=currentPath]").press("Enter");
await page.waitForTimeout(300);
check("a typed path stays in Documents too", await py("w.ui.flattenedBaffleImageFilePathLineEdit.currentPath"), "/home/pyodide/Documents/else.png");

// the application setting off: nothing is offered
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("slicerweb.settings") ?? "{}");
  localStorage.setItem("slicerweb.settings", JSON.stringify({ ...s, "General/SaveWrittenFilesToDownloads": false }));
});
const before = downloads.length;
await exec(`open("/home/pyodide/Documents/notes.txt", "w").write("not offered")`);
await page.waitForTimeout(2500);
check("with the setting off, nothing is offered", downloads.length - before, 0);

check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

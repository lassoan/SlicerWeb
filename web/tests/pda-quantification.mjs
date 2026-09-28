// PDA Quantification (SlicerHeart, with SlicerVMTK) on a synthetic vessel tree: aorta and pulmonary
// artery joined by a PDA. The inputs are picked in the module's GUI, then Apply (branch extraction
// from both ends, stitched at the PDA), the anatomy type, and Calculate, as a user would.
// Usage: node tests/pda-quantification.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
let errors = 0;
page.on("pageerror", (e) => { errors++; console.log(`${stamp()} [pageerror] ${e}`); });
page.on("console", (m) => {
  const t = m.text();
  if (m.type() !== "error" || /GL Driver|Feedback loop|shader|vtkShaderProgram|vtkOpenGL/i.test(t)) return;
  // What desktop Slicer logs as well: the module deserializes the terminology of every centerline
  // curve to find the PDA, and those that have only a category (no type) are reported as invalid;
  // and the PDA model's display pipeline fails once while Calculate sets up its scalars
  if (/DeserializeTerminologyEntry: Invalid type component|vtkSlicerTerminologiesModuleLogic.cxx, line 2113$/.test(t)) return;
  if (/vtkAssignAttribute.*Data must be point or cell|Algorithm vtkAssignAttribute .* returned failure/s.test(t)) return;
  errors++;
  console.log(`${stamp()} [error] ${t}`);
});
let failures = 0;
const check = (what, value, expected) => {
  const ok = typeof expected === "function" ? expected(value) : String(value) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${value}`);
};

// a module's QPushButton is an element named after it with the <button> inside, which gets the click
await page.addInitScript(() => {
  window.clickButton = (name) => {
    const host = document.querySelector(`[data-name=${name}]`);
    (host.querySelector("button") ?? host).click();
  };
});
await page.goto(base + "?sample=&extensions=SlicerHeart,SlicerVMTK");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "PDAQuantification"), null, { timeout: 120000 });
await page.evaluate(() => {
  window.__logs = [];
  window.slicerWeb.bridge.events.on("log", (e) => {
    window.__logs.push(e);
    if (/error|critical/i.test(e.level ?? "")) console.error(`[log ${e.level}] ${e.message}`);
  });
});
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const pyYielding = (code) => page.evaluate((c) => window.slicerWeb.bridge.callYielding("evalPython", [c]), code);

// ---- the vessels: a labelmap of three tubes, and the points the module asks for
await exec(`
import numpy as np, slicer, vtk
spacing = 1.0
origin = np.array([-15.0, -15.0, -10.0])
shape = (int(100 / spacing), int(30 / spacing), int(70 / spacing))  # x, y, z
ijk = np.stack(np.meshgrid(*[np.arange(n) for n in shape], indexing="ij"), -1).astype(float)
ras = origin + ijk * spacing
def tube(a, b, r):
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    t = np.clip(((ras - a) @ d) / (d @ d), 0, 1)
    return np.linalg.norm(ras - (a + t[..., None] * d), axis=-1) <= r
mask = tube([0, 0, -5], [0, 0, 55], 6) | tube([60, 0, -5], [60, 0, 55], 5) | tube([0, 0, 25], [60, 0, 25], 3)
labelmap = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLabelMapVolumeNode", "vessels-label")
labelmap.SetOrigin(*origin)
labelmap.SetSpacing(spacing, spacing, spacing)
slicer.util.updateVolumeFromArray(labelmap, mask.transpose(2, 1, 0).astype(np.uint8))
segmentation = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Vessels")
slicer.modules.segmentations.logic().ImportLabelmapToSegmentationNode(labelmap, segmentation)
segmentation.CreateClosedSurfaceRepresentation()
slicer.mrmlScene.RemoveNode(labelmap)
endpoints = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "Endpoints")
for p in ([0, 0, -4], [0, 0, 54], [60, 0, -4], [60, 0, 54]):
    endpoints.AddControlPoint(p)
# the two the extraction starts from are the unselected ones
endpoints.SetNthControlPointSelected(1, False)
endpoints.SetNthControlPointSelected(3, False)
indicator = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "PDA")
indicator.AddControlPoint([30, 0, 25])
`);
check("segment has a closed surface", await py(`segmentation.GetClosedSurfaceInternalRepresentation(segmentation.GetSegmentation().GetNthSegmentID(0)).GetNumberOfPoints() > 0`), "True");

// ---- open the module and pick the inputs in its GUI
await page.evaluate(() => { window.slicerWeb.store.activeModule = "PDAQuantification"; });
await page.waitForTimeout(3000);
check("no error above the module GUI", await page.locator("[data-name=moduleError]").count(), 0);
await exec(`
w = slicer.util.getModuleWidget("PDAQuantification")
w.ui.inputSegmentSelector.setCurrentNode(segmentation)
w.ui.inputSegmentSelector.setCurrentSegmentID(segmentation.GetSegmentation().GetNthSegmentID(0))
w.ui.inputEndpointsNodeComboBox.setCurrentNode(endpoints)
w.ui.inputPDAIndicatorFiducialNodeComboBox.setCurrentNode(indicator)
`);
const p = "w._parameterNode";
check("input segmentation in the parameter node", await py(`${p}.GetNodeReference(w.logic.parameterNodeRef_InputSegmentationNode).GetName()`), "Vessels");
check("endpoints in the parameter node", await py(`${p}.GetNodeReference(w.logic.parameterNodeRef_InputEndpointsFiducials).GetName()`), "Endpoints");
check("PDA indicator in the parameter node", await py(`${p}.GetNodeReference(w.logic.parameterNodeRef_InputPDAIndicatorFiducial).GetName()`), "PDA");
check("output centerline curve made", await py(`bool(${p}.GetNodeReference(w.logic.parameterNodeRef_OutputCenterlineCurve))`), "True");

// ---- Apply: branch extraction
// the extraction runs in the page, which does not answer until it is done: click without waiting
// for the click to return, then wait for the curves
await exec(`import time; _applyStart = time.time()`);
await page.evaluate(() => setTimeout(() => clickButton("applyButton"), 0));
await page.waitForTimeout(1000);
await page.waitForFunction(async () => String(await window.slicerWeb.bridge.evalPython("bool(w._parameterNode.GetNodeReference(w.logic.parameterNodeRef_PDACurve))", "eval")) === "True", null, { timeout: 600000, polling: 2000 }).catch((e) => console.log(`${stamp()} ${e}`));
console.log(`${stamp()} Apply took ${await py("round(time.time() - _applyStart, 1)")} s`);
const curves = await py(`[n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLMarkupsCurveNode")]`);
console.log(`${stamp()} curves: ${curves}`);
check("centerline curves extracted", await py(`len(slicer.util.getNodesByClass("vtkMRMLMarkupsCurveNode")) > 3`), "True");
check("the PDA curve is found", await py(`bool(${p}.GetNodeReference(w.logic.parameterNodeRef_PDACurve))`), "True");

// ---- anatomy type (the list of pictures), chosen after Apply as the panel lays them out; the PDA
// found by Apply gets its terminology then
await exec(`w.ui.anatomyListWidget.setCurrentRow(3)`);  // Other
check("anatomy type", await py(`${p}.GetParameter(w.logic.parameter_AnatomyTypeID)`), "Other");
check("the PDA curve is identified", await py(`bool(w.logic.getCurveNodeByCodeValue(${p}, w.logic.pdaCodeValue))`), "True");
await exec(`
sh = slicer.mrmlScene.GetSubjectHierarchyNode()
items = vtk.vtkIdList()
sh.GetItemChildren(sh.GetSceneItemID(), items, True)
curveFolders = [items.GetId(k) for k in range(items.GetNumberOfIds()) if sh.GetItemName(items.GetId(k)) == "Centerline curves"]
`);
check("one folder of centerline curves, as in desktop Slicer", await py(`len(curveFolders)`), "1");

// ---- Calculate
await page.evaluate(() => setTimeout(() => clickButton("calculateButton"), 0));
await page.waitForTimeout(1000);
await page.waitForFunction(async () => /\d/.test(String(await window.slicerWeb.bridge.evalPython("w.ui.measurementsLabel.text", "eval"))), null, { timeout: 300000, polling: 2000 }).catch((e) => console.log(`${stamp()} ${e}`));
const measurements = await py(`w.ui.measurementsLabel.text`);
console.log(`${stamp()} measurements:\n${measurements}`);
check("measurements calculated", /\d/.test(measurements), true);
check("PDA model made", await py(`(lambda m: m.GetPolyData().GetNumberOfPoints() if m and m.GetPolyData() else 0)(${p}.GetNodeReference(w.logic.parameterNodeRef_OutputPDAModel))`), (v) => Number(v) > 0);

if (shot) await page.screenshot({ path: shot });
check("no errors", errors, 0);
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

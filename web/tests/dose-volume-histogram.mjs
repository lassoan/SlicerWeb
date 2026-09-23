// The Dose Volume Histogram module (SlicerRT): a dose volume and a segmentation are chosen, the
// DVHs computed - the logic brings a plot layout and draws them - and the metrics table filled;
// V and D metrics are added on request; a DVH is taken out of the chart and put back; the DVH
// values and the metrics are exported.
// Usage: node tests/dose-volume-histogram.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);

await page.goto(base + "?sample=");
await page.evaluate(() => localStorage.removeItem("slicerweb.extensions"));
await page.goto(base + "?sample=&extensions=SlicerRT");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => (window.slicerWeb?.store?.modules ?? []).some((m) => m.name === "DoseVolumeHistogram"), null, { timeout: 120000 });
await page.evaluate(() => { window.__errors = []; window.slicerWeb.bridge.events.on("log", (e) => { if (/error/i.test(e.level)) window.__errors.push(String(e.message).slice(-400)); }); });

// A dose that rises along the patient axis, and two spheres in it: one low in the dose, one high
await exec(`
import numpy as np, vtk, slicer
dose = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "Dose")
values = np.zeros((40, 40, 40), dtype=np.float32)
values[:] = np.linspace(0.0, 60.0, 40)[:, None, None]
slicer.util.updateVolumeFromArray(dose, values)
dose.SetSpacing(2.0, 2.0, 2.0)
dose.SetAttribute("DicomRtImport.DoseVolume", "1")
dose.SetAttribute("DicomRtImport.DoseUnitName", "Gy")
dose.CreateDefaultDisplayNodes()
structures = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Structures")
structures.CreateDefaultDisplayNodes()
structures.SetReferenceImageGeometryParameterFromVolumeNode(dose)
# Surfaces are the source, as of a structure set from DICOM-RT (the logic makes the labelmaps)
structures.GetSegmentation().SetSourceRepresentationName("Closed surface")
for name, center, color in (("Target", (40, 40, 60), (1.0, 0.0, 0.0)), ("Organ", (40, 40, 20), (0.0, 0.8, 0.0))):
    sphere = vtk.vtkSphereSource(); sphere.SetCenter(*center); sphere.SetRadius(12.0); sphere.SetPhiResolution(24); sphere.SetThetaResolution(24); sphere.Update()
    structures.AddSegmentFromClosedSurfaceRepresentation(sphere.GetOutput(), name, color)
`);
await page.evaluate(() => { window.slicerWeb.store.activeModule = "DoseVolumeHistogram"; });
await page.waitForTimeout(3000);
const panel = page.locator(".sw-panel-scroll").last();
check("the parameter node is made", await py('slicer.mrmlScene.GetNumberOfNodesByClass("vtkMRMLDoseVolumeHistogramNode")'), "1");

await panel.locator("select[data-name=dvhDoseVolume]").selectOption({ label: "Dose" });
await page.waitForTimeout(800);
await panel.locator("select[data-name=dvhSegmentation]").selectOption({ label: "Structures" });
await page.waitForTimeout(800);
check("the segments are listed", await panel.locator("[data-name=dvhSegment]").count(), 2);
check("the dose volume is known as one", await panel.getByText("Selected volume is not a dose").count(), 0);

await panel.locator("[data-name=dvhCompute]").click();
await page.waitForFunction(() => document.querySelector("[data-name=dvhMetrics]"), null, { timeout: 120000 });
await page.waitForTimeout(1500);
const rows = panel.locator("[data-name=dvhMetrics] tbody tr");
check("a metrics row per structure", await rows.count(), 2);
const header = (await panel.locator("[data-name=dvhMetrics] th").allInnerTexts()).map((t) => t.trim());
console.log("     columns:", header.join(" | "));
check("with volume, mean, min and max dose", /Volume/.test(header.join()) && /Mean/.test(header.join()) && /Max/.test(header.join()), true);
const targetRow = (await rows.allInnerTexts()).find((t) => /Target/.test(t)) ?? "";
const organRow = (await rows.allInnerTexts()).find((t) => /Organ/.test(t)) ?? "";
console.log("     Target:", targetRow.replace(/\s+/g, " "));
console.log("     Organ:", organRow.replace(/\s+/g, " "));
const meanOf = (row) => parseFloat(row.split(/\t|\n/).map((t) => t.trim()).filter(Boolean)[3]);
check("the target, high in the dose, has the higher mean dose", meanOf(targetRow) > meanOf(organRow) + 20, true);
check("the layout is a quantitative one, with the plot view", await py('slicer.app.layoutManager().layout() in (slicer.vtkMRMLLayoutNode.SlicerLayoutFourUpPlotView, slicer.vtkMRMLLayoutNode.SlicerLayoutOneUpPlotView)'), "True");
check("both DVHs are in the chart", await py('slicer.util.getNode("vtkMRMLDoseVolumeHistogramNode1").GetChartNode().GetNumberOfPlotSeriesNodes()'), "2");
check("which the plot view shows", await py('slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLPlotViewNode").GetPlotChartNodeID() == slicer.util.getNode("vtkMRMLDoseVolumeHistogramNode1").GetChartNode().GetID()'), "True");
if (shot) await page.screenshot({ path: shot });

// V metrics: in cc, for two doses
await panel.getByText("Advanced options").click();
await page.waitForTimeout(300);
await panel.locator("[data-name=dvhVCc] input[type=checkbox], input[data-name=dvhVCc]").first().click();
await page.waitForTimeout(500);
const vDose = panel.locator("[data-name=dvhVDose]");
await vDose.fill("10,50");
await vDose.press("Enter");
await page.waitForTimeout(1500);
const columns = (await panel.locator("[data-name=dvhMetrics] th").allInnerTexts()).map((t) => t.trim());
check("V metrics columns are added for the doses asked", columns.some((c) => /^V10/.test(c)) && columns.some((c) => /^V50/.test(c)), true);

// Show and hide
await rows.nth(0).locator("input[type=checkbox]").click();
await page.waitForTimeout(800);
check("unticking a DVH takes it out of the chart", await py('slicer.util.getNode("vtkMRMLDoseVolumeHistogramNode1").GetChartNode().GetNumberOfPlotSeriesNodes()'), "1");
await panel.getByRole("button", { name: "Show all" }).click();
await page.waitForTimeout(800);
check("Show all puts them all back", await py('slicer.util.getNode("vtkMRMLDoseVolumeHistogramNode1").GetChartNode().GetNumberOfPlotSeriesNodes()'), "2");
await panel.getByRole("button", { name: "Hide all" }).click();
await page.waitForTimeout(800);
check("Hide all empties the chart", await py('slicer.util.getNode("vtkMRMLDoseVolumeHistogramNode1").GetChartNode().GetNumberOfPlotSeriesNodes()'), "0");

// Export
const dvhPath = await page.evaluate(() => window.slicerWeb.bridge.call("exportDoseVolumeHistogram", ["vtkMRMLDoseVolumeHistogramNode1", "dvh", true]));
const metricsPath = await page.evaluate(() => window.slicerWeb.bridge.call("exportDoseVolumeHistogram", ["vtkMRMLDoseVolumeHistogramNode1", "metrics", true]));
check("the DVH values are exported", await py(`open("${dvhPath}").read().count(",") > 10`), "True");
check("and the metrics", await py(`"Target" in open("${metricsPath}").read()`), "True");

const errors = await page.evaluate(() => window.__errors);
check("all without an error", errors.length, 0);
for (const e of errors.slice(0, 3)) console.log("---\n" + e);
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

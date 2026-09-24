// The Segmentations module beyond its segment list: the source geometry, the display settings of
// the segmentation and of one segment, the views it is shown in, copying and moving segments to
// another segmentation, exporting to a labelmap and to models and importing back, exporting to
// files, and the binary labelmap layers - what the desktop module offers.
// Usage: node tests/segmentations-module.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("dialog", (d) => { console.log(`[dialog] ${d.message().split("\n")[0]}`); d.accept(); });
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);
const call = (method, ...args) => page.evaluate(([m, a]) => window.slicerWeb.bridge.call(m, a), [method, args]);
const seg = (name, what) => py(`(lambda n: ${what})(slicer.util.getNode("${name}"))`);
const names = (name) => seg(name, "[n.GetSegmentation().GetNthSegment(i).GetName() for i in range(n.GetSegmentation().GetNumberOfSegments())]");

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(2000);
// Two spheres in a segmentation whose source is the binary labelmap, as painted segments are
await exec(`
import vtk, slicer
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Segmentation")
seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(slicer.util.getNode("MR-head"))
seg.GetSegmentation().SetSourceRepresentationName("Closed surface")
for name, c in (("Sphere A", (0, 0, 0)), ("Sphere B", (40, 0, 0))):
    s = vtk.vtkSphereSource(); s.SetCenter(*c); s.SetRadius(15.0); s.Update()
    seg.AddSegmentFromClosedSurfaceRepresentation(s.GetOutput(), name)
seg.GetSegmentation().CreateRepresentation("Binary labelmap", True)
seg.GetSegmentation().SetSourceRepresentationName("Binary labelmap")
other = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Other")
other.CreateDefaultDisplayNodes()
`);
await page.evaluate(() => { window.slicerWeb.store.selectedNodeID = "vtkMRMLSegmentationNode1"; window.slicerWeb.store.activeModule = "Segmentations"; });
await page.waitForTimeout(3000);
const panel = page.locator(".sw-panel-scroll").last();
const section = (name) => panel.locator(`[data-name=${name}]`);
const rows = panel.locator("[data-name=segmentList]").first().locator("[data-name=segmentRow]");
check("the module opens on the segmentation", await panel.locator("select.sw-node-selector").first().evaluate((el) => el.options[el.selectedIndex]?.text), "Segmentation");
check("it says what the geometry came from", (await section("sourceGeometry").innerText()).trim(), "Source geometry: MR-head");
check("and lists the segments", await rows.count(), 2);

// ---- display
const displayNode = 'slicer.util.getNode("Segmentation").GetDisplayNode()';
await section("overallOpacity").locator("input[type=range]").first().fill("0.5");
await page.waitForTimeout(500);
check("the overall opacity reaches the display node", await py(`${displayNode}.GetOpacity()`), "0.5");
await panel.getByText("Advanced", { exact: true }).first().click();
await page.waitForTimeout(400);
const thickness = section("sliceIntersectionThickness").locator("input").first();
await thickness.fill("3");
await thickness.press("Enter");
await page.waitForTimeout(500);
check("and the slice intersection thickness", await py(`${displayNode}.GetSliceIntersectionThickness()`), "3");
const viewBoxes = section("displayViews").locator("label");
const viewCount = await viewBoxes.count();
check("the views it can be shown in are listed, all of them to begin with", viewCount > 2 && (await py(`${displayNode}.GetNumberOfViewNodeIDs()`)) === "0", true);
await viewBoxes.nth(1).locator("input").click();   // the first view after "All"
await page.waitForTimeout(500);
check("unticking a view names the others on the display node", await py(`${displayNode}.GetNumberOfViewNodeIDs()`), String(viewCount - 2));
await viewBoxes.nth(0).locator("input").click();   // All again
await page.waitForTimeout(500);
check("and All takes the naming away", await py(`${displayNode}.GetNumberOfViewNodeIDs()`), "0");
await rows.nth(0).click();
await page.waitForTimeout(500);
const selected = section("selectedSegmentDisplay");
check("choosing a segment shows its own display settings", await selected.count(), 1);
await selected.locator("input[type=range]").nth(2).fill("0.25");   // 3D opacity of the segment
await page.waitForTimeout(500);
check("which reach the display node for that segment", await py(`${displayNode}.GetSegmentOpacity3D(slicer.util.getNode("Segmentation").GetSegmentation().GetNthSegmentID(0))`), "0.25");

// ---- copy and move
await panel.getByText("Copy/move segments").click();
await page.waitForTimeout(400);
const copySection = section("copyMoveSection");
await copySection.locator("select[data-name=otherSegmentation]").selectOption({ label: "Other" });
await page.waitForTimeout(800);
const buttons = copySection.locator("[data-name=copyMoveButtons] button");
await copySection.locator("[data-name=segmentList]").first().locator("[data-name=segmentRow]").nth(1).click();   // Sphere B
await page.waitForTimeout(300);
await buttons.nth(1).click();   // Copy +>
await page.waitForTimeout(1000);
check("Copy +> copies the chosen segment to the other segmentation", await names("Other"), "['Sphere B']");
check("and leaves it here", await names("Segmentation"), "['Sphere A', 'Sphere B']");
await buttons.nth(0).click();   // Move >
await page.waitForTimeout(1000);
check("Move > takes it over", await names("Segmentation") + " | " + await names("Other"), "['Sphere A'] | ['Sphere B', 'Sphere B']");
await copySection.locator("[data-name=otherSegments] [data-name=segmentRow]").nth(0).click();
await page.waitForTimeout(300);
await buttons.nth(3).click();   // < Move
await page.waitForTimeout(1000);
check("< Move brings one back", await names("Segmentation") + " | " + await names("Other"), "['Sphere A', 'Sphere B'] | ['Sphere B']");

// ---- export and import
await panel.getByText("Export/import models and labelmaps").click();
await page.waitForTimeout(400);
const ie = section("importExportSection");
await ie.locator("[data-name=importExportApply]").click();   // export all to a new labelmap
await page.waitForTimeout(2000);
check("Export makes a labelmap of the segments", await py('[n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLLabelMapVolumeNode")]'), "['Segmentation-label']");
check("with their voxels", Number(await py('int(slicer.util.arrayFromVolume(slicer.util.getNode("Segmentation-label")).max())')), 2);
check("and says so", /Exported to Segmentation-label/.test(await ie.locator("[data-name=importExportMessage]").innerText()), true);
await ie.locator("select[data-name=exportType]").selectOption({ label: "Models" });
await page.waitForTimeout(300);
await ie.locator("[data-name=importExportApply]").click();
await page.waitForTimeout(3000);
check("Export to models makes a model per segment in a folder", await py('sorted(n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLModelNode") if not n.GetHideFromEditors())'), "['Sphere A', 'Sphere B']");
await ie.locator("select[data-name=importExportOperation]").selectOption({ label: "Import" });
await page.waitForTimeout(400);
const sourceSelect = ie.locator("select[data-name=importSource]");
const sourceLabels = await sourceSelect.locator("option").allInnerTexts();
check("Import offers the labelmap, the models and their folder", sourceLabels.some((l) => /Segmentation-label \(labelmap\)/.test(l)) && sourceLabels.some((l) => /Sphere A \(model\)/.test(l)) && sourceLabels.some((l) => /folder\)/.test(l)), true);
await sourceSelect.selectOption({ label: sourceLabels.find((l) => /Segmentation-label/.test(l)) });
await page.waitForTimeout(300);
await ie.locator("[data-name=importExportApply]").click();
await page.waitForTimeout(3000);
// the labelmap carries the segment names in its colour table, so the imported segments have them too
check("importing the labelmap adds its labels as segments", await names("Segmentation"), "['Sphere A', 'Sphere B', 'Sphere A', 'Sphere B']");

// ---- export to files
const made = await call("exportSegmentationToFiles", "vtkMRMLSegmentationNode1", { format: "STL", visibleOnly: false, merge: false, sizeScale: 1, lps: true });
console.log("     STL export:", JSON.stringify(made));
// (segments of one name share a file, as on the desktop: the two imported ones are named as the first two)
check("exporting to STL files writes one per segment name, zipped for the download", made.files.length === 2 && made.files.every((f) => /\.stl$/i.test(f)) && /\.zip$/.test(made.path), true);
check("which is there", await py(`__import__("os").path.getsize("${made.path}") > 1000`), "True");
const merged = await call("exportSegmentationToFiles", "vtkMRMLSegmentationNode1", { format: "STL", merge: true, sizeScale: 1, lps: true });
check("merged into one file it is the file itself", merged.files.length === 1 && /\.stl$/i.test(merged.path), true);
const nrrd = await call("exportSegmentationToFiles", "vtkMRMLSegmentationNode1", { format: "NRRD", compression: true });
console.log("     NRRD export:", JSON.stringify(nrrd));
check("and a NRRD labelmap is written as well, with the labels beside it", nrrd.files.some((f) => /\.nrrd$/.test(f)) && nrrd.files.some((f) => /labels\.csv$/.test(f)), true);

// ---- layers
await panel.getByText("Binary labelmap layers").click();
await page.waitForTimeout(400);
const layers = section("layersSection");
console.log("     segments:", (await layers.locator("[data-name=segmentCount]").innerText()).trim(), "layers:", (await layers.locator("[data-name=layerCount]").innerText()).trim());
check("the layers are counted", Number((await layers.locator("[data-name=layerCount]").innerText()).trim()) >= 1, true);
await layers.locator("[data-name=forceSingleLayer] input, input[data-name=forceSingleLayer]").first().click();
await layers.locator("[data-name=collapseLayers]").click();
await page.waitForTimeout(1500);
check("collapsing to a single layer leaves one", (await layers.locator("[data-name=layerCount]").innerText()).trim(), "1");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

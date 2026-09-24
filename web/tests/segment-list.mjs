// The segment list the Segmentations module shares with the Segment Editor: Add makes a segment
// and chooses it, a click chooses one, a double-click on the name renames it, the eye hides it,
// Remove takes the chosen one away - and the editor's list shows the same segments.
// Usage: node tests/segment-list.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const names = () => py('[slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNthSegment(i).GetName() for i in range(slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNumberOfSegments())]');

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(2000);
await page.evaluate(() => window.slicerWeb.bridge.evalPython('slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Segmentation").CreateDefaultDisplayNodes()', "exec"));
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Segmentations"; });
await page.waitForTimeout(3000);
const panel = page.locator(".sw-panel-scroll").last();
const rows = panel.locator("[data-name=segmentList]").first().locator("[data-name=segmentRow]");

await panel.locator("[data-name=addSegment]").click();
await page.waitForTimeout(800);
await panel.locator("[data-name=addSegment]").click();
await page.waitForTimeout(800);
check("Add makes segments", await rows.count(), 2);
check("and chooses the new one", await rows.nth(1).evaluate((el) => el.className.includes("bg-accent")), true);

await rows.nth(0).click();
await page.waitForTimeout(300);
check("a click chooses a segment", await rows.nth(0).evaluate((el) => el.className.includes("bg-accent")), true);

await rows.nth(0).locator("[data-name=segmentName]").dblclick();
await page.waitForTimeout(300);
const input = rows.nth(0).locator("[data-name=segmentNameInput]");
check("a double-click on the name opens it for editing", await input.count(), 1);
await input.fill("Tumor");
await input.press("Enter");
await page.waitForTimeout(800);
check("and Enter renames it", await names(), "['Tumor', 'Segment_2']");

await rows.nth(1).locator("[data-name=segmentVisible]").click();
await page.waitForTimeout(600);
check("the eye hides a segment", await py('str(bool(slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetDisplayNode().GetSegmentVisibility(slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNthSegmentID(1))))'), "False");

// the ... button holds what else can be done: the terminology, renaming, deleting
await panel.locator("[data-name=addSegment]").click();
await page.waitForTimeout(800);
await rows.nth(2).locator("[data-name=segmentMore]").click();
await page.waitForTimeout(300);
const menu = page.locator("[role=menu]");
check("the ... button opens a menu with the terminology, renaming, the slices, the status, clearing and deleting", (await menu.locator("[role=menuitem]").allInnerTexts()).map((t) => t.trim()).join(", "), "What is it…, Rename, Jump slices, Not started, In progress, Completed, Flagged, Clear, Delete");
await menu.locator("[data-name=segmentRename]").click();
await page.waitForTimeout(300);
const renameBox = rows.nth(2).locator("[data-name=segmentNameInput]");
check("Rename opens the name for editing", await renameBox.count(), 1);
await renameBox.fill("Vessel");
await renameBox.press("Enter");
await page.waitForTimeout(600);
await rows.nth(2).locator("[data-name=segmentMore]").click();
await page.waitForTimeout(300);
await page.locator("[role=menu] [data-name=segmentRemove]").click();
await page.waitForTimeout(800);
check("Delete in the menu takes the segment away", await names(), "['Tumor', 'Segment_2']");
check("the eye is always there, on the right", await rows.nth(0).locator("[data-name=segmentVisible]").isVisible(), true);

// the status icon steps the status as on the desktop: not started, in progress, completed, flagged, then back to completed
const statusOf = () => rows.nth(0).locator("[data-name=segmentStatus]").getAttribute("data-status");
check("a segment starts as not started", await statusOf(), "0");
const seen = [];
for (let i = 0; i < 4; i++) {
  await rows.nth(0).locator("[data-name=segmentStatus]").click();
  await page.waitForTimeout(500);
  seen.push(await statusOf());
}
check("clicking the status icon steps it round, flagged going back to completed", seen.join(","), "1,2,3,2");
check("as the segment carries it", await py('str(slicer.vtkSlicerSegmentationsModuleLogic.GetSegmentStatus(slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNthSegment(0)))'), "2");
await rows.nth(0).locator("[data-name=segmentMore]").click();
await page.waitForTimeout(300);
await page.locator("[role=menu] [data-name=segmentStatus3]").click();
await page.waitForTimeout(500);
check("the menu sets a status outright", await statusOf(), "3");

// Clear empties a segment; Jump slices centres the slice views on it
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import vtk, slicer
seg = slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0]
seg.SetReferenceImageGeometryParameterFromVolumeNode(slicer.util.getNode("MR-head"))
sphere = vtk.vtkSphereSource(); sphere.SetCenter(20.0, -30.0, 40.0); sphere.SetRadius(10.0); sphere.Update()
# a sphere as the segment's surface, and the labelmap the editor works on made from it
seg.GetSegmentation().SetSourceRepresentationName("Closed surface")
seg.GetSegmentation().GetNthSegment(0).AddRepresentation("Closed surface", sphere.GetOutput())
seg.GetSegmentation().CreateRepresentation("Binary labelmap", True)
seg.GetSegmentation().SetSourceRepresentationName("Binary labelmap")
`, "exec"));
await page.waitForTimeout(800);
const voxels = () => py('(lambda r: int((__import__("vtk.util.numpy_support", fromlist=["x"]).vtk_to_numpy(r.GetPointData().GetScalars()) > 0).sum()) if r is not None and r.GetPointData().GetScalars() is not None else 0)(slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNthSegment(0).GetRepresentation("Binary labelmap"))');
check("the segment has content to clear", Number(await voxels()) > 0, true);
await rows.nth(0).locator("[data-name=segmentMore]").click();
await page.waitForTimeout(300);
await page.locator("[role=menu] [data-name=segmentJump]").click();
await page.waitForTimeout(800);
const jumped = Number(await py('slicer.app.layoutManager().sliceWidget("Red").sliceLogic().GetSliceOffset()'));
console.log(`     Red slice offset after the jump: ${jumped.toFixed(1)} mm (the segment is at 40)`);
check("Jump slices centres the slice views on the segment (within a voxel)", Math.abs(jumped - 40) < 2, true);
await rows.nth(0).locator("[data-name=segmentMore]").click();
await page.waitForTimeout(300);
await page.locator("[role=menu] [data-name=segmentClear]").click();
await page.waitForTimeout(800);
check("Clear empties the segment", await voxels(), "0");
check("and keeps it", await names(), "['Tumor', 'Segment_2']");

await rows.nth(1).click();
await page.waitForTimeout(300);
await panel.locator("[data-name=removeSegment]").click();
await page.waitForTimeout(800);
check("Remove takes the chosen one away", await names(), "['Tumor']");

// the editor lists the same
await page.evaluate(() => { window.slicerWeb.store.activeModule = "SegmentEditor"; });
await page.waitForTimeout(3000);
const editorRows = page.locator(".sw-panel-scroll").last().locator("[data-name=segmentRow]");
check("the Segment Editor lists the same segments, the same way", await editorRows.count(), 1);
check("with the name", (await editorRows.nth(0).locator("[data-name=segmentName]").innerText()).trim(), "Tumor");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

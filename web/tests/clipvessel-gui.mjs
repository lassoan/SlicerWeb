// Clip Vessel (SlicerVMTK) GUI driven like a user: pick the inputs in the module panel, place a clip
// point in a slice view, click it to get its clip plane, and use the Apply button's auto-update box.
// Usage: node tests/clipvessel-gui.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
page.on("pageerror", (e) => console.log(`${stamp()} [pageerror] ${e}`));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/GL Driver|Feedback loop|shader|vtkShaderProgram|vtkOpenGL/i.test(t)) console.log(`${stamp()} [error] ${t.slice(0, 300)}`);
});

// install SlicerVMTK at startup, like the Extensions Manager does
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheels = [new URL("extensions/" + index.extensions.find((e) => e.name === "SlicerVMTK").wheel, base).href];
await page.goto(base + "?sample=CTChest");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json, vtk"));
console.log(`${stamp()} app ready`);

// a tube surface and a centerline through it, as the module's inputs
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
cyl = vtk.vtkCylinderSource(); cyl.SetRadius(12); cyl.SetHeight(120); cyl.SetResolution(40); cyl.CappingOff()
rot = vtk.vtkTransform(); rot.RotateX(90)   # cylinder axis Y -> S, so it crosses the axial slices
tf = vtk.vtkTransformPolyDataFilter(); tf.SetTransform(rot); tf.SetInputConnection(cyl.GetOutputPort())
tri = vtk.vtkTriangleFilter(); tri.SetInputConnection(tf.GetOutputPort()); tri.Update()
surface = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLModelNode", "Tube")
surface.SetAndObserveMesh(tri.GetOutput()); surface.CreateDefaultDisplayNodes()
points, lines = vtk.vtkPoints(), vtk.vtkCellArray()
radius = vtk.vtkDoubleArray(); radius.SetName("Radius")
lines.InsertNextCell(21)
for i in range(21):
    points.InsertNextPoint(0.0, 0.0, -60.0 + i * 6.0); lines.InsertCellPoint(i); radius.InsertNextValue(12.0)
poly = vtk.vtkPolyData(); poly.SetPoints(points); poly.SetLines(lines); poly.GetPointData().AddArray(radius)
centerlines = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLModelNode", "Centerline")
centerlines.SetAndObserveMesh(poly); centerlines.CreateDefaultDisplayNodes()
`));

// open the module
await page.locator("button.h-8.w-full").first().click();
await page.getByPlaceholder("Search modules").fill("Clip Vessel");
await page.locator("div.absolute.right-2 button").first().click();
await page.waitForTimeout(5000);
const named = (name) => page.locator(`[data-name="${name}"]`).first();
const applyState = () => page.evaluate(() => {
  const host = document.querySelector('[data-name="applyButton"]');
  const button = host?.matches("button") ? host : host?.querySelector("button");
  const box = host?.querySelector('[role="checkbox"]');
  return host ? { disabled: !!button?.disabled, checkBox: !!box, checked: box?.getAttribute("aria-checked") === "true" } : null;
});
console.log(`${stamp()} apply before inputs:`, JSON.stringify(await applyState()));

// pick the inputs in the panel
for (const [selector, label] of [["inputSurfaceSelector", "Tube"], ["inputCenterlinesSelector", "Centerline"]]) {
  await named(selector).locator("select").selectOption({ label });
  await page.waitForTimeout(600);
}
console.log(`${stamp()} apply after surface+centerline:`, JSON.stringify(await applyState()));

// create the clip points node from the panel and place one point in the Red slice view
const clipSelect = named("clipPointsMarkupsSelector").locator("select");
const createLabel = (await clipSelect.locator("option").allTextContents()).find((t) => /Create new/i.test(t));
await clipSelect.selectOption({ label: createLabel });
await page.waitForTimeout(800);
console.log(`${stamp()} clip points node:`, await py('json.dumps([n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode")])'));
console.log(`${stamp()} apply after clip points:`, JSON.stringify(await applyState()));

await named("clipPointsMarkupsPlaceWidget").getByRole("button", { name: /place/i }).first().click();
await page.waitForTimeout(500);
const box = await page.locator("#slicer-view-Red").boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
await page.mouse.click(...at(0.5, 0.5));
await page.waitForTimeout(1000);
console.log(`${stamp()} placed points:`, await py('slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode")[0].GetNumberOfControlPoints()'));

// click the placed point: the module shows its clip plane
await page.mouse.move(...at(0.5, 0.5));
await page.waitForTimeout(400);
await page.mouse.down();
await page.waitForTimeout(200);
await page.mouse.up();
await page.waitForTimeout(1200);
console.log(`${stamp()} clip plane after clicking the point:`, await py('json.dumps([n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLMarkupsPlaneNode")])'));
console.log(`${stamp()} clip plane:`, await py(`json.dumps({
 "size": [round(v, 1) for v in slicer.util.getNode("Clip plane adjustment").GetSize()],
 "sizeMode": slicer.util.getNode("Clip plane adjustment").GetSizeMode(),
 "visible3D": bool(slicer.util.getNode("Clip plane adjustment").GetDisplayNode().GetVisibility3D()),
 "normalHandle": slicer.mrmlScene.GetFirstNodeByName("Clip plane normal handle") is not None,
})`));
console.log(`${stamp()} status:`, (await page.locator('[data-name="clipStatusLabel"]').first().innerText().catch(() => "?")).slice(0, 120));

// Apply: clips the tube (the output node is created on the first Apply)
await page.locator('[data-name="applyButton"] button, button[data-name="applyButton"]').first().click();
await page.waitForFunction(() => !document.querySelector('[data-name="applyButton"] button, button[data-name="applyButton"]')?.disabled, null, { timeout: 120000 });
await page.waitForTimeout(1500);
const outputPoints = () => py('json.dumps({n.GetName(): n.GetMesh().GetNumberOfPoints() for n in slicer.util.getNodesByClass("vtkMRMLModelNode") if n.GetMesh()})');
console.log(`${stamp()} models after Apply:`, await outputPoints());

// auto-update check box on the Apply button: moving the clip point re-clips without pressing Apply
await page.locator('[data-name="applyButton"] [role="checkbox"]').first().click();
await page.waitForTimeout(800);
console.log(`${stamp()} apply with auto-update:`, JSON.stringify(await applyState()),
  "AutoApplyPlane =", await py('slicer.util.getNodesByClass("vtkMRMLScriptedModuleNode")[0].GetParameter("AutoApplyPlane") if slicer.util.getNodesByClass("vtkMRMLScriptedModuleNode") else "?"'));
const state = () => py(`json.dumps({
 "point": [round(v, 1) for v in slicer.util.getNode("Clip points").GetNthControlPointPositionVector(0)],
 "planeOrigin": [round(v, 1) for v in slicer.util.getNode("Clip plane adjustment").GetOriginWorld()],
 "outputMTime": slicer.util.getNode("Tube clipped").GetMesh().GetMTime(),
})`);
const beforeAuto = await outputPoints();
const beforeState = await state();
console.log(`${stamp()} before drag: ${beforeState}`);

// The clip point is snapped onto the centerline, which runs head-feet here, so it is dragged in the
// coronal view, where that direction is in the slice plane (in the axial view it cannot move).
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
_node = slicer.util.getNode("Clip points")
slicer.modules.markups.logic().JumpSlicesToNthPointInMarkup(_node.GetID(), 0, True)
_sliceNode = slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeGreen")
_m = vtk.vtkMatrix4x4(); _m.DeepCopy(_sliceNode.GetXYToRAS()); _m.Invert()
_xy = _m.MultiplyPoint(list(_node.GetNthControlPointPositionVector(0)) + [1.0])
`));
await page.waitForTimeout(1500);
const green = await page.locator("#slicer-view-Green").boundingBox();
const xy = JSON.parse(await py("json.dumps([_xy[0], _xy[1], _sliceNode.GetDimensions()[1]])"));
const [px, pyy] = [green.x + xy[0], green.y + (xy[2] - xy[1])];
console.log(`${stamp()} clip point at view x=${xy[0].toFixed(0)} y=${xy[1].toFixed(0)} of ${xy[2]}`);
await page.mouse.move(px, pyy);
await page.waitForTimeout(400);
await page.mouse.down();
for (let i = 1; i <= 8; i++) { await page.mouse.move(px, pyy - i * 4); await page.waitForTimeout(80); }
await page.mouse.up();
await page.waitForTimeout(6000);
const afterState = JSON.parse(await state());
console.log(`${stamp()} after drag:  ${JSON.stringify(afterState)}`);
console.log(`${stamp()} auto-update ${afterState.outputMTime !== JSON.parse(beforeState).outputMTime ? "re-clipped the surface" : "DID NOT run"},`,
  `clip point ${String(afterState.point) !== JSON.parse(beforeState).point.toString() ? "moved" : "DID NOT move"}`);
const afterAuto = await outputPoints();
console.log(`${stamp()} output before drag: ${beforeAuto}`);
console.log(`${stamp()} output after drag:  ${afterAuto}`);

// a segmentation can be the input surface as well
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Tube segmentation")
seg.CreateDefaultDisplayNodes()
seg.AddSegmentFromClosedSurfaceRepresentation(slicer.util.getNode("Tube").GetMesh(), "Tube segment")
`));
await page.waitForTimeout(800);
await named("inputSurfaceSelector").locator("select").selectOption({ label: "Tube segmentation" });
await page.waitForTimeout(1000);
console.log(`${stamp()} segmentation input:`, JSON.stringify(await applyState()),
  "segment:", await py('json.dumps(slicer.util.getNodesByClass("vtkMRMLScriptedModuleNode")[0].GetParameter("InputSegmentID"))'));
if (shot) await page.screenshot({ path: shot });
await browser.close();

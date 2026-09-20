// "Reload" of a scripted module: the rebuilt GUI must work as before the reload - the old widget is
// taken down, so that two widgets do not react to the same nodes.
// Usage: node tests/module-reload.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
page.on("pageerror", (e) => console.log(`${stamp()} [pageerror] ${e}`));
page.on("console", (m) => { if (m.text().startsWith("[selector]")) console.log(`${stamp()} ${m.text().slice(0, 200)}`); });

const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheels = [new URL("extensions/" + index.extensions.find((e) => e.name === "SlicerVMTK").wheel, base).href];
await page.goto(base + "?sample=CTChest");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json, vtk"));
await page.evaluate(() => window.slicerWeb.bridge.evalPython("_clipPoints = None"));

// inputs: a tube and a centerline through it
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
cyl = vtk.vtkCylinderSource(); cyl.SetRadius(12); cyl.SetHeight(120); cyl.SetResolution(40); cyl.CappingOff()
rot = vtk.vtkTransform(); rot.RotateX(90)
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

await page.locator("button.h-8.w-full").first().click();
await page.getByPlaceholder("Search modules").fill("Clip Vessel");
await page.locator("div.absolute.right-2 button").first().click();
await page.waitForTimeout(5000);
const named = (name) => page.locator(`[data-name="${name}"]`).first();
for (const [selector, label] of [["inputSurfaceSelector", "Tube"], ["inputCenterlinesSelector", "Centerline"]]) {
  await named(selector).locator("select").selectOption({ label });
  await page.waitForTimeout(600);
}
const clipSelect = named("clipPointsMarkupsSelector").locator("select");
await clipSelect.selectOption({ label: (await clipSelect.locator("option").allTextContents()).find((t) => /Create new/i.test(t)) });
await page.waitForTimeout(800);
await named("clipPointsMarkupsPlaceWidget").getByRole("button", { name: /place/i }).first().click();
await page.waitForTimeout(400);
const red = await page.locator("#slicer-view-Red").boundingBox();
await page.mouse.click(red.x + red.width * 0.5, red.y + red.height * 0.5);
await page.waitForTimeout(1200);
console.log(`${stamp()} clip points placed: ${await py('(_clipPoints or slicer.util.getNode("Clip points")).GetNumberOfControlPoints()')}`);

// reload the module (with its self test when --test is given), from the "Reload and Test" section
const withTest = process.argv.includes("--test");
await page.getByText("Reload and Test").first().click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: withTest ? "Reload and Test" : "Reload", exact: true }).last().click();
await page.waitForFunction(() => !/Reloading|Testing/.test(document.body.innerText), null, { timeout: 600000 });
await page.waitForTimeout(2500);
if (withTest) {
  const panelText = await page.locator(".sw-panel-scroll").last().innerText();
  console.log(`${stamp()} test result:`, panelText.split("\n").filter((l) => /passed|failed|Error|Traceback|seconds/.test(l)).slice(0, 6).join(" | ").slice(0, 400));
  // the self test clears the scene and builds its own: work with the clip points it left
  // the clip points the module works with (the test picks them with "Detect clip points")
  await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
_clipPoints = slicer.modules.ClipVesselWidget.ui.clipPointsMarkupsSelector.currentNode()
_clipName = _clipPoints.GetName() if _clipPoints else None
`));
  console.log(`${stamp()} scene after the test:`, await py('json.dumps({"models": [n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLModelNode")][:6], "clipPoints": _clipName})'));
  const selectors = await page.evaluate(() => {
    const out = {};
    for (const name of ["inputSurfaceSelector", "inputCenterlinesSelector", "clipPointsMarkupsSelector"]) {
      const select = document.querySelector(`[data-name="${name}"] select`);
      out[name] = select ? { value: select.value, options: [...select.options].map((o) => o.textContent.trim()).slice(0, 8) } : null;
    }
    return out;
  });
  console.log(`${stamp()} selectors in the page:`, JSON.stringify(selectors));
  console.log(`${stamp()} parameter nodes:`, await py(`json.dumps([(n.GetName(), n.GetAttribute("ModuleName"), n.GetID()) for n in slicer.util.getNodesByClass("vtkMRMLScriptedModuleNode")])`));
  console.log(`${stamp()} parameter node of the panel:`, await py(`json.dumps([slicer.modules.ClipVesselWidget._parameterNode.GetID() if slicer.modules.ClipVesselWidget._parameterNode else None, (slicer.modules.ClipVesselWidget.ui.parameterNodeSelector.currentNode().GetID() if slicer.modules.ClipVesselWidget.ui.parameterNodeSelector.currentNode() else None)])`));
  console.log(`${stamp()} markups nodes in the scene:`, await py('json.dumps([n.GetName() + " " + n.GetID() for n in slicer.util.getNodesByClass("vtkMRMLMarkupsFiducialNode")])'));
  console.log(`${stamp()} panel selection:`, await py('json.dumps({k: (v.GetName() if v else None) for k, v in {"surface": slicer.modules.ClipVesselWidget.ui.inputSurfaceSelector.currentNode(), "centerlines": slicer.modules.ClipVesselWidget.ui.inputCenterlinesSelector.currentNode(), "clipPoints": slicer.modules.ClipVesselWidget.ui.clipPointsMarkupsSelector.currentNode()}.items()})'));
}
console.log(`${stamp()} reloaded; module widgets in the page: ${await page.locator('[data-name="applyButton"]').count()}`);
// the old widget must be gone: two widgets observing the same nodes fight over them
// no widget of the reloaded module may still be watching the scene: two widgets reacting to the
// same nodes undo each other's changes and can keep re-clipping while a point is dragged
console.log(`${stamp()} widgets left over by the reload:`, await py(`json.dumps((lambda old: {
 "stale": len(old), "stillObserving": sum(len(getattr(o, "Observations", [])) for o in old)})(
 [o for o in __import__("gc").get_objects()
  if type(o).__name__ == "ClipVesselWidget" and o is not slicer.modules.ClipVesselWidget]))`));
console.log(`${stamp()} inputs kept:`, await py(`json.dumps({k: (slicer.util.getNodesByClass("vtkMRMLScriptedModuleNode")[0].GetNodeReference(k).GetName() if slicer.util.getNodesByClass("vtkMRMLScriptedModuleNode")[0].GetNodeReference(k) else None) for k in ("InputSurface", "InputCenterlines", "ClipPoints")})`));

// click the clip point: its clip plane must appear, as before the reload
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
_node = (_clipPoints or slicer.util.getNode("Clip points"))
slicer.modules.markups.logic().JumpSlicesToNthPointInMarkup(_node.GetID(), 0, True)
_sliceNode = slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeGreen")
_m = vtk.vtkMatrix4x4(); _m.DeepCopy(_sliceNode.GetXYToRAS()); _m.Invert()
_xy = _m.MultiplyPoint(list(_node.GetNthControlPointPositionVector(0)) + [1.0])
`));
await page.waitForTimeout(1200);
const green = await page.locator("#slicer-view-Green").boundingBox();
const xy = JSON.parse(await py("json.dumps([_xy[0], _xy[1], _sliceNode.GetDimensions()[1]])"));
const [px, pyy] = [green.x + xy[0], green.y + (xy[2] - xy[1])];
await page.mouse.move(px, pyy);
await page.waitForTimeout(400);
await page.mouse.down();
await page.waitForTimeout(200);
await page.mouse.up();
await page.waitForTimeout(1500);
console.log(`${stamp()} clip plane after clicking the point: ${await py('json.dumps([n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLMarkupsPlaneNode")])')}`);

// drag the point: it must move, and the page must stay responsive
const state = () => py(`json.dumps({
 "point": [round(v, 1) for v in (_clipPoints or slicer.util.getNode("Clip points")).GetNthControlPointPositionVector(0)],
 "planeOrigin": ([round(v, 1) for v in slicer.mrmlScene.GetFirstNodeByName("Clip plane adjustment").GetOriginWorld()]
                 if slicer.mrmlScene.GetFirstNodeByName("Clip plane adjustment") else None),
 "activeComponent": (_clipPoints or slicer.util.getNode("Clip points")).GetDisplayNode().GetActiveComponentType(),
 "parameterNodeInScene": bool(slicer.modules.ClipVesselWidget._parameterNode is not None
                              and slicer.mrmlScene.IsNodePresent(slicer.modules.ClipVesselWidget._parameterNode)),
 "observedClipPoints": (slicer.modules.ClipVesselWidget._observedClipPointsNode.GetName()
                        if slicer.modules.ClipVesselWidget._observedClipPointsNode else None),
})`);
// the view may have moved since the point was clicked: ask where the point is now
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
_xy = None
_m = vtk.vtkMatrix4x4(); _m.DeepCopy(_sliceNode.GetXYToRAS()); _m.Invert()
_xy = _m.MultiplyPoint(list((_clipPoints or slicer.util.getNode("Clip points")).GetNthControlPointPositionVector(0)) + [1.0])
`));
const xy2 = JSON.parse(await py("json.dumps([_xy[0], _xy[1], _sliceNode.GetDimensions()[1]])"));
const [dx, dy] = [green.x + xy2[0], green.y + (xy2[2] - xy2[1])];
console.log(`${stamp()} before dragging: ${await state()}`);
const before = await py('json.dumps([round(v, 1) for v in (_clipPoints or slicer.util.getNode("Clip points")).GetNthControlPointPositionVector(0)])');
await page.mouse.move(dx, dy);
await page.waitForTimeout(400);
await page.mouse.down();
for (let i = 1; i <= 8; i++) { await page.mouse.move(dx, dy - i * 4); await page.waitForTimeout(80); }
await page.mouse.up();
const responded = await Promise.race([
  page.evaluate(() => window.slicerWeb.bridge.evalPython("1 + 1", "eval")).then(() => true),
  new Promise((r) => setTimeout(() => r(false), 30000)),
]);
await page.waitForTimeout(1500);
console.log(`${stamp()} after dragging:  ${await state()}`);
console.log(`${stamp()} after dragging: point ${before} -> ${await py('json.dumps([round(v, 1) for v in (_clipPoints or slicer.util.getNode("Clip points")).GetNthControlPointPositionVector(0)])')}, page ${responded ? "responds" : "HANGS"}`);

// the buttons next to the node selectors switch the visibility of the selected nodes
const visibility = () => py(`json.dumps({
 n.GetName(): bool(n.GetDisplayNode().GetVisibility())
 for n in [slicer.modules.ClipVesselWidget.ui.inputSurfaceSelector.currentNode(),
           slicer.modules.ClipVesselWidget.ui.inputCenterlinesSelector.currentNode()]
 if n is not None and n.GetDisplayNode()})`);
console.log(`${stamp()} visibility before: ${await visibility()}`);
await named("toggleInputSurfaceVisibilityButton").click();
await named("toggleCenterlinesVisibilityButton").click();
await page.waitForTimeout(800);
console.log(`${stamp()} visibility after clicking the two buttons: ${await visibility()}`);
if (shot) await page.screenshot({ path: shot });
await browser.close();

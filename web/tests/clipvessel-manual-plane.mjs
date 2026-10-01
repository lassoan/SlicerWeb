// Clip Vessel (SlicerVMTK): the buttons that adjust the clip plane manually (origin, rotation) stay
// pressed when pressed, and released when pressed again, while the clip plane is edited.
// Usage: node tests/clipvessel-manual-plane.mjs [url]
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
await page.locator("[data-name='moduleTitle']").click();
await page.getByPlaceholder("Search modules").fill("Clip Vessel");
await page.waitForTimeout(300);
await page.keyboard.press("Enter");   // the module finder opens the module that is highlighted
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

let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}`);
};
const buttonState = (name) => page.evaluate((name) => {
  const host = document.querySelector(`[data-name="${name}"]`);
  const button = host?.matches("button") ? host : host?.querySelector("button");
  return { pressed: button?.getAttribute("aria-pressed") ?? button?.dataset?.state ?? null, cls: (button?.className ?? "").includes("bg-primary") };
}, name);
// What each button lets the user do with the plane's handles: rotate it (normal), or move it in
// every direction rather than only along the centerline (origin: the in-plane translation axes).
const handles = (name) => py(name === "enableManualPlaneNormal"
  ? `str(bool(slicer.util.getNode("Clip plane adjustment").GetDisplayNode().GetRotationHandleVisibility()))`
  : `str(bool(slicer.util.getNode("Clip plane adjustment").GetDisplayNode().GetTranslationHandleComponentVisibility()[0]))`);
for (const name of ["enableManualPlaneOrigin", "enableManualPlaneNormal"]) {
  const target = page.locator(`[data-name="${name}"] button, button[data-name="${name}"]`).first();
  check(`${name} enabled while the plane is edited`, await py(`str(slicer.util.getModuleWidget("ClipVessel").ui.${name}.enabled)`), "True");
  await target.click();
  for (const wait of [200, 1500, 4000]) {
    await page.waitForTimeout(wait);
    console.log(`  ${name} pressed, after +${wait} ms: python checked=${await py(`str(slicer.util.getModuleWidget("ClipVessel").ui.${name}.checked)`)} page=${JSON.stringify(await buttonState(name))}`);
  }
  check(`${name} stays pressed`, await py(`str(slicer.util.getModuleWidget("ClipVessel").ui.${name}.checked)`), "True");
  check(`${name} pressed: the handles that adjust it`, await handles(name), "True");
  await target.click();
  await page.waitForTimeout(2000);
  check(`${name} released again`, await py(`str(slicer.util.getModuleWidget("ClipVessel").ui.${name}.checked)`), "False");
  check(`${name} released: those handles are off`, await handles(name), "False");
}
await browser.close();
process.exit(failures ? 1 : 0);

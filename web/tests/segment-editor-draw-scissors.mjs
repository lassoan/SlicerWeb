// Segment Editor effects that work on an outline drawn in a view, as in desktop Slicer: Draw fills
// the outline in the slice it was drawn on, Scissors cut through the segment (from a slice view, in
// all slices or in some of them, and from the viewpoint of a 3D view), and Mask volume fills a
// volume inside or outside a segment.
// Usage: node tests/segment-editor-draw-scissors.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") console.log("[console] " + m.text().slice(0, 300)); });
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);
const number = async (expr) => Number(await value(expr));
const json = async (expr) => JSON.parse(String(await value(expr)).replace(/^'|'$/g, ""));
const call = (method, args = []) => page.evaluate(([m, a]) => window.slicerWeb.bridge.call(m, a), [method, args]);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

await run(`
import json, numpy as np, slicer
from vtk.util import numpy_support

volume = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]
shape = slicer.util.arrayFromVolume(volume).shape
mid = [s // 2 for s in shape]
segmentationNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Outlines")
segmentationNode.CreateDefaultDisplayNodes()
segmentationNode.SetReferenceImageGeometryParameterFromVolumeNode(volume)
boxID = segmentationNode.GetSegmentation().AddEmptySegment("", "box")
otherID = segmentationNode.GetSegmentation().AddEmptySegment("", "other")

def array(segmentID):
    """The segment as an array of the volume's voxels."""
    return slicer.util.arrayFromSegmentBinaryLabelmap(segmentationNode, segmentID, volume)

def count(segmentID):
    return int((array(segmentID) > 0).sum())

def perSlice(segmentID):
    """How many voxels the segment has on each slice (axial) of the box."""
    a = array(segmentID)
    return [int((a[k] > 0).sum()) for k in range(mid[0] - 10, mid[0] + 10)]

def setBox(segmentID):
    a = np.zeros(shape, np.uint8)
    a[mid[0] - 10:mid[0] + 10, mid[1] - 60:mid[1] + 60, mid[2] - 60:mid[2] + 60] = 1
    slicer.util.updateSegmentBinaryLabelmapFromArray(a, segmentationNode, segmentID, volume)

def clear(segmentID):
    slicer.util.updateSegmentBinaryLabelmapFromArray(np.zeros(shape, np.uint8), segmentationNode, segmentID, volume)

# The red slice view on the middle slice of the box
red = slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode()
import vtk
matrix = vtk.vtkMatrix4x4()
volume.GetIJKToRASMatrix(matrix)
centerRas = matrix.MultiplyPoint([mid[2], mid[1], mid[0], 1])[:3]
red.JumpSliceByOffsetting(*centerRas)
`);

// the module, with the segmentation and the box segment
await page.getByRole("button", { name: "Segment Editor" }).first().click();
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
const segmentationID = String(await value("segmentationNode.GetID()")).replace(/^'|'$/g, "");
await call("segmentEditorSetup", [segmentationID, null]);
const boxID = String(await value("boxID")).replace(/^'|'$/g, "");
await call("segmentEditorSelectSegment", [boxID]);
await page.waitForTimeout(500);

const viewBox = async (id) => {
  const b = await page.locator(`#slicer-view-${id}`).boundingBox();
  return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
};
const red = await viewBox("Red");
const yellowPixels = (viewId) => page.evaluate(async (id) => {
  await window.slicerWeb.bridge.call("renderView", [id]);
  const host = document.querySelector(`#slicer-view-${id}`);
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const gl = canvas?.getContext("webgl2");
  if (!gl) return -1;
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let count = 0;
  for (let p = 0; p < pixels.length; p += 4) {
    if (pixels[p] > 150 && pixels[p + 1] > 150 && pixels[p + 2] < 80) count++;
  }
  return count;
}, viewId);

// --- Draw
await panel.getByRole("button", { name: "Draw", exact: true }).first().click();
await page.waitForTimeout(800);
const drawBefore = await yellowPixels("Red");
const corners = [[-50, -40], [50, -40], [50, 40], [-50, 40]].map(([dx, dy]) => [red.cx + dx, red.cy + dy]);
for (const [x, y] of corners.slice(0, 3)) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(150);
}
const drawOutline = await yellowPixels("Red");
check("draw: clicks add points to an outline that is shown", drawOutline > drawBefore + 100, `${drawBefore} -> ${drawOutline} yellow pixels`);
check("draw: the segment is not changed while drawing", (await number("count(boxID)")) === 0);
await page.mouse.click(corners[3][0], corners[3][1]);
await page.waitForTimeout(150);
// x deletes the last point, a fourth one is placed again
await page.keyboard.press("x");
await page.waitForTimeout(150);
await page.mouse.click(corners[3][0], corners[3][1]);
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
const drawn = await json("json.dumps(perSlice(boxID))");
const drawnTotal = await number("count(boxID)");
const slicesWithDrawing = drawn.filter((n) => n > 0).length;
check("draw: Enter fills the outline", drawnTotal > 500, `${drawnTotal} voxels`);
check("draw: on the slice it was drawn on only", slicesWithDrawing === 1 && drawnTotal === drawn.reduce((a, b) => a + b, 0),
  `${slicesWithDrawing} slices, ${drawnTotal} voxels`);
check("draw: and the outline is removed", (await yellowPixels("Red")) < drawBefore + 100);
check("draw: it can be undone", (await page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorState"))).canUndo === true);

// right-click applies an outline as well
await run("clear(boxID)");
for (const [x, y] of corners) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(120);
}
await page.mouse.click(red.cx, red.cy, { button: "right" });
await page.waitForTimeout(1200);
const rightClicked = await number("count(boxID)");
check("draw: right-click fills the outline", Math.abs(rightClicked - drawnTotal) < 0.1 * drawnTotal, `${rightClicked} voxels (${drawnTotal} with Enter)`);

// and a double click
await run("clear(boxID)");
for (const [x, y] of corners.slice(0, 3)) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(120);
}
await page.mouse.dblclick(corners[3][0], corners[3][1]);
await page.waitForTimeout(1200);
const doubleClicked = await number("count(boxID)");
check("draw: double-click fills the outline", Math.abs(doubleClicked - drawnTotal) < 0.1 * drawnTotal, `${doubleClicked} voxels`);
const maximized = await value("str(slicer.app.layoutManager().layout)");
check("draw: and the double click does not maximize the view", !/^'?(6|SlicerLayoutOneUpRedSliceView)'?$/.test(String(maximized)), String(maximized));

// --- Scissors in a slice view
await panel.getByRole("button", { name: "Scissors", exact: true }).first().click();
await page.waitForTimeout(800);
const params = async () => (await page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorState"))).effectParameters.Scissors;
const defaults = await params();
check("scissors: desktop defaults", defaults.Operation === "EraseInside" && defaults.Shape === "FreeForm" && defaults.SliceCutMode === "Unlimited",
  JSON.stringify(defaults));
const dragShape = async (view, points, during) => {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(25);
  }
  const shown = during ? await during() : undefined;
  await page.mouse.up();
  await page.waitForTimeout(1500);
  return shown;
};
const freeForm = (box, r) => Array.from({ length: 25 }, (_, i) => [box.cx + r * Math.cos((2 * Math.PI * i) / 24), box.cy + r * Math.sin((2 * Math.PI * i) / 24)]);

await run("setBox(boxID)");
const full = await json("json.dumps(perSlice(boxID))");
const outlineShown = await dragShape(red, freeForm(red, 30), () => yellowPixels("Red"));
check("scissors: the outline is shown while dragging", outlineShown > 100, `${outlineShown} yellow pixels`);
const cut = await json("json.dumps(perSlice(boxID))");
check("scissors: erase inside cuts through every slice (unlimited)",
  cut.every((n, k) => n < full[k]) && new Set(cut).size === 1, `${full[0]} -> ${cut.join(",")}`);
check("scissors: the outline is removed after the cut", (await yellowPixels("Red")) < 100);

// symmetric slice cut of no thickness: the current slice only
await run("setBox(boxID)");
await page.getByText("Symmetric", { exact: true }).click();
await page.waitForTimeout(500);
await dragShape(red, freeForm(red, 30));
const symmetric = await json("json.dumps(perSlice(boxID))");
check("scissors: symmetric slice cut of zero depth cuts the current slice only",
  symmetric.filter((n, k) => n < full[k]).length === 1, symmetric.join(","));
await call("segmentEditorSetEffectParameter", ["Scissors", "SliceCutMode", "Unlimited"]);

// rectangle, fill inside
await run("clear(boxID)");
await call("segmentEditorSetEffectParameter", ["Scissors", "Operation", "FillInside"]);
await call("segmentEditorSetEffectParameter", ["Scissors", "Shape", "Rectangle"]);
await dragShape(red, [[red.cx - 30, red.cy - 20], [red.cx, red.cy], [red.cx + 30, red.cy + 20]]);
const filled = await number("count(boxID)");
const filledSlices = await number("int(((array(boxID) > 0).sum(axis=(1, 2)) > 0).sum())");
check("scissors: fill inside a rectangle fills it through all slices", filled > 0 && filledSlices === (await number("shape[0]")),
  `${filled} voxels on ${filledSlices} slices`);

// erase outside a circle, applied to all visible segments
await run("setBox(boxID); setBox(otherID)");
await call("segmentEditorSetEffectParameter", ["Scissors", "Operation", "EraseOutside"]);
await call("segmentEditorSetEffectParameter", ["Scissors", "Shape", "Circle"]);
await call("segmentEditorSetEffectParameter", ["Scissors", "ShapeDrawCentered", 1]);
await call("segmentEditorSetEffectParameter", ["Scissors", "ApplyToAllVisibleSegments", 1]);
await dragShape(red, [[red.cx, red.cy], [red.cx + 15, red.cy], [red.cx + 30, red.cy]]);
const boxLeft = await number("count(boxID)"), otherLeft = await number("count(otherID)");
const boxFull = full.reduce((a, b) => a + b, 0);
check("scissors: erase outside a centered circle, in all visible segments",
  boxLeft > 0 && boxLeft < boxFull / 2 && otherLeft === boxLeft, `box ${boxLeft}, other ${otherLeft} of ${boxFull}`);
await call("segmentEditorSetEffectParameter", ["Scissors", "ApplyToAllVisibleSegments", 0]);

// --- Scissors in the 3D view
const has3D = await page.locator("#slicer-view-1").count();
if (has3D) {
  await run("setBox(boxID); clear(otherID)");
  await call("segmentEditorSetEffectParameter", ["Scissors", "Operation", "EraseInside"]);
  await call("segmentEditorSetEffectParameter", ["Scissors", "Shape", "FreeForm"]);
  await run(`
lm = slicer.app.layoutManager()
threeD = [v for v in lm.views().values() if v.IsA("vtkSlicerWebThreeDView")][0]
camera = threeD.GetRenderer().GetActiveCamera()
camera.SetFocalPoint(*centerRas)
camera.SetPosition(centerRas[0], centerRas[1], centerRas[2] + 500)
camera.SetViewUp(0, 1, 0)
threeD.GetRenderer().ResetCameraClippingRange()
threeD.ScheduleRender()
`);
  await page.waitForTimeout(800);
  const view3D = await viewBox("1");
  const before3D = await number("count(boxID)");
  await dragShape(view3D, freeForm(view3D, Math.min(view3D.w, view3D.h) / 10));
  const after3D = await json("json.dumps(perSlice(boxID))");
  const after3DTotal = after3D.reduce((a, b) => a + b, 0);
  // The camera has perspective: the cut is a cone, smaller on the slices nearer the camera
  check("scissors in 3D: erase inside cuts along the view direction, through every slice",
    after3DTotal < before3D && after3D.every((n) => n < before3D / 20), `${before3D} -> ${after3DTotal} (${after3D.join(",")} per slice)`);
} else {
  check("scissors in 3D: the layout has a 3D view", false);
}

// --- Mask volume
await run(`
ball = np.zeros(shape, np.uint8)
zz, yy, xx = np.ogrid[:shape[0], :shape[1], :shape[2]]
ball[((zz - mid[0]) ** 2 + (yy - mid[1]) ** 2 + (xx - mid[2]) ** 2) < 15 ** 2] = 1
slicer.util.updateSegmentBinaryLabelmapFromArray(ball, segmentationNode, boxID, volume)
original = slicer.util.arrayFromVolume(volume).copy()
`);
await panel.getByRole("button", { name: "Mask volume", exact: true }).first().click();
await page.waitForTimeout(800);
const maskDefaults = (await page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorState"))).effectParameters.MaskVolume;
check("mask volume: desktop defaults", maskDefaults.Operation === "FILL_OUTSIDE" && maskDefaults.FillValue === 0 && maskDefaults.SoftEdgeMm === 0,
  JSON.stringify(maskDefaults));
await call("segmentEditorSetEffectParameter", ["MaskVolume", "FillValue", -1000]);
await page.waitForTimeout(300);
await panel.getByRole("button", { name: "Apply", exact: true }).first().click();
await page.waitForTimeout(2000);
const masked = await json(`json.dumps((lambda n: None if n is None else {
    "name": n.GetName(),
    "outside": bool((slicer.util.arrayFromVolume(n)[ball == 0] == -1000).all()),
    "inside": bool((slicer.util.arrayFromVolume(n)[ball > 0] == original[ball > 0]).all()),
    "shown": slicer.app.layoutManager().sliceWidget("Red").mrmlSliceCompositeNode().GetBackgroundVolumeID() == n.GetID(),
    "input": bool((slicer.util.arrayFromVolume(volume) == original).all())})(
    slicer.mrmlScene.GetFirstNodeByName(volume.GetName() + " masked")))`);
check("mask volume: fill outside makes a masked copy of the source volume", masked?.outside && masked?.inside && masked?.input,
  JSON.stringify(masked));
check("mask volume: and shows it", masked?.shown === true);

await call("segmentEditorSetEffectParameter", ["MaskVolume", "Operation", "FILL_INSIDE_AND_OUTSIDE"]);
await call("segmentEditorSetEffectNodeReference", ["MaskVolume", "OutputVolume", null]);
await page.waitForTimeout(300);
await panel.getByRole("button", { name: "Apply", exact: true }).first().click();
await page.waitForTimeout(2000);
const label = await json(`json.dumps((lambda n: None if n is None else {
    "labelmap": n.IsA("vtkMRMLLabelMapVolumeNode"),
    "inside": int((slicer.util.arrayFromVolume(n) == 1).sum()), "ball": int(ball.sum()),
    "outside": int((slicer.util.arrayFromVolume(n) == 0).sum()), "voxels": int(ball.size)})(
    slicer.mrmlScene.GetFirstNodeByName(volume.GetName() + " label")))`);
check("mask volume: fill inside and outside makes a labelmap of the segment",
  label?.labelmap && label.inside === label.ball && label.inside + label.outside === label.voxels, JSON.stringify(label));

await call("segmentEditorSetEffectParameter", ["MaskVolume", "Operation", "FILL_OUTSIDE"]);
await call("segmentEditorSetEffectParameter", ["MaskVolume", "SoftEdgeMm", 3]);
await call("segmentEditorSetEffectNodeReference", ["MaskVolume", "OutputVolume", null]);
await page.waitForTimeout(300);
await panel.getByRole("button", { name: "Apply", exact: true }).first().click();
await page.waitForTimeout(3000);
const errorBox = panel.locator("[class*=bg-destructive]");
const softError = (await errorBox.count()) ? await errorBox.first().innerText() : "";
check("mask volume: soft edge applied without error", !softError, softError);
const soft = await json(`json.dumps((lambda nodes: (lambda a: {
    "between": int(((a > -1000) & (a != original)).sum())})(slicer.util.arrayFromVolume(nodes[-1])))(
    [n for n in slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode") if n.GetName().startswith(volume.GetName() + " masked")]))`);
check("mask volume: a soft edge blends the fill value into the volume", soft.between > 100, JSON.stringify(soft));

// leaving the effect shows the source volume again, as on the desktop
await panel.getByRole("button", { name: "None", exact: true }).first().click();
await page.waitForTimeout(800);
const shownAfter = String(await value(`str(slicer.app.layoutManager().sliceWidget("Red").mrmlSliceCompositeNode().GetBackgroundVolumeID() == volume.GetID())`));
check("mask volume: leaving the effect shows the source volume again", shownAfter.replace(/^'|'$/g, "") === "True", shownAfter);

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

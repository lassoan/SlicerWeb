// More of the desktop Segment Editor: Escape deactivates the effect (cancelling a scissors cut being
// drawn), Space switches back to the effect before, Paint works on the surfaces of 3D views with
// "Edit in 3D views", Islands has all of its operations, and Smoothing all of its methods and the
// smoothing brush.
// Usage: node tests/segment-editor-more-effects.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 200)));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const text = async (expr) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr)).replace(/^['"]|['"]$/g, "");
const number = async (expr) => Number(await text(expr));
const json = async (expr) => JSON.parse(await text(expr));
const call = (method, args = []) => page.evaluate(([m, a]) => window.slicerWeb.bridge.call(m, a), [method, args]);
const state = () => call("segmentEditorState");
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

await run(`
import json, numpy as np, slicer, vtk
volume = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]
shape = slicer.util.arrayFromVolume(volume).shape
mid = [s // 2 for s in shape]
node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "More")
node.CreateDefaultDisplayNodes()
node.SetReferenceImageGeometryParameterFromVolumeNode(volume)
segA = node.GetSegmentation().AddEmptySegment("", "a")
segB = node.GetSegmentation().AddEmptySegment("", "b")

def array(segmentID):
    return slicer.util.arrayFromSegmentBinaryLabelmap(node, segmentID, volume)

def count(segmentID):
    return int((array(segmentID) > 0).sum())

def put(segmentID, a):
    slicer.util.updateSegmentBinaryLabelmapFromArray(a.astype(np.uint8), node, segmentID, volume)

def box(z0, z1, y0, y1, x0, x1):
    a = np.zeros(shape, np.uint8)
    a[mid[0] + z0:mid[0] + z1, mid[1] + y0:mid[1] + y1, mid[2] + x0:mid[2] + x1] = 1
    return a

matrix = vtk.vtkMatrix4x4()
volume.GetIJKToRASMatrix(matrix)
centerRas = matrix.MultiplyPoint([mid[2], mid[1], mid[0], 1])[:3]
slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode().JumpSliceByOffsetting(*centerRas)
`);

await page.getByRole("button", { name: "Segment Editor" }).first().click();
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
await call("segmentEditorSetup", [await text("node.GetID()"), null]);
await call("segmentEditorSelectSegment", [await text("segA")]);
await page.waitForTimeout(500);
const effectButton = (name) => panel.getByRole("button", { name, exact: true }).first();
const red = await page.locator("#slicer-view-Red").boundingBox();
const rcx = red.x + red.width / 2, rcy = red.y + red.height / 2;

// --- Escape and Space
await effectButton("Paint").click();
await page.waitForTimeout(400);
await effectButton("Scissors").click();
await page.waitForTimeout(400);
await run("put(segA, box(-5, 5, -60, 60, -60, 60))");
const fullBox = await number("count(segA)");
await page.mouse.move(rcx - 30, rcy - 30);
await page.mouse.down();
for (const [dx, dy] of [[30, -30], [30, 30], [-30, 30], [-30, -10]]) { await page.mouse.move(rcx + dx, rcy + dy); await page.waitForTimeout(40); }
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
await page.mouse.up();
await page.waitForTimeout(1000);
check("Escape deactivates the effect", (await state()).effect === null);
check("and cancels the scissors cut being drawn", (await number("count(segA)")) === fullBox, await text("str(count(segA))"));
await page.mouse.click(rcx + 200, rcy + 200);   // the focus out of the panel's buttons
await page.keyboard.press(" ");
await page.waitForTimeout(500);
check("Space switches back to the effect before", (await state()).effect === "Scissors", String((await state()).effect));
await page.keyboard.press(" ");
await page.waitForTimeout(500);
check("and again to the one before that (None)", (await state()).effect === null, String((await state()).effect));
await effectButton("Paint").click();
await page.waitForTimeout(400);
await effectButton("Erase").click();
await page.waitForTimeout(400);
await page.keyboard.press(" ");
await page.waitForTimeout(500);
check("Space toggles between the last two effects", (await state()).effect === "Paint", String((await state()).effect));

// --- Paint in a 3D view
await call("segmentEditorShow3D", [true]);
await run(`
lm = slicer.app.layoutManager()
threeD = [v for v in lm.views().values() if v.IsA("vtkSlicerWebThreeDView")][0]
camera = threeD.GetRenderer().GetActiveCamera()
camera.SetFocalPoint(*centerRas)
camera.SetPosition(centerRas[0], centerRas[1], centerRas[2] + 600)
camera.SetViewUp(0, 1, 0)
threeD.GetRenderer().ResetCameraClippingRange()
threeD.ScheduleRender()
`);
await page.waitForTimeout(2000);
const view3D = await page.locator("#slicer-view-1").boundingBox();
const cx3 = view3D.x + view3D.width / 2, cy3 = view3D.y + view3D.height / 2;
const drag3D = async (x, y) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(x + 4 * i, y + 2 * i); await page.waitForTimeout(40); }
  await page.mouse.up();
  await page.waitForTimeout(1500);
};
await call("segmentEditorSetBrush", [8, null]);
const cameraBefore = await text("str(camera.GetPosition())");
const beforePaint3D = await number("count(segB)");
await call("segmentEditorSelectSegment", [await text("segB")]);
await drag3D(cx3, cy3);
check("Paint in 3D views is off by default: the view rotates", (await number("count(segB)")) === beforePaint3D
  && (await text("str(camera.GetPosition())")) !== cameraBefore);
await run(`
camera.SetFocalPoint(*centerRas)
camera.SetPosition(centerRas[0], centerRas[1], centerRas[2] + 600)
camera.SetViewUp(0, 1, 0)
threeD.GetRenderer().ResetCameraClippingRange()
threeD.ScheduleRender()
`);
await page.waitForTimeout(1000);
await panel.getByText("Edit in 3D views", { exact: true }).click();
await page.waitForTimeout(800);
check("Edit in 3D views is set", (await state()).effectParameters.Paint.EditIn3DViews === 1);
const cameraOn = await text("str(camera.GetPosition())");
await drag3D(cx3, cy3);
const painted3D = await json(`json.dumps([count(segB), [int(v) for v in np.argwhere(array(segB) > 0).mean(axis=0)] if count(segB) else None])`);
check("Edit in 3D views: dragging on the surface paints there", painted3D[0] > 0, JSON.stringify(painted3D));
check("on the surface nearest the camera (the top slices of the box)",
  painted3D[1] && Math.abs(painted3D[1][0] - (await number("mid[0] + 5"))) <= 10, JSON.stringify(painted3D[1]));
check("and the view does not rotate while painting", (await text("str(camera.GetPosition())")) === cameraOn);
check("and no brush is left in the 3D view when the stroke ends (a lifted finger hovers nowhere)",
  (await text("str(len(__import__('slicerweb.segment_editor', fromlist=['x']).editor()._hoverBrushes))")) === "0");
const beforeMiss = await number("count(segB)");
await drag3D(view3D.x + 15, view3D.y + 15);
check("off the surfaces the view rotates instead", (await number("count(segB)")) === beforeMiss
  && (await text("str(camera.GetPosition())")) !== cameraOn);
await call("segmentEditorShow3D", [false]);
await panel.getByText("Edit in 3D views", { exact: true }).click();
await page.waitForTimeout(500);

// --- Islands
await run(`
islands = np.zeros(shape, np.uint8)
islands[mid[0], mid[1] - 40:mid[1] - 20, mid[2] - 40:mid[2] - 20] = 1    # 400 voxels
islands[mid[0], mid[1] + 10:mid[1] + 20, mid[2] + 10:mid[2] + 20] = 1    # 100 voxels
islands[mid[0], mid[1] + 30:mid[1] + 33, mid[2] - 5:mid[2] - 2] = 1      # 9 voxels
`);
const islandsCase = async (operation, minimumSize = 50) => {
  await run(`put(segA, islands); put(segB, np.zeros(shape, np.uint8))`);
  await call("segmentEditorSelectSegment", [await text("segA")]);
  await call("segmentEditorSetEffectParameter", ["Islands", "Operation", operation]);
  await call("segmentEditorSetEffectParameter", ["Islands", "MinimumSize", minimumSize]);
};
await effectButton("Islands").click();
await page.waitForTimeout(500);
check("islands: desktop defaults", JSON.stringify((await state()).effectParameters.Islands) === JSON.stringify({ Operation: "KEEP_LARGEST_ISLAND", MinimumSize: 1000 }),
  JSON.stringify((await state()).effectParameters.Islands));
await islandsCase("KEEP_LARGEST_ISLAND");
await call("segmentEditorApply", ["Islands"]);
check("islands: keep largest island", (await number("count(segA)")) === 400, await text("str(count(segA))"));
await islandsCase("REMOVE_SMALL_ISLANDS");
await call("segmentEditorApply", ["Islands"]);
check("islands: remove small islands", (await number("count(segA)")) === 500, await text("str(count(segA))"));
await islandsCase("SPLIT_ISLANDS_TO_SEGMENTS", 0);
const segmentsBefore = await number("node.GetSegmentation().GetNumberOfSegments()");
await call("segmentEditorApply", ["Islands"]);
const split = await json(`json.dumps([(node.GetSegmentation().GetNthSegment(i).GetName(), count(node.GetSegmentation().GetNthSegmentID(i)))
    for i in range(node.GetSegmentation().GetNumberOfSegments())])`);
check("islands: split islands to segments, ordered by size", split.length === segmentsBefore + 2
  && split[0][1] === 400 && split.some(([n, c]) => n === "a_2" && c === 100) && split.some(([n, c]) => n === "a_3" && c === 9), JSON.stringify(split));
await run(`
for segmentID in list(node.GetSegmentation().GetSegmentIDs()):
    if segmentID not in (segA, segB):
        node.GetSegmentation().RemoveSegment(segmentID)
`);
// keep, remove and add the island that is clicked in the red slice view
const xyOf = async (k, j, i) => {
  const xy = await json(`json.dumps((lambda m: (lambda p: [p[0], p[1]])(m.MultiplyPoint(list(matrix.MultiplyPoint([${i}, ${j}, ${k}, 1])[:3]) + [1])))(
      (lambda inv: (vtk.vtkMatrix4x4.Invert(slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode().GetXYToRAS(), inv), inv)[1])(vtk.vtkMatrix4x4())))`);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  return [red.x + xy[0] / dpr, red.y + red.height - xy[1] / dpr];
};
const smallIsland = await xyOf(await number("mid[0]"), await number("mid[1] + 15"), await number("mid[2] + 15"));
await islandsCase("KEEP_SELECTED_ISLAND");
check("islands: Apply is not offered for the operations that select an island", !(await effectButton("Apply").isVisible().catch(() => false)));
await page.mouse.click(smallIsland[0], smallIsland[1]);
await page.waitForTimeout(1200);
check("islands: keep selected island", (await number("count(segA)")) === 100, await text("str(count(segA))"));
await islandsCase("REMOVE_SELECTED_ISLAND");
await page.mouse.click(smallIsland[0], smallIsland[1]);
await page.waitForTimeout(1200);
check("islands: remove selected island", (await number("count(segA)")) === 409, await text("str(count(segA))"));
await islandsCase("ADD_SELECTED_ISLAND");
await call("segmentEditorSelectSegment", [await text("segB")]);
await page.mouse.click(smallIsland[0], smallIsland[1]);
await page.waitForTimeout(1200);
check("islands: add selected island (to another segment)", (await number("count(segB)")) === 100, await text("str(count(segB))"));

// --- Smoothing
await call("segmentEditorSelectSegment", [await text("segA")]);
await effectButton("Smoothing").click();
await page.waitForTimeout(500);
const smoothingDefaults = (await state()).effectParameters.Smoothing;
check("smoothing: desktop defaults", smoothingDefaults.SmoothingMethod === "MEDIAN" && smoothingDefaults.KernelSizeMm === 3
  && smoothingDefaults.GaussianStandardDeviationMm === 3 && smoothingDefaults.JointTaubinSmoothingFactor === 0.5, JSON.stringify(smoothingDefaults));
check("smoothing: the kernel size in pixels is shown", /\d+x\d+x\d+ pixel/.test(await panel.innerText()));
await run(`
spiky = box(-5, 5, -30, 30, -30, 30)
spiky[mid[0] - 5:mid[0] + 5, mid[1] - 1:mid[1] + 1, mid[2] + 30:mid[2] + 45] = 1   # a thin extrusion
spiky[mid[0], mid[1] - 2:mid[1] + 2, mid[2] - 2:mid[2] + 2] = 0                   # a small hole
`);
const smooth = async (method, settings = {}) => {
  await run("put(segA, spiky)");
  await call("segmentEditorSetEffectParameter", ["Smoothing", "SmoothingMethod", method]);
  for (const [k, v] of Object.entries(settings)) await call("segmentEditorSetEffectParameter", ["Smoothing", k, v]);
  await call("segmentEditorApply", ["Smoothing"]);
  return json(`json.dumps([count(segA), int(array(segA)[mid[0] - 3, mid[1], mid[2] + 40]), int(array(segA)[mid[0], mid[1], mid[2]])])`);
};
const spikyCount = await number("int(spiky.sum())");
let [n, extrusion, hole] = await smooth("MORPHOLOGICAL_OPENING", { KernelSizeMm: 5 });
check("smoothing: opening removes the extrusion", extrusion === 0 && n < spikyCount, `${spikyCount} -> ${n}`);
[n, extrusion, hole] = await smooth("MORPHOLOGICAL_CLOSING");
check("smoothing: closing fills the hole", hole === 1 && n > spikyCount, `${spikyCount} -> ${n}`);
[n, extrusion, hole] = await smooth("MEDIAN");
check("smoothing: median removes the extrusion and fills the hole", extrusion === 0 && hole === 1, `${spikyCount} -> ${n}`);
[n, extrusion, hole] = await smooth("GAUSSIAN", { GaussianStandardDeviationMm: 2 });
check("smoothing: Gaussian smooths it", extrusion === 0 && n !== spikyCount, `${spikyCount} -> ${n}`);
await run("put(segB, box(-5, 5, -30, 30, 30, 60))");
await run("put(segA, spiky)");
await call("segmentEditorSetEffectParameter", ["Smoothing", "SmoothingMethod", "JOINT_TAUBIN"]);
await call("segmentEditorApply", ["Smoothing"]);
const joint = await json(`json.dumps([count(segA), count(segB), int(((array(segA) > 0) & (array(segB) > 0)).sum())])`);
check("smoothing: joint smoothing smooths the visible segments together, without overlaps", joint[0] > 0 && joint[1] > 0 && joint[2] === 0,
  JSON.stringify(joint));
// the smoothing brush: only where it is painted
await call("segmentEditorSetEffectParameter", ["Smoothing", "SmoothingMethod", "MORPHOLOGICAL_OPENING"]);
await run("put(segA, spiky)");
await call("segmentEditorSetBrush", [4, null]);
const extrusionXY = await xyOf(await number("mid[0]"), await number("mid[1]"), await number("mid[2] + 40"));
await page.mouse.move(extrusionXY[0] - 5, extrusionXY[1]);
await page.mouse.down();
await page.mouse.move(extrusionXY[0] + 5, extrusionXY[1], { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(1500);
const brushed = await json(`json.dumps([int(array(segA)[mid[0], mid[1], mid[2] + 40]), int(array(segA)[mid[0] - 3, mid[1], mid[2] + 40]), int(array(segA)[mid[0], mid[1] - 29, mid[2] - 29])])`);
check("smoothing brush: smooths where it is painted (on the slice of the disc brush)", brushed[0] === 0, JSON.stringify(brushed));
check("smoothing brush: and nowhere else", brushed[1] === 1 && brushed[2] === 1, JSON.stringify(brushed));

// --- Margin
await effectButton("Margin").click();
await page.waitForTimeout(500);
check("margin: desktop defaults (grow by 3 mm)", JSON.stringify((await state()).effectParameters.Margin) === JSON.stringify({ MarginSizeMm: 3, ApplyToAllVisibleSegments: 0 }),
  JSON.stringify((await state()).effectParameters.Margin));
check("margin: the margin the voxels allow is shown", /^Actual: [\d.]+ x [\d.]+ x [\d.]+ mm \(\d+x\d+x\d+ pixel\)$/.test((await state()).margin?.actual ?? ""),
  (await state()).margin?.actual);
await run("put(segA, box(-3, 3, -10, 10, -10, 10)); put(segB, box(-3, 3, 20, 30, 20, 30))");
const [a0, b0] = [await number("count(segA)"), await number("count(segB)")];
await call("segmentEditorSelectSegment", [await text("segA")]);
await call("segmentEditorApply", ["Margin"]);
const [a1, b1] = [await number("count(segA)"), await number("count(segB)")];
check("margin: grow the selected segment only", a1 > a0 && b1 === b0, `${a0} -> ${a1}, other ${b0} -> ${b1}`);
await panel.getByText("Shrink", { exact: true }).click();
await page.waitForTimeout(500);
check("margin: Shrink makes the margin negative", (await state()).effectParameters.Margin.MarginSizeMm === -3);
await call("segmentEditorApply", ["Margin"]);
check("margin: shrink gives the segment back", Math.abs((await number("count(segA)")) - a0) <= a0 * 0.05, await text("str(count(segA))"));
await call("segmentEditorSetEffectParameter", ["Margin", "MarginSizeMm", 3]);
await call("segmentEditorSetEffectParameter", ["Margin", "ApplyToAllVisibleSegments", 1]);
const [a2, b2] = [await number("count(segA)"), await number("count(segB)")];
await call("segmentEditorApply", ["Margin"]);
check("margin: apply to visible segments grows them all", (await number("count(segA)")) > a2 && (await number("count(segB)")) > b2);
await call("segmentEditorSetEffectParameter", ["Margin", "MarginSizeMm", 0.1]);
await page.waitForTimeout(500);
check("margin: a margin smaller than a voxel is not feasible", (await state()).margin?.feasible === false
  && (await state()).margin?.actual === "Not feasible at current resolution." && await effectButton("Apply").isDisabled());

// --- Logical operators: which way the other segment is used, in the desktop's words
await effectButton("Logical operators").click();
await page.waitForTimeout(500);
const labels = [];
const operationBox = panel.locator("select", { has: page.locator("option", { hasText: "Intersect" }) }).first();
for (const operation of ["Copy", "Add", "Subtract", "Intersect"]) {
  await operationBox.selectOption({ label: operation });
  await page.waitForTimeout(300);
  labels.push((await panel.innerText()).match(/(Copy from segment|Add segment|Subtract segment|Intersect with segment)/)?.[1] ?? "?");
}
check("logical operators: the desktop's labels for the other segment",
  JSON.stringify(labels) === JSON.stringify(["Copy from segment", "Add segment", "Subtract segment", "Intersect with segment"]), JSON.stringify(labels));

// --- Threshold preview
await call("segmentEditorSelectSegment", [await text("segA")]);
await effectButton("Threshold").click();
await page.waitForTimeout(2500);
await run(`
def previewNode():
    from slicerweb import segment_editor
    return segment_editor.editor().thresholdPreview.node
def previewCount():
    n = previewNode()
    if n is None:
        return -1
    import vtk
    return int((slicer.util.arrayFromSegmentBinaryLabelmap(n, n.GetSegmentation().GetNthSegmentID(0), volume) > 0).sum())
`);
check("threshold: a preview is shown when the effect is chosen", (await number("previewCount()")) > 0, await text("str(previewCount())"));
check("threshold: hidden from the Data tree and the node selectors", (await text("str(bool(previewNode().GetHideFromEditors()))")) === "True");
check("threshold: in the color of the selected segment",
  (await text("str(previewNode().GetSegmentation().GetNthSegment(0).GetColor() == node.GetSegmentation().GetSegment(segA).GetColor())")) === "True");
const opacities = [];
for (let i = 0; i < 6; i++) { opacities.push(await number("previewNode().GetDisplayNode().GetOpacity2DFill()")); await page.waitForTimeout(150); }
check("threshold: the preview pulses, as on the desktop", new Set(opacities.map((o) => o.toFixed(2))).size > 2 && Math.min(...opacities) >= 0.5,
  opacities.map((o) => o.toFixed(1)).join(" "));
await call("segmentEditorThresholdPreview", [200, 3000]);
const inRange = await number("int(((slicer.util.arrayFromVolume(volume) >= 200) & (slicer.util.arrayFromVolume(volume) <= 3000)).sum())");
check("threshold: the preview is what is in the range", (await number("previewCount()")) === inRange, `${await text("str(previewCount())")} of ${inRange}`);
await call("segmentEditorShow3D", [true]);
check("threshold: shown in 3D (as binary labelmap) when the segmentation is", (await text("str(bool(previewNode().GetDisplayNode().GetVisibility3D()))")) === "True"
  && (await text("previewNode().GetDisplayNode().GetDisplayRepresentationName3D()")) === "Binary labelmap");
await call("segmentEditorShow3D", [false]);
check("threshold: and not when it is not", (await text("str(bool(previewNode().GetDisplayNode().GetVisibility3D()))")) === "False");
await call("segmentEditorApply", ["Threshold", { lower: 200, upper: 3000 }]);
check("threshold: Apply fills the segment with what was previewed", (await number("count(segA)")) === inRange);
await effectButton("None").click();
await page.waitForTimeout(800);
check("threshold: leaving the effect removes the preview",
  (await text("str(previewNode() is None and not [n for n in slicer.util.getNodesByClass('vtkMRMLSegmentationNode') if n.GetName().startswith('Threshold preview')])")) === "True");

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

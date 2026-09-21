// A model's intersection in a slice view: it is cut from the cells the slice plane crosses, found
// with a cell locator, rather than from every cell of the model (see the Slicer patch
// 0002-PERF-Cut-only-the-cells-a-slice-plane-crosses). The line drawn must be the same line, and a
// slice move must cost much less than cutting the whole model does.
// Usage: node tests/model-slice-intersection.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);
const text = async (expr) => String(await value(expr)).replace(/^'|'$/g, "");

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

await run(`
import time, slicer, vtk

s = vtk.vtkSphereSource(); s.SetThetaResolution(300); s.SetPhiResolution(300); s.SetRadius(50)
triangles = vtk.vtkTriangleFilter(); triangles.SetInputConnection(s.GetOutputPort()); triangles.Update()
mesh = vtk.vtkPolyData(); mesh.DeepCopy(triangles.GetOutput())
model = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLModelNode", "Ball")
model.SetAndObservePolyData(mesh)
model.CreateDefaultDisplayNodes()
model.GetDisplayNode().SetVisibility2D(True)

widget = slicer.app.layoutManager().sliceWidget("Red")
sliceNode = widget.sliceLogic().GetSliceNode()
view = widget.sliceView()

def moveTo(offset):
    sliceNode.SetSliceOffset(offset)
    view.forceRender()

def lineLength(polyData):
    """How long the drawn intersection is; the slice transform turns it but does not stretch it."""
    total = 0.0
    if polyData is None:
        return 0.0
    for i in range(polyData.GetNumberOfCells()):
        cell = polyData.GetCell(i)
        points = cell.GetPoints()
        for p in range(points.GetNumberOfPoints() - 1):
            total += vtk.vtkMath.Distance2BetweenPoints(points.GetPoint(p), points.GetPoint(p + 1)) ** 0.5
    return total

def drawnIntersection():
    """What the slice view draws for the model: the largest line drawing in it, the others being
    the orientation marker, the ruler and the slice intersections, which have a few points each."""
    best = None
    renderers = view.renderWindow().GetRenderers()
    for r in range(renderers.GetNumberOfItems()):
        actors = renderers.GetItemAsObject(r).GetActors2D()
        for a in range(actors.GetNumberOfItems()):
            actor = actors.GetItemAsObject(a)
            if not actor.GetVisibility():
                continue
            mapper = actor.GetMapper()
            data = mapper.GetInput() if mapper else None
            if data is not None and (best is None or data.GetNumberOfPoints() > best.GetNumberOfPoints()):
                best = data
    return best

def wholeMeshCut():
    """The same cut, from every cell of the model, as it was done before."""
    sliceToRAS = sliceNode.GetSliceToRAS()
    plane = vtk.vtkPlane()
    plane.SetOrigin(sliceToRAS.GetElement(0, 3), sliceToRAS.GetElement(1, 3), sliceToRAS.GetElement(2, 3))
    plane.SetNormal(sliceToRAS.GetElement(0, 2), sliceToRAS.GetElement(1, 2), sliceToRAS.GetElement(2, 2))
    cutter = vtk.vtkPlaneCutter(); cutter.SetPlane(plane); cutter.BuildTreeOff(); cutter.SetInputData(mesh)
    t0 = time.perf_counter()
    cutter.Update()
    elapsed = (time.perf_counter() - t0) * 1000
    # into the coordinates the view draws in, which is where the drawn line was measured: the
    # slice view scales what it draws to the field of view, so the two are only alike there
    toSlice = vtk.vtkMatrix4x4()
    vtk.vtkMatrix4x4.Invert(sliceNode.GetXYToRAS(), toSlice)
    transform = vtk.vtkTransform(); transform.SetMatrix(toSlice)
    toSliceXY = vtk.vtkTransformPolyDataFilter()
    toSliceXY.SetTransform(transform); toSliceXY.SetInputData(cutter.GetOutput()); toSliceXY.Update()
    return toSliceXY.GetOutput(), elapsed

moveTo(0.0)
moveTo(7.0)   # the locator is built once the mesh has stayed as it was
moveTo(11.0)
drawn = drawnIntersection()
reference, wholeCutMs = wholeMeshCut()
drawnPoints = drawn.GetNumberOfPoints() if drawn else 0
drawnLength = lineLength(drawn)
referenceLength = lineLength(reference)

times = []
for i in range(10):
    t0 = time.perf_counter()
    moveTo(11.0 + i * 1.7)
    times.append((time.perf_counter() - t0) * 1000)
times.sort()
moveMs = times[len(times) // 2]
cells = mesh.GetNumberOfCells()
`);

const cells = Number(await value(`cells`));
const drawnPoints = Number(await value(`drawnPoints`));
const drawnLength = Number(await value(`drawnLength`));
const referenceLength = Number(await value(`referenceLength`));
const wholeCutMs = Number(await value(`wholeCutMs`));
const moveMs = Number(await value(`moveMs`));

const referencePoints = Number(await value(`reference.GetNumberOfPoints()`));
check("the intersection is drawn", drawnPoints > 2, `${drawnPoints} points of a ${cells}-cell model`);
check("of as many points as the whole-mesh cut", drawnPoints === referencePoints, `${drawnPoints} against ${referencePoints}`);
check("it is the line the whole-mesh cut gives",
  referenceLength > 0 && Math.abs(drawnLength - referenceLength) / referenceLength < 0.01,
  `${drawnLength.toFixed(1)} long drawn, ${referenceLength.toFixed(1)} from every cell`);
check("a slice move costs less than cutting every cell", moveMs < wholeCutMs,
  `${moveMs.toFixed(1)} ms a move, ${wholeCutMs.toFixed(1)} ms to cut the whole mesh`);

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

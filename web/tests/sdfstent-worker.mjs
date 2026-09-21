// SDFStent (SlicerSimVascular) deploying a stent in the browser: svMorph computes with NumPy here,
// since jaxlib has no WebAssembly build, and the deployment runs in a worker of the page, so the
// views keep drawing while it runs.
// Usage: node tests/sdfstent-worker.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
page.on("console", (m) => { const t = m.text(); if (/job|worker|scipy|Error|error/i.test(t)) console.log("[console] " + t.slice(0, 220)); });

const index = await (await fetch(new URL("extensions/index.json", base))).json();
const entry = index.extensions.find((e) => e.name === "SimVascular");
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)),
  [new URL("extensions/" + entry.wheel, base).href]);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForFunction(() => (window.slicerWeb?.store?.modules ?? []).some((m) => m.name === "SDFStent"), null, { timeout: 180000 });
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);

// a straight vessel: a tube around a line, as a segmentation, with its centerline as a curve
await run(`
import slicer, vtk, numpy as np
line = vtk.vtkLineSource()
line.SetPoint1(0.0, 0.0, -40.0); line.SetPoint2(0.0, 0.0, 40.0); line.SetResolution(80)
tube = vtk.vtkTubeFilter()
tube.SetInputConnection(line.GetOutputPort()); tube.SetRadius(4.0); tube.SetNumberOfSides(40); tube.CappingOn()
triangles = vtk.vtkTriangleFilter(); triangles.SetInputConnection(tube.GetOutputPort()); triangles.Update()
vessel = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Vessel")
vessel.CreateDefaultDisplayNodes()
segmentId = vessel.AddSegmentFromClosedSurfaceRepresentation(triangles.GetOutput(), "Vessel wall")
centerline = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsCurveNode", "Centerline")
for z in np.linspace(-40.0, 40.0, 9):
    centerline.AddControlPoint(0.0, 0.0, float(z))
centerPoint = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "CenterPoint")
centerPoint.AddControlPointWorld(0.0, 0.0, 0.0)
_out = "vessel: %d points, centerline: %d control points" % (
    vessel.GetSegmentation().GetSegment(segmentId).GetRepresentation("Closed surface").GetNumberOfPoints(),
    centerline.GetNumberOfControlPoints())
`);
console.log(await value("_out"));

console.log(await value(`"SDFStent runs as a job: %s" % (__import__("SDFStent").SDFStentLogic.runsAsJob(),)`));

// deploy, without waiting for it: the run answers through the event loop of the page
await run(`
import SDFStent, time
logic = SDFStent.SDFStentLogic()
p = logic.getParameterNode()
p.inputVesselSegmentation = vessel
p.inputVesselSegmentId = segmentId
p.inputCenterlineCurve = centerline
p.centerPointMarkup = centerPoint
p.startRadius = 3.0
p.targetRadius = 6.0
p.stentLength = 30.0
state = {"started": time.time(), "finished": None, "error": None, "lines": []}

def onMessage(message, isError=False):
    state["lines"].append(str(message))

def onFinished(error):
    state["error"] = None if error is None else "%s: %s" % (type(error).__name__, error)
    state["finished"] = time.time()

surfaceNode, centerlineNode = logic.process(processMessageCallback=onMessage, onFinished=onFinished)
_out = "deployment started, process() returned after %.2f s" % (time.time() - state["started"])
`);
console.log(await value("_out"));

// while it runs the page is still alive: the views render and the scene answers
await page.waitForTimeout(1500);
const responsive = await page.evaluate(async () => {
  const started = Date.now();
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  return Date.now() - started;
});
console.log(`the page answers while the worker runs: a render took ${responsive} ms`);

for (let waited = 0; waited < 600; waited += 5) {
  await page.waitForTimeout(5000);
  const state = await value(`"finished=%s error=%s lines=%d busy=%s last=%s" % (
      state["finished"] is not None, state["error"], len(state["lines"]),
      __import__("slicerweb.jobs", fromlist=["x"]).busy(), state["lines"][-1] if state["lines"] else "")`);
  console.log(`  ${waited + 5}s ${state}`);
  if (String(state).includes("finished=True")) break;
}

console.log(await value(`"finished in %.1f s, error: %s" % (state["finished"] - state["started"] if state["finished"] else -1, state["error"])`));
console.log(await value(`"worker said: %s" % (" | ".join(state["lines"][-3:]) or "(nothing)")`));
console.log(await value(`"deployed surface: %s points, radius reached %.2f mm" % (
    surfaceNode.GetPolyData().GetNumberOfPoints() if surfaceNode.GetPolyData() else 0, p.actualRadius)`));
await run(`
from vtk.util.numpy_support import vtk_to_numpy
points = vtk_to_numpy(surfaceNode.GetPolyData().GetPoints().GetData()) if surfaceNode.GetPolyData() else None
_out = "the vessel wall was pushed out to %.2f mm at its widest (it started at 4.00 mm)" % (
    float(np.max(np.linalg.norm(points[:, :2], axis=1))) if points is not None and len(points) else -1.0)
`);
console.log(await value("_out"));
if (shot) await page.screenshot({ path: shot });
await browser.close();

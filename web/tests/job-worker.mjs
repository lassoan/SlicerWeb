// Jobs: work run in a worker with a Python of its own, so that the page keeps drawing.
// Usage: node tests/job-worker.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (m.type() === "error" && !/GL Driver/.test(m.text())) console.log(`[error] ${m.text().slice(0, 200)}`); });
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");

const t0 = Date.now();
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import slicer, vtk, json
from slicerweb import jobs
_state = {"done": False, "result": None, "error": None, "progress": []}
def _done(result, files):
    _state["done"] = True
    _state["result"] = result
    _state["files"] = sorted(files)
    # the mesh the job made comes back as a file and goes into the scene
    if "/work/decimated.vtp" in files:
        with open("/tmp/decimated.vtp", "wb") as f:
            f.write(files["/work/decimated.vtp"])
        node = slicer.util.loadModel("/tmp/decimated.vtp")
        _state["loadedPoints"] = node.GetMesh().GetNumberOfPoints() if node else None
def _failed(message):
    _state["done"] = True
    _state["error"] = message
def _progress(message, fraction):
    _state["progress"].append(message)

# a sphere is made and simplified in the worker, and the result comes back as a file
_code = '''
import vtk
import slicerweb_job as job
job.progress("Building the surface", 0.2)
source = vtk.vtkSphereSource(); source.SetThetaResolution(200); source.SetPhiResolution(200); source.Update()
job.progress("Simplifying it", 0.6)
decimate = vtk.vtkQuadricDecimation(); decimate.SetInputConnection(source.GetOutputPort())
decimate.SetTargetReduction(0.9); decimate.Update()
writer = vtk.vtkXMLPolyDataWriter(); writer.SetFileName("/work/decimated.vtp")
writer.SetInputData(decimate.GetOutput()); writer.Write()
result = {"before": source.GetOutput().GetNumberOfPoints(), "after": decimate.GetOutput().GetNumberOfPoints()}
'''
jobs.run(_code, outputs=["/work/decimated.vtp"], onDone=_done, onFailed=_failed, onProgress=_progress)
`));
console.log("jobs available:", await py("json.dumps(jobs.available())"));

// while the job runs, the page must still answer
let answered = 0;
let done = "False";
const deadline = Date.now() + 300000;
while (done !== "True" && Date.now() < deadline) {
  await page.waitForTimeout(400);
  await page.evaluate(() => window.slicerWeb.bridge.call("getNodes", ["vtkMRMLModelNode", false])).then(() => answered++).catch(() => {});
  done = await py("_state['done']");
}

console.log(`job finished after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log("state:", await py("json.dumps({k: str(v)[:200] for k, v in _state.items() if k != 'files'})"));
console.log("result:", await py("json.dumps(_state['result'])"));
console.log("files returned:", await py("json.dumps(_state.get('files'))"));
console.log("points of the model loaded from the job:", await py("json.dumps(_state.get('loadedPoints'))"));
console.log("progress messages:", await py("json.dumps(_state['progress'])"));
console.log("page answered", answered, "times while the job ran");
await browser.close();

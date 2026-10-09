// SlicerElastix: General Registration (Elastix) registers in the browser, with the elastix of
// ITK-Wasm in a worker of the page. A volume is registered to a shifted copy of itself with a quick
// rigid preset: the transform that comes back undoes the shift, the resampled volume has the fixed
// volume's geometry, and the page answers while it registers. The module's panel opens too.
// Usage: node tests/elastix-registration.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { const t = m.text(); if (/GL Driver|Vue warn/.test(t)) return; if (m.type() === "error" || /Traceback/.test(t)) console.log(`[${m.type()}] ${t.slice(0, 400)}`); });
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const entry = index.extensions.find((e) => e.name === "SlicerElastix");
if (!entry) { console.log("FAIL SlicerElastix is not in the extension index"); process.exit(1); }
await page.goto(base + "?sample=MRHead");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), [new URL("extensions/" + entry.wheel, base).href]);
await page.reload();
await page.waitForFunction(() => /MR-head/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

check("the module is loaded", (await py("'Elastix' in slicer.app.moduleManager().loadedModulesNames()")) === "True");

// the fixed volume, and a moving one: the same image moved by a known amount
await run(`
import slicer, json, vtk, numpy as np
import Elastix
fixed = slicer.util.getNode("MR-head")
moving = slicer.modules.volumes.logic().CloneVolume(slicer.mrmlScene, fixed, "MR-head moved")
shift = [6.0, -4.0, 3.0]
m = vtk.vtkMatrix4x4()
moving.GetIJKToRASMatrix(m)
for a in range(3):
    m.SetElement(a, 3, m.GetElement(a, 3) + shift[a])
moving.SetIJKToRASMatrix(m)
outputVolume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "Registered")
outputTransform = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLinearTransformNode", "Elastix transform")
# a quick rigid preset, enough to recover a shift
parameters = "/tmp/quick-rigid.txt"
open(parameters, "w").write("""
(FixedInternalImagePixelType "float")
(MovingInternalImagePixelType "float")
(Registration "MultiResolutionRegistration")
(Interpolator "BSplineInterpolator")
(ResampleInterpolator "FinalBSplineInterpolator")
(Resampler "DefaultResampler")
(FixedImagePyramid "FixedRecursiveImagePyramid")
(MovingImagePyramid "MovingRecursiveImagePyramid")
(Optimizer "AdaptiveStochasticGradientDescent")
(Transform "EulerTransform")
(Metric "AdvancedMattesMutualInformation")
(AutomaticScalesEstimation "true")
(AutomaticTransformInitialization "true")
(HowToCombineTransforms "Compose")
(NumberOfHistogramBins 32)
(NumberOfResolutions 3)
(MaximumNumberOfIterations 100)
(NumberOfSpatialSamples 2048)
(NewSamplesEveryIteration "true")
(ImageSampler "Random")
(BSplineInterpolationOrder 1)
(FinalBSplineInterpolationOrder 1)
(DefaultPixelValue 0)
(WriteResultImage "true")
(ResultImagePixelType "short")
(ResultImageFormat "mhd")
""")
logic = Elastix.ElastixLogic()
_log = []
logic.logCallback = _log.append
_state = {"done": False, "error": None}
def _finished(error):
    _state["done"] = True
    _state["error"] = str(error) if error else None
logic.registerVolumes(fixedVolumeNode=fixed, movingVolumeNode=moving, parameterFilenames=[parameters],
                      outputVolumeNode=outputVolume, outputTransformNode=outputTransform, onFinished=_finished)
`);
check("the registration runs in the background", (await py("json.dumps(logic.runsInBackground)")) === "true");
check("and is running after the call returned", (await py("json.dumps(logic.isRunning)")) === "true");

// while it registers, the page must keep answering
const started = Date.now();
let answered = 0;
while (Date.now() - started < 900000) {
  await page.waitForTimeout(500);
  await page.evaluate(() => window.slicerWeb.bridge.call("getNodes", ["vtkMRMLModelNode", false])).then(() => answered++).catch(() => {});
  if ((await py("json.dumps(_state['done'])")) === "true") break;
}
const seconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(`registration ${(await py("json.dumps(_state)"))} after ${seconds} s; the page answered ${answered} calls meanwhile`);
console.log("log:", (await py("json.dumps(_log)")).slice(0, 600));
check("the registration finished without error", (await py("json.dumps(_state)")) === '{"done": true, "error": null}');
check("the page answered while it ran", answered > 5, `${answered} calls`);

// the transform undoes the shift (it is the transform from the parent: fixed to moving, in RAS)
const translation = JSON.parse(await py(`json.dumps((lambda m: [round(m.GetElement(a, 3), 2) for a in range(3)])(slicer.util.arrayFromTransformMatrix(outputTransform) if False else (lambda mm: (outputTransform.GetMatrixTransformFromParent(mm), mm)[1])(vtk.vtkMatrix4x4())))`));
const expected = [6.0, -4.0, 3.0];
const error = Math.hypot(...translation.map((t, i) => Math.abs(t) - Math.abs(expected[i])));
console.log("translation found:", JSON.stringify(translation), "applied shift:", JSON.stringify(expected));
check("the transform is a linear transform", (await py("json.dumps(bool(outputTransform.IsLinear()))")) === "true");
check("and recovers the shift to within 1 mm", error < 1.0, `${error.toFixed(2)} mm off`);
const geometry = JSON.parse(await py(`json.dumps({"out": list(outputVolume.GetImageData().GetDimensions()) if outputVolume.GetImageData() else None, "fixed": list(fixed.GetImageData().GetDimensions()), "outSpacing": [round(v, 3) for v in outputVolume.GetSpacing()], "fixedSpacing": [round(v, 3) for v in fixed.GetSpacing()], "outOrigin": [round(v, 2) for v in outputVolume.GetOrigin()], "fixedOrigin": [round(v, 2) for v in fixed.GetOrigin()]})`));
check("the resampled volume has the fixed volume's geometry", JSON.stringify(geometry.out) === JSON.stringify(geometry.fixed) && JSON.stringify(geometry.outSpacing) === JSON.stringify(geometry.fixedSpacing) && JSON.stringify(geometry.outOrigin) === JSON.stringify(geometry.fixedOrigin), JSON.stringify(geometry));
const similarity = geometry.out ? Number(await py(`(lambda a, b: float(np.corrcoef(a.ravel(), b.ravel())[0, 1]))(slicer.util.arrayFromVolume(fixed).astype(float), slicer.util.arrayFromVolume(outputVolume).astype(float))`)) : 0;
check("and matches the fixed volume", similarity > 0.95, `correlation ${similarity.toFixed(3)}`);

// the module's panel opens, with its Apply button
await page.locator("[data-name='moduleTitle']").click();
await page.getByPlaceholder("Search modules").fill("General Registration (Elastix)");
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
const panelTitle = await page.locator("[data-name='moduleTitle']").innerText().catch(() => "");
check("the module panel opens", /Elastix/.test(panelTitle), panelTitle);
const applyText = await page.locator('[data-name="applyButton"] button, button[data-name="applyButton"]').first().innerText().catch(() => "");
check("with its Apply button", applyText.length > 0, applyText);
check("and a list of registration presets", Number(await py("slicer.modules.ElastixWidget.ui.registrationPresetSelector.count")) > 10);
await browser.close();
console.log(fail.length ? `${fail.length} check(s) failed` : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

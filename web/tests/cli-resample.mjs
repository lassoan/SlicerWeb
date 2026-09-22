// The Resample Scalar/Vector/DWI Volume module, which is Slicer's own C++ CLI module compiled into
// the application. vtkSlicerCLIModuleLogic runs it the way it runs a shared object module on the
// desktop - nodes out to files, entry point called, files read back - so the C++ of other modules
// can use it: Crop Volume asks the application logic for it when it crops with resampling.
// Usage: node tests/cli-resample.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 200)));
await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(5000);

const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);
const text = async (expr) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr)).replace(/^['"]|['"]$/g, "");
const call = (method, args) => page.evaluate(([m, a]) => window.slicerWeb.bridge.call(m, a), [method, args]);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

// ---------------------------------------------------------------- the module is there
check("the module is built into the application",
  (await text(`str(slicer.vtkSlicerWebCLIModule.GetModuleNames())`)) === "ResampleScalarVectorDWIVolume");
check("and its logic is where C++ looks for it",
  (await text(`str(slicer.app.applicationLogic().GetModuleLogic("ResampleScalarVectorDWIVolume") is not None)`)) === "True");

// ---------------------------------------------------------------- running it
await exec(`
import slicer
resampleInput = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]
resampleOutput = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "resampled")
resampleLogic = slicer.app.applicationLogic().GetModuleLogic("ResampleScalarVectorDWIVolume")
cmd = resampleLogic.CreateNodeInScene()
cmd.SetParameterAsString("inputVolume", resampleInput.GetID())
cmd.SetParameterAsString("outputVolume", resampleOutput.GetID())
cmd.SetParameterAsString("outputImageSpacing", "2,2,2")
cmd.SetParameterAsString("outputImageSize", "128,128,65")
cmd.SetParameterAsString("interpolationType", "linear")
resampleLogic.ApplyAndWait(cmd, False)
resampleStatus = cmd.GetStatusString()
resampleError = cmd.GetErrorText()
`);
check("it runs to completion", (await text("resampleStatus")) === "Completed",
  `${await text("resampleStatus")} ${(await text("resampleError")).slice(0, 120)}`);
check("what it wrote is read back into the output node",
  (await text(`str(resampleOutput.GetImageData().GetDimensions() if resampleOutput.GetImageData() else None)`)) === "(128, 128, 65)");
check("with the spacing that was asked for",
  (await text(`"%.2f,%.2f,%.2f" % tuple(resampleOutput.GetSpacing())`)) === "2.00,2.00,2.00");
check("and the voxels are the volume, not an empty image",
  (await text(`"%.0f" % resampleOutput.GetImageData().GetScalarRange()[1]`)) !== "0");

// ---------------------------------------------------------------- what Crop Volume needed it for
const info = await call("cropVolumeInfo", [null]);
check("Crop Volume can crop with resampling again", info.interpolatedCropAvailable === true);
check("and that is what it offers to begin with", info.voxelBased === false);

const volumeId = await text(`resampleInput.GetID()`);
await call("setCropVolumeParameters", [info.parameterNodeID, { inputVolumeID: volumeId }]);
await exec(`
parameters = slicer.mrmlScene.GetNodeByID("${info.parameterNodeID}")
parameters.SetROINodeID(slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsROINode", "Crop ROI").GetID())
slicer.app.applicationLogic().GetModuleLogic("CropVolume").FitROIToInputVolume(parameters)
`);
// half the spacing: the cropped volume has to come out with twice as many voxels along each axis
await call("setCropVolumeParameters", [info.parameterNodeID, { voxelBased: false, spacingScale: 0.5, isotropicResampling: false }]);
await page.waitForTimeout(300);
const cropped = await call("applyCropVolume", [info.parameterNodeID]);
check("cropping with resampling makes a volume", Array.isArray(cropped.dimensions) && cropped.dimensions[0] > 1,
  JSON.stringify(cropped.dimensions));
const croppedSpacing = await text(`"%.2f,%.2f,%.2f" % tuple(slicer.mrmlScene.GetNodeByID("${cropped.outputVolumeID}").GetSpacing())`);
const inputSpacing = await text(`"%.2f,%.2f,%.2f" % tuple(sorted(resampleInput.GetSpacing()))`);
check("at the spacing the scale asks for, which is half the input's",
  croppedSpacing.split(",").map(Number).sort().map((s) => s.toFixed(2)).join(",")
  === inputSpacing.split(",").map((s) => (Number(s) / 2).toFixed(2)).join(","),
  `${croppedSpacing} from ${inputSpacing}`);
check("and it holds the voxels of the volume it came from",
  (await text(`"%.0f" % slicer.mrmlScene.GetNodeByID("${cropped.outputVolumeID}").GetImageData().GetScalarRange()[1]`)) !== "0");

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

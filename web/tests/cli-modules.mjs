// CLI modules: a CLI module is a separate program in desktop Slicer, which a web page cannot start,
// so each one here is a Python implementation described by the very XML the real module ships. The
// modules appear in the module list, the panel is built from that description, and slicer.cli.run()
// reaches the same implementations, so scripted modules that use a CLI module work.
// Usage: node tests/cli-modules.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 200)));
await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(4000);

const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);
const text = async (expr) => String(await value(expr)).replace(/^['"]|['"]$/g, "");
const number = async (expr) => Number(await value(expr));
const call = (method, args) => page.evaluate(([m, a]) => window.slicerWeb.bridge.call(m, a), [method, args]);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

// ---------------------------------------------------------------- the modules are there
const modules = await page.evaluate(() => window.slicerWeb.bridge.call("getModules", []).catch(() => null));
const cli = (modules ?? []).filter((m) => m.kind === "cli");
check("the CLI modules are loaded", cli.length >= 8, cli.map((m) => m.name).join(", "));
check("with the title and category of the real module",
  cli.some((m) => m.title === "Threshold Scalar Volume" && m.categories.includes("Filtering")),
  JSON.stringify(cli.find((m) => m.name === "ThresholdScalarVolume")?.categories));

const description = await call("cliModuleDescription", ["GaussianBlurImageFilter"]);
check("the description names the parameters the module takes",
  description.groups.some((g) => g.parameters.some((p) => p.name === "sigma" && p.default === "1.0")),
  JSON.stringify(description.groups.flatMap((g) => g.parameters.map((p) => p.name))));
check("and says which ones are volumes",
  description.groups.flatMap((g) => g.parameters).filter((p) => p.nodeType === "vtkMRMLScalarVolumeNode").length === 2);

// ---------------------------------------------------------------- running one from the panel
const volumeId = await text(`slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0].GetID()`);
const input = `slicer.mrmlScene.GetNodeByID("${volumeId}")`;
const inputRange = await text(`"%.0f,%.0f" % tuple(${input}.GetImageData().GetScalarRange())`);

const blur = await call("runCliModule", ["GaussianBlurImageFilter", { inputVolume: volumeId, outputVolume: null, sigma: "3.0" }]);
const blurred = blur.outputs.outputVolume;
check("running a module makes its output volume", !!blurred, JSON.stringify(blur.outputs));
check("the output has the size and spacing of the input",
  (await text(`"%s|%s" % (slicer.mrmlScene.GetNodeByID("${blurred}").GetImageData().GetDimensions(),
                          tuple(round(s, 3) for s in slicer.mrmlScene.GetNodeByID("${blurred}").GetSpacing()))`))
  === (await text(`"%s|%s" % (${input}.GetImageData().GetDimensions(),
                              tuple(round(s, 3) for s in ${input}.GetSpacing()))`)));
// blurring narrows the range of values without moving the mean much
const blurredRange = await text(`"%.0f,%.0f" % tuple(slicer.mrmlScene.GetNodeByID("${blurred}").GetImageData().GetScalarRange())`);
check("and it is blurred, not copied", blurredRange !== inputRange, `${inputRange} became ${blurredRange}`);

// ---------------------------------------------------------------- thresholding
const threshold = await call("runCliModule", ["ThresholdScalarVolume",
  { InputVolume: volumeId, OutputVolume: null, ThresholdType: "Below", ThresholdValue: "100", OutsideValue: "0" }]);
const thresholded = threshold.outputs.OutputVolume;
const out = `slicer.mrmlScene.GetNodeByID("${thresholded}")`;
check("thresholding below a value empties the voxels under it",
  (await number(`int((slicer.util.arrayFromVolume(${out})[slicer.util.arrayFromVolume(${input}) <= 100] != 0).sum())`)) === 0);
const changed = await number(`int((slicer.util.arrayFromVolume(${out}) != slicer.util.arrayFromVolume(${input})).sum())`);
const under = await number(`int(((slicer.util.arrayFromVolume(${input}) <= 100) & (slicer.util.arrayFromVolume(${input}) != 0)).sum())`);
check("and leaves the ones above it alone", changed === under, `${changed} voxels changed, ${under} were under the threshold`);

// ---------------------------------------------------------------- arithmetic on two volumes
const subtract = await call("runCliModule", ["SubtractScalarVolumes",
  { inputVolume1: volumeId, inputVolume2: volumeId, outputVolume: null, order: "1" }]);
check("a volume subtracted from itself is empty",
  (await number(`int(abs(slicer.util.arrayFromVolume(slicer.mrmlScene.GetNodeByID("${subtract.outputs.outputVolume}"))).max())`)) === 0);

// ---------------------------------------------------------------- resampling changes the geometry
const resample = await call("runCliModule", ["ResampleScalarVolume",
  { InputVolume: volumeId, OutputVolume: null, outputPixelSpacing: "2,2,2", interpolationType: "linear" }]);
const resampled = resample.outputs.OutputVolume;
check("resampling gives the spacing that was asked for",
  (await text(`"%.2f,%.2f,%.2f" % tuple(slicer.mrmlScene.GetNodeByID("${resampled}").GetSpacing())`)) === "2.00,2.00,2.00");
check("and the volume still covers the same place",
  (await number(`max(abs(a - b) for a, b in zip(
      slicer.mrmlScene.GetNodeByID("${resampled}").GetOrigin(), ${input}.GetOrigin()))`)) < 1e-6);
check("with fewer voxels than before",
  (await number(`slicer.mrmlScene.GetNodeByID("${resampled}").GetImageData().GetNumberOfPoints()`))
  < (await number(`${input}.GetImageData().GetNumberOfPoints()`)));

// ---------------------------------------------------------------- a surface out of a volume
const model = await call("runCliModule", ["GrayscaleModelMaker",
  { InputVolume: volumeId, OutputGeometry: null, Threshold: "80", Smooth: "10", Decimate: "0.25" }]);
const surface = model.outputs.OutputGeometry;
check("a grayscale model comes out with a surface",
  (await number(`slicer.mrmlScene.GetNodeByID("${surface}").GetPolyData().GetNumberOfPoints()`)) > 1000);
// The surface has to come out in RAS, where the volume is, not in voxel coordinates: it lies
// inside the volume it was made from, rather than somewhere off at (0..255).
const inside = await text(`(lambda m, v, b=[0.0] * 6: (v.GetRASBounds(b),
    str(all(b[2 * i] - 1 <= m.GetPolyData().GetBounds()[2 * i]
            and m.GetPolyData().GetBounds()[2 * i + 1] <= b[2 * i + 1] + 1 for i in range(3))))[1])(
    slicer.mrmlScene.GetNodeByID("${surface}"), ${input})`);
const surfaceBounds = await text(`"%.0f..%.0f, %.0f..%.0f, %.0f..%.0f" % slicer.mrmlScene.GetNodeByID("${surface}").GetPolyData().GetBounds()`);
check("in the same place as the volume it came from", inside === "True", surfaceBounds);

// ---------------------------------------------------------------- masking and merging
const mask = await call("runCliModule", ["MaskScalarVolume",
  { InputVolume: volumeId, MaskVolume: thresholded, OutputVolume: null, Label: "0", Replace: "0" }]);
const masked = `slicer.mrmlScene.GetNodeByID("${mask.outputs.OutputVolume}")`;
check("masking keeps the voxels the mask marks and empties the rest",
  (await number(`int((slicer.util.arrayFromVolume(${masked})[slicer.util.arrayFromVolume(${out}) != 0] != 0).sum())`)) === 0);

const merged = await call("runCliModule", ["MergeModels", { Model1: surface, Model2: surface, ModelOutput: null }]);
check("merging two models gives one with both of them",
  (await number(`slicer.mrmlScene.GetNodeByID("${merged.outputs.ModelOutput}").GetPolyData().GetNumberOfPoints()`))
  === 2 * (await number(`slicer.mrmlScene.GetNodeByID("${surface}").GetPolyData().GetNumberOfPoints()`)));

// ---------------------------------------------------------------- what scripted modules use
check("slicer.cli.run reaches the same implementations", (await text(`
str(bool(slicer.cli.runSync(slicer.modules.castscalarvolume, None, {
    "InputVolume": ${input}.GetID(),
    "OutputVolume": slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "cast").GetID(),
    "Type": "Short"}).GetStatus() == slicer.vtkMRMLCommandLineModuleNode.Completed))`)) === "True");
// A description is shipped for every CLI module of Slicer, but only the ones with an implementation
// are offered; asking for another one says so rather than pretending it ran.
const refused = await call("runCliModule", ["N4ITKBiasFieldCorrection", {}]).then(() => "", (e) => String(e.message));
check("a module that has no implementation says so, naming itself", /N4ITK/.test(refused), refused.slice(0, 120));
check("and it is not offered as a module", !cli.some((m) => m.name === "N4ITKBiasFieldCorrection"));

// A CLI module of an extension has no description here, so it is not shown as a module, but the
// scripted modules that call it (Extract Centerline uses Decimation) still find it.
check("an implemented module with no description is still there to be run",
  (await text(`str(slicer.modules.decimation.name)`)) === "decimation");

// ---------------------------------------------------------------- the panel
if (await page.getByPlaceholder("Search modules").count() === 0) {
  await page.locator("[data-name='moduleTitle']").click();
  await page.waitForTimeout(300);
}
await page.getByPlaceholder("Search modules").fill("Median Image Filter");
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
check("a CLI module can be opened from the module finder",
  (await page.evaluate(() => window.slicerWeb.store.activeModule)) === "MedianImageFilter");
const panel = page.locator("[data-name='cliModulePanel']");
check("the panel of a CLI module is built from its description", (await panel.count()) === 1);
check("with a selector for the input volume", (await page.locator("[data-name='cli:inputVolume']").count()) > 0);
check("and an apply button", (await page.locator("[data-name='cliApply']").count()) > 0);

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

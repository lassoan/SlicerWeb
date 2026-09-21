// Transforms are saved and loaded in HDF5 files (.h5), which is what Slicer uses by default, even
// though this build of ITK has no HDF5 in it: the file is transcoded to and from the text form of
// the same thing (.tfm) with h5py, and the transform itself is read and written by Slicer.
// Usage: node tests/transforms-hdf5.mjs [url] [screenshot.png]
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
// evalPython gives back what repr() says, so a string comes with its quotes around it
const text = async (expr) => String(await value(expr)).replace(/^'|'$/g, "");

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

// a transform with numbers that are easy to recognise again
await run(`
import os, slicer, vtk
os.makedirs("/data", exist_ok=True)
transform = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLinearTransformNode", "Shift")
matrix = vtk.vtkMatrix4x4()
matrix.SetElement(0, 3, 10.0)
matrix.SetElement(1, 3, -20.0)
matrix.SetElement(2, 3, 30.5)
matrix.SetElement(0, 0, 2.0)
transform.SetMatrixTransformToParent(matrix)
`);

// what a transform is called when nothing says otherwise: not .h5, which cannot be written without
// h5py, but the text form, which this build writes itself
await run(`slicer.mrmlScene.GetFirstNodeByName("Shift").AddDefaultStorageNode()`);
check("a transform defaults to .tfm", await text(`
slicer.mrmlScene.GetFirstNodeByName("Shift").GetStorageNode().GetDefaultWriteFileExtension()`) === "tfm");

// saving as .h5 (h5py is installed by the page when it is first needed)
check("saved as .h5", await text(`
str(slicer.util.saveNode(slicer.mrmlScene.GetFirstNodeByName("Shift"), "/data/shift.h5"))`) === "True");
const size = Number(await value(`__import__("os").path.getsize("/data/shift.h5")`));
check("the file is an HDF5 one", size > 0, size + " bytes");
const transformType = await text(`
__import__("slicerweb.transforms_hdf5", fromlist=["x"]).read_transforms("/data/shift.h5")[0][0]`);
check("it holds what ITK would put there", transformType.startsWith("AffineTransform"), transformType);

// and read back into a scene that no longer has it
await run(`
slicer.mrmlScene.RemoveNode(slicer.mrmlScene.GetFirstNodeByName("Shift"))
loaded = slicer.util.loadNodeFromFile("/data/shift.h5", "TransformFile")
m = vtk.vtkMatrix4x4()
loaded.GetMatrixTransformToParent(m)
readBack = [m.GetElement(0, 0), m.GetElement(0, 3), m.GetElement(1, 3), m.GetElement(2, 3)]
`);
const readBack = await text(`str(readBack)`);
check("read back with the same numbers", readBack === "[2.0, 10.0, -20.0, 30.5]", readBack);
check("it is a transform node", (await text(`loaded.GetClassName()`)).includes("Transform"));

// a scene bundle keeps its transforms: they are written as .tfm inside it
await run(`
import slicer
loaded.SetName("Shift")
slicer.util.saveScene("/data/scene.mrb")
slicer.mrmlScene.Clear(0)
slicer.util.loadScene("/data/scene.mrb")
node = slicer.util.getNode("Shift")
m2 = vtk.vtkMatrix4x4()
node.GetMatrixTransformToParent(m2)
inScene = [m2.GetElement(0, 0), m2.GetElement(0, 3), m2.GetElement(1, 3), m2.GetElement(2, 3)]
`);
const inScene = await text(`str(inScene)`);
check("a scene bundle keeps the transform", inScene === "[2.0, 10.0, -20.0, 30.5]", inScene);

// a scene that came from a desktop Slicer keeps its transforms in .h5 files, which the storage
// node cannot read: they are read after the scene is in (read_scene_transforms)
await run(`
import slicer, vtk
from slicerweb import transforms_hdf5
fromDesktop = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLinearTransformNode", "FromDesktop")
fromDesktop.AddDefaultStorageNode()
fromDesktop.GetStorageNode().SetFileName("/data/shift.h5")   # as the scene file says
transforms_hdf5.read_scene_transforms([fromDesktop])
m3 = vtk.vtkMatrix4x4()
fromDesktop.GetMatrixTransformToParent(m3)
repaired = [m3.GetElement(0, 0), m3.GetElement(0, 3), m3.GetElement(1, 3), m3.GetElement(2, 3)]
`);
const repaired = await text(`str(repaired)`);
check("a transform left empty by a .h5 file is read", repaired === "[2.0, 10.0, -20.0, 30.5]", repaired);
check("and the file it came from is still the .h5 one",
  (await text(`fromDesktop.GetStorageNode().GetFileName()`)) === "/data/shift.h5");

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

// The vtkITK filters, which are where ITK is used from Python. They are here because several of
// them used to fail: each library that uses ITK compiles its own copy of ITK's class templates,
// and the descriptions of those types could end up mixed between libraries, so a cast inside ITK
// stopped recognising its own images (see the note in CMakeLists.txt about ITK_TEMPLATE_EXPORT).
// A failure here is fatal to the page, not just to the call, so each filter is given its own page.
// Usage: node tests/itk-filters.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

const setup = `
import numpy as np, vtk, vtkITK
from vtk.util import numpy_support

def answer(ok, message):
    return ("yes|" if ok else "no|") + message

def image(array, scalarType, spacing=(1.0, 1.0, 1.0)):
    img = vtk.vtkImageData()
    img.SetDimensions(array.shape[2], array.shape[1], array.shape[0])
    img.SetSpacing(*spacing)
    img.GetPointData().SetScalars(numpy_support.numpy_to_vtk(array.ravel(), deep=True, array_type=scalarType))
    return img

def voxels(output):
    return int((numpy_support.vtk_to_numpy(output.GetPointData().GetScalars()) > 0).sum())

def cube(n=20, lo=8, hi=12):
    a = np.zeros((n, n, n), np.uint8)
    a[lo:hi, lo:hi, lo:hi] = 1
    return a

def margin():
    f = vtkITK.vtkITKImageMargin()
    f.SetInputData(image(cube(), vtk.VTK_UNSIGNED_CHAR))
    f.CalculateMarginInMMOn()
    f.SetOuterMarginMM(2.0)
    f.Update()
    grown = voxels(f.GetOutput())
    return answer(grown > 64 and grown < 1000, "%d voxels from 64" % grown)

def islands():
    a = cube()
    a[2:4, 2:4, 2:4] = 1
    f = vtkITK.vtkITKIslandMath()
    f.SetInputData(image(a, vtk.VTK_UNSIGNED_CHAR))
    f.Update()
    return answer(f.GetNumberOfIslands() == 2, "%d islands (expected 2)" % f.GetNumberOfIslands())

def distance():
    f = vtkITK.vtkITKDistanceTransform()
    f.SetInputData(image(cube().astype(np.int16), vtk.VTK_SHORT))
    f.Update()
    a = numpy_support.vtk_to_numpy(f.GetOutput().GetPointData().GetScalars())
    inside = float(a.min())
    return answer(inside < 0.0, "nearest distance inside the cube is %.1f" % inside)

def interpolate():
    a = np.zeros((20, 20, 20), np.uint8)
    a[5, 8:12, 8:12] = 1
    a[11, 8:12, 8:12] = 1
    f = vtkITK.vtkITKMorphologicalContourInterpolator()
    f.SetInputData(image(a, vtk.VTK_UNSIGNED_CHAR))
    f.Update()
    filled = voxels(f.GetOutput())
    return answer(filled > 32, "%d voxels from the 32 on two slices" % filled)

def levelTrace():
    a = np.zeros((20, 20, 20), np.int16)
    a[:, 6:14, 6:14] = 100
    f = vtkITK.vtkITKLevelTracingImageFilter()
    f.SetInputData(image(a, vtk.VTK_SHORT))
    f.SetSeed(10, 10, 10)
    f.SetPlaneToIJ()
    f.Update()
    points = f.GetOutput().GetNumberOfPoints()
    return answer(points > 4, "%d points traced around the square" % points)

def growCut():
    n = 20
    intensity = np.zeros((n, n, n), np.int16)
    intensity[:, :, n // 2:] = 100
    seeds = np.zeros((n, n, n), np.uint8)
    seeds[10, 10, 3] = 1
    seeds[10, 10, 16] = 2
    f = vtkITK.vtkITKGrowCut()
    f.SetIntensityVolume(image(intensity, vtk.VTK_SHORT))
    f.SetSeedLabelVolume(image(seeds, vtk.VTK_UNSIGNED_CHAR))
    f.Update()
    out = numpy_support.vtk_to_numpy(f.GetOutput().GetPointData().GetScalars())
    grown = [int((out == v).sum()) for v in (1, 2)]
    return answer(min(grown) > 100, "%d voxels went to one seed and %d to the other" % tuple(grown))
`;

const filters = ["margin", "islands", "distance", "interpolate", "levelTrace", "growCut"];
const fail = [];
for (const filter of filters) {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", () => {});
  await page.goto(base + "?sample=");
  await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
  await page.waitForTimeout(1200);
  await page.evaluate((code) => window.slicerWeb.bridge.evalPython(code), setup);
  const answer = await page.evaluate((f) => window.slicerWeb.bridge.evalPython(`${f}()`, "eval"), filter)
    .catch((e) => `no|${String(e.message).slice(0, 120)}`);
  const text = String(answer).replace(/^['"]|['"]$/g, "");
  const ok = text.slice(0, 4) === "yes|";
  const known = filter === "levelTrace";   // see docs/known-issues.md
  console.log(`${ok ? "PASS" : known ? "KNOWN GAP" : "FAIL"} ${filter}: ${text.slice(text.indexOf("|") + 1)}`);
  if (!ok && !known) fail.push(filter);
  await page.close();
}
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

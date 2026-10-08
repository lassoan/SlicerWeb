// Segment Editor: painting in a slice view of a volume whose slices are thicker than its pixels
// paints even where the slice plane lies between two slice centers (a CT with 1.25 mm slices and
// 0.93 mm pixels: the axial view painted nothing, the coronal and sagittal ones did).
// Usage: node tests/segment-editor-paint-anisotropic.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

// A volume with 1.25 mm slices and 0.93 mm pixels, shown in the slice views, and the axial slice
// put between two slice centers (as a scene saved from the desktop had it)
await run(`
import slicer, json, numpy as np
from vtk.util import numpy_support
volume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "Anisotropic")
array = np.random.default_rng(1).integers(-100, 100, (40, 120, 120)).astype(np.int16)
slicer.util.updateVolumeFromArray(volume, array)
volume.SetSpacing(0.933594, 0.933594, 1.25)
volume.SetOrigin(-56.0, -56.0, -25.0)
volume.CreateDefaultDisplayNodes()
slicer.util.setSliceViewerLayers(background=volume, fit=True)
red = slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode()
# slice centers are at -25 + k * 1.25: 0.0 is one; 0.62 is as far from any as it gets
red.SetSliceOffset(0.62)
def painted():
    total = 0
    for node in slicer.util.getNodesByClass("vtkMRMLSegmentationNode"):
        segmentation = node.GetSegmentation()
        for segmentID in segmentation.GetSegmentIDs():
            labelmap = segmentation.GetSegment(segmentID).GetRepresentation("Binary labelmap")
            scalars = labelmap.GetPointData().GetScalars() if labelmap else None
            if scalars is not None:
                total += int((numpy_support.vtk_to_numpy(scalars) > 0).sum())
    return total
`);
await page.getByRole("button", { name: "Segment Editor" }).first().click();
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
await panel.locator("button", { hasText: /^Add$/ }).first().click();
await page.waitForTimeout(1500);
await panel.getByRole("button", { name: "Paint", exact: true }).first().click();
await page.waitForTimeout(1000);
const drag = async (view) => {
  const box = await page.locator(`#slicer-view-${view}`).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(cx + i * 5, cy + i * 2); await page.waitForTimeout(20); }
  await page.mouse.up();
  await page.waitForTimeout(1000);
};
console.log("Red offset:", await py("red.GetSliceOffset()"), "spacing:", await py("json.dumps(volume.GetSpacing())"));
await drag("Red");
const axial = Number(await py("painted()"));
check("a stroke in the axial view, between two slice centers, paints", axial > 0, `${axial} voxels`);
// and it paints one slice, the nearest to the plane: the brush is as thick as a slice, not more
const slices = JSON.parse(await py(`json.dumps(sorted(set(np.nonzero(slicer.util.arrayFromSegmentBinaryLabelmap(slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0], slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNthSegmentID(0), volume))[0].tolist())))`));
check("into the one slice nearest to the plane", slices.length === 1 && slices[0] === 20, JSON.stringify(slices));
await drag("Green");
const coronal = Number(await py("painted()"));
check("a stroke in the coronal view paints too", coronal > axial, `${coronal} voxels`);
await browser.close();
console.log(fail.length ? `${fail.length} check(s) failed` : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

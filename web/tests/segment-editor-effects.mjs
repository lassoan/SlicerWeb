// The effects of the Segment Editor beyond the brush: grow from seeds, fill between slices,
// margin, hollow and the logical operators, each driven from the module panel.
// Usage: node tests/segment-editor-effects.mjs [url] [screenshot.png]
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
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);
const number = async (expr) => Number(await value(expr));
const text = async (expr) => String(await value(expr)).replace(/^['"]|['"]$/g, "");
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

await run(`
import numpy as np, slicer
from vtk.util import numpy_support

volume = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]
shape = slicer.util.arrayFromVolume(volume).shape
mid = [s // 2 for s in shape]

def count(node, segmentID):
    """What the segment holds now, read from the segmentation itself."""
    labelmap = node.GetSegmentation().GetSegment(segmentID).GetRepresentation("Binary labelmap")
    scalars = labelmap.GetPointData().GetScalars() if labelmap else None
    return 0 if scalars is None else int((numpy_support.vtk_to_numpy(scalars) > 0).sum())

def segmentation(name):
    node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", name)
    node.CreateDefaultDisplayNodes()
    node.SetReferenceImageGeometryParameterFromVolumeNode(volume)
    return node

def put(node, segmentID, array):
    slicer.util.updateSegmentBinaryLabelmapFromArray(array, node, segmentID, volume)

def ball(radiusVoxels):
    a = np.zeros(shape, np.uint8)
    zz, yy, xx = np.ogrid[:shape[0], :shape[1], :shape[2]]
    a[((zz - mid[0]) ** 2 + (yy - mid[1]) ** 2 + (xx - mid[2]) ** 2) < radiusVoxels ** 2] = 1
    return a

def square(y0, y1, x0, x1, slice=0):
    a = np.zeros(shape, np.uint8)
    a[mid[0] + slice, mid[1] + y0:mid[1] + y1, mid[2] + x0:mid[2] + x1] = 1
    return a
`);

const use = async (nodeExpr, segmentExpr) => {
  const id = String(await value(`${nodeExpr}.GetID()`)).replace(/^'|'$/g, "");
  await page.evaluate(([n]) => window.slicerWeb.bridge.call("segmentEditorSetup", [n, null]), [id]);
  if (segmentExpr) {
    const segment = String(await value(segmentExpr)).replace(/^'|'$/g, "");
    await page.evaluate(([sid]) => window.slicerWeb.bridge.call("segmentEditorSelectSegment", [sid]), [segment]);
  }
};
const apply = (effect, parameters = {}) =>
  page.evaluate(([e, p]) => window.slicerWeb.bridge.call("segmentEditorApply", [e, p]), [effect, parameters])
    .then(() => true).catch((e) => String(e.message));

// --- margin and hollow, on a ball
await run(`
shapes = segmentation("Shapes")
theBall = shapes.GetSegmentation().AddEmptySegment("", "ball")
put(shapes, theBall, ball(6))
`);
await use("shapes", "theBall");
const ballVoxels = await number(`count(shapes, theBall)`);
check("margin grows the segment", (await apply("Margin", { marginMm: 2 })) === true
  && (await number(`count(shapes, theBall)`)) > ballVoxels, `${ballVoxels} -> ${await number(`count(shapes, theBall)`)}`);
const grown = await number(`count(shapes, theBall)`);
await apply("Margin", { marginMm: -2 });
const shrunk = await number(`count(shapes, theBall)`);
check("and shrinks it again", shrunk < grown && Math.abs(shrunk - ballVoxels) < ballVoxels * 0.1,
  `${grown} -> ${shrunk}, from ${ballVoxels}`);
// Slicer's shell modes say what the surface the segment has now becomes: with "outside" the shell
// is taken from within that surface, with "inside" it is added around it. Either way the middle of
// the ball is emptied out, which is what hollow means.
await run(`
def middleIsSet(node, segmentID):
    labelmap = node.GetSegmentation().GetSegment(segmentID).GetRepresentation("Binary labelmap")
    if labelmap is None:
        return False
    extent = labelmap.GetExtent()
    middle = [(extent[2 * a] + extent[2 * a + 1]) // 2 for a in range(3)]
    return labelmap.GetScalarComponentAsDouble(middle[0], middle[1], middle[2], 0) > 0
`);
const middleBefore = await text(`str(middleIsSet(shapes, theBall))`);
await apply("Hollow", { thicknessMm: 2, shellMode: "outside" });
const shell = await number(`count(shapes, theBall)`);
const middleAfter = await text(`str(middleIsSet(shapes, theBall))`);
check("hollow leaves a shell and empties the middle",
  shell > 0 && shell < shrunk && middleBefore === "True" && middleAfter === "False",
  `${shrunk} -> ${shell} voxels, middle set before: ${middleBefore}, after: ${middleAfter}`);

// --- fill between slices
await run(`
gaps = segmentation("Gaps")
gap = gaps.GetSegmentation().AddEmptySegment("", "gap")
put(gaps, gap, square(-10, 10, -10, 10) | square(-6, 6, -6, 6, slice=6))
`);
await use("gaps", "gap");
const twoSlices = await number(`count(gaps, gap)`);
const filled = (await apply("FillBetweenSlices")) === true ? await number(`count(gaps, gap)`) : -1;
check("fill between slices fills the gap", filled > twoSlices * 2, `${twoSlices} -> ${filled}`);

// --- logical operators
for (const [operation, expected] of [["add", 175], ["subtract", 75], ["intersect", 25], ["copy", 100]]) {
  await run(`
logical = segmentation("Logic-${operation}")
one = logical.GetSegmentation().AddEmptySegment("", "one")
two = logical.GetSegmentation().AddEmptySegment("", "two")
put(logical, one, square(-10, 0, -10, 0))
put(logical, two, square(-5, 5, -5, 5))
`);
  await use("logical", "one");
  const other = String(await value(`two`)).replace(/^'|'$/g, "");
  const ok = await apply("Logic", { operation, modifierSegmentID: other });
  const got = await number(`count(logical, one)`);
  check(`logical ${operation}`, ok === true && got === expected, `${got} voxels (expected ${expected})`);
}

// --- grow from seeds
await run(`
seeded = segmentation("Seeds")
inside = seeded.GetSegmentation().AddEmptySegment("", "inside")
outside = seeded.GetSegmentation().AddEmptySegment("", "outside")
put(seeded, inside, square(-2, 2, -2, 2))
put(seeded, outside, square(20, 24, 20, 24))
`);
await use("seeded", "inside");
const t0 = Date.now();
const grewOk = await apply("GrowFromSeeds");
const insideAfter = await number(`count(seeded, inside)`);
const outsideAfter = await number(`count(seeded, outside)`);
check("grow from seeds fills the region around the seeds", grewOk === true && insideAfter > 100 && outsideAfter > 100,
  `inside ${insideAfter}, outside ${outsideAfter} voxels in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
check("and what it grew stays inside the volume",
  insideAfter + outsideAfter < await number(`int(np.prod(shape))`), "");

// --- the panel offers them all
await page.getByRole("button", { name: "Segment Editor" }).first().click();
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
const offered = (await panel.innerText()).replace(/\n/g, " ");
check("the panel offers the new effects",
  ["Grow from seeds", "Fill between slices", "Margin", "Hollow", "Logical operators"].every((e) => offered.includes(e)),
  offered.slice(0, 200));

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

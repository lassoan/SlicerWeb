// Segment Editor: dragging with the brush paints, which needs the volume being segmented - the
// editor takes the one the slice views show when none is chosen - and the threshold effect offers
// the values of that volume, whichever volume it is and whatever is written into it.
// Usage: node tests/segment-editor-paint.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

await run(`
import slicer, json
def painted():
    from vtk.util import numpy_support
    nodes = slicer.util.getNodesByClass("vtkMRMLSegmentationNode")
    if not nodes:
        return -1
    # Whatever segmentation was painted into: the editor makes one of its own on entry
    total = 0
    for node in nodes:
        segmentation = node.GetSegmentation()
        for segmentID in segmentation.GetSegmentIDs():
            labelmap = segmentation.GetSegment(segmentID).GetRepresentation("Binary labelmap")
            scalars = labelmap.GetPointData().GetScalars() if labelmap else None
            if scalars is not None:
                total += int((numpy_support.vtk_to_numpy(scalars) > 0).sum())
    return total
`);

// the module (which makes a segmentation of its own on entry) and a segment to paint into
await page.getByRole("button", { name: "Segment Editor" }).first().click();
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
await panel.locator("button", { hasText: /^Add$/ }).first().click();
await page.waitForTimeout(1500);

const sourceInEditor = await py(`json.dumps(window_state) if False else str(slicer.app.layoutManager().sliceWidget("Red").mrmlSliceCompositeNode().GetBackgroundVolumeID())`);
const editorSource = await page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorState").then((s) => s.sourceVolumeNodeID));
check("the editor takes the volume the slice views show", editorSource && editorSource === sourceInEditor,
  `${editorSource} against ${sourceInEditor}`);

// paint by dragging
await panel.getByRole("button", { name: "Paint", exact: true }).first().click();
await page.waitForTimeout(1000);
const canvas = await page.locator("#slicer-view-Red").boundingBox();
const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
const drag = async (fromX, fromY, steps, dx, dy) => {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(fromX + i * dx, fromY + i * dy); await page.waitForTimeout(20); }
  await page.mouse.up();
  await page.waitForTimeout(800);
};
await drag(cx, cy, 12, 5, 2);
const afterDrag = Number(await py(`painted()`));
check("dragging the brush paints", afterDrag > 0, `${afterDrag} voxels`);

// a second stroke somewhere else adds to it
await drag(cx - 60, cy + 40, 8, 4, -3);
const afterSecond = Number(await py(`painted()`));
check("a second stroke paints as well", afterSecond > afterDrag, `${afterSecond} voxels`);

// as on desktop, a stroke shows a preview of the brushes while the mouse moves and paints on release
const yellowPixels = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["Red"]);
  const host = document.querySelector("#slicer-view-Red");
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const gl = canvas?.getContext("webgl2");
  if (!gl) return -1;
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let count = 0;
  for (let p = 0; p < pixels.length; p += 4) {
    if (pixels[p] > pixels[p + 2] + 40 && pixels[p + 1] > pixels[p + 2] + 40 && Math.abs(pixels[p] - pixels[p + 1]) < 40) count++;
  }
  return count;
});
const yellowBefore = await yellowPixels();
await page.mouse.move(cx + 40, cy - 60);
await page.mouse.down();
for (let i = 1; i <= 8; i++) { await page.mouse.move(cx + 40 + 6 * i, cy - 60); await page.waitForTimeout(20); }
await page.waitForTimeout(300);
const duringStroke = Number(await py(`painted()`));
const yellowDuring = await yellowPixels();
check("while the mouse moves the segment is not changed yet", duringStroke === afterSecond, `${duringStroke} vs ${afterSecond} voxels`);
check("and the brushes of the stroke are shown", yellowDuring > yellowBefore + 50, `${yellowDuring} vs ${yellowBefore} yellow pixels`);
await page.mouse.up();
await page.waitForTimeout(800);
const afterRelease = Number(await py(`painted()`));
check("releasing the button paints the stroke", afterRelease > afterSecond, `${afterRelease} voxels`);
const yellowAfter = await yellowPixels();
check("and removes the preview", yellowAfter < yellowBefore + 50, `${yellowAfter} vs ${yellowBefore} yellow pixels`);

// a fast stroke (mouse positions far apart) paints the same as a slow one along the same line
await run(`slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNthSegment(0).GetRepresentation("Binary labelmap").Initialize()`);
await run(`(lambda s: s.Modified())(slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0])`);
await drag(cx - 80, cy + 80, 3, 40, 0);
const fast = Number(await py(`painted()`));
await run(`slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNthSegment(0).GetRepresentation("Binary labelmap").Initialize()`);
await drag(cx - 80, cy + 80, 40, 3, 0);
const slow = Number(await py(`painted()`));
check("a fast stroke leaves no gaps", fast > 0 && Math.abs(fast - slow) <= 0.05 * slow, `${fast} vs ${slow} voxels`);
await drag(cx, cy, 12, 5, 2);
await drag(cx - 60, cy + 40, 8, 4, -3);
const afterRepaint = Number(await py(`painted()`));

// and erasing takes some of it away
await panel.getByRole("button", { name: "Erase", exact: true }).first().click();
await page.waitForTimeout(800);
await drag(cx, cy, 12, 5, 2);
const afterErase = Number(await py(`painted()`));
check("erasing takes it away again", afterErase < afterRepaint, `${afterErase} vs ${afterRepaint} voxels`);

// the threshold effect offers the values of the volume being segmented
await panel.getByRole("button", { name: "Threshold", exact: true }).first().click();
await page.waitForTimeout(1000);
const sliderRange = async () => {
  const handles = panel.locator("input[type='range']");
  const first = handles.first();
  return [Number(await first.getAttribute("min")), Number(await first.getAttribute("max")),
          Number(await handles.nth(0).inputValue()), Number(await handles.nth(1).inputValue())];
};
const volumeRange = async () => JSON.parse(await py(`json.dumps(list(slicer.util.getNode(${JSON.stringify(sourceInEditor)}).GetImageData().GetScalarRange()))`));
let [low, high, minimumValue, maximumValue] = await sliderRange();
let [volumeLow, volumeHigh] = await volumeRange();
check("the threshold slider covers the volume's values", low === volumeLow && high === volumeHigh,
  `${low}..${high} against ${volumeLow}..${volumeHigh}`);
check("and it starts a quarter of the way up it, as Slicer does",
  Math.abs(minimumValue - (low + (high - low) * 0.25)) < (high - low) / 100 && Math.abs(maximumValue - high) < (high - low) / 100,
  `${minimumValue}..${maximumValue} of ${low}..${high}`);

// when what is in the volume changes, the slider follows
await run(`
import numpy as np, slicer
volume = slicer.util.getNode(${JSON.stringify(sourceInEditor)})
array = slicer.util.arrayFromVolume(volume)
array[:] = (array // 4).astype(array.dtype)
slicer.util.arrayFromVolumeModified(volume)
`);
await page.waitForTimeout(1500);
const [newLow, newHigh, newMinimum, newMaximum] = await sliderRange();
const [changedLow, changedHigh] = await volumeRange();
check("the slider follows the volume when it is written to", newLow === changedLow && newHigh === changedHigh,
  `${newLow}..${newHigh} against ${changedLow}..${changedHigh}`);
check("and its values are inside the new range", newMinimum >= newLow && newMaximum <= newHigh && newMinimum < newMaximum,
  `${newMinimum}..${newMaximum} of ${newLow}..${newHigh}`);

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

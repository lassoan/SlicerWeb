// The session is kept as files, and saving costs what changed: a node is written only when it
// changed since the session last wrote it, a volume unchanged since it was loaded is copied as the
// file it was loaded from (not encoded), and nothing is compressed except segmentations. Restoring
// brings it all back, and saving again right after writes nothing.
// Usage: node tests/session-incremental.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}`);
};
const errors = [];
let answer = false;
const start = async (page, url) => {
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => (answer ? d.accept() : d.dismiss()));
  await page.goto(url);
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
};
const py = async (page, code) => JSON.parse(String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, ""));
const exec = (page, code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const save = async (page) => {
  const t0 = Date.now();
  const result = await page.evaluate(() => window.slicerWeb.bridge.call("saveSession"));
  console.log(`     saved in ${((Date.now() - t0) / 1000).toFixed(2)} s: ${JSON.stringify(result.nodes ?? result.reason)}, ${(result.bytes / 1048576).toFixed(1)} MB`);
  return result;
};
const files = async (page) => {
  const folder = await page.evaluate(() => window.slicerWeb.sessionDirectory);   // the tab's own
  return py(page, `__import__("json").dumps(sorted((p[len("${folder}/"):], __import__("os").path.getsize(p)) for p in (__import__("os").path.join(d, f) for d, _, fs in __import__("os").walk("${folder}") for f in fs)))`);
};

let page = await context.newPage();
await start(page, base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(3000);
await exec(page, `
import numpy as np
line = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode", "Measurement")
line.AddControlPoint(0, 0, 0)
line.AddControlPoint(10, 0, 0)
computed = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "Computed")
slicer.util.updateVolumeFromArray(computed, np.zeros((20, 64, 64), dtype=np.int16))
segmentation = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Segmentation")
# Fully specified, as the Segmentations module makes one: the display node gives the segment its color
# when it is added. A segment saved without a color gets one when it is first displayed after loading,
# which is a change that is saved.
segmentation.CreateDefaultDisplayNodes()
segmentation.GetSegmentation().AddEmptySegment("tissue")
`);

let result = await save(page);
check("first save: the loaded CT copied as loaded, the others written", result.nodes, (n) => n.copied === 1 && n.written === 3);
const kept = await files(page);
console.log("     " + kept.map(([f, b]) => `${f} (${(b / 1024).toFixed(0)} kB)`).join(", "));
const computedFile = kept.find(([f]) => /Computed|vtkMRMLScalarVolumeNode2/.test(f) && /\.nrrd$/.test(f));
check("the computed volume is written uncompressed", computedFile?.[1], (b) => b >= 20 * 64 * 64 * 2);
const segFile = kept.find(([f]) => /\.seg\.nrrd$/.test(f));
check("a segmentation is compressed", !!segFile && segFile[1] < 20 * 64 * 64, true);

result = await save(page);
check("saved again with nothing changed: nothing written", result.reason, "nothing changed");

await exec(page, `line.SetNthControlPointPosition(1, 20, 0, 0)`);
result = await save(page);
check("a curve point moved: only the curve is written", result.nodes, { written: 1, copied: 0, kept: 3 });

await exec(page, `
arr = slicer.util.arrayFromVolume(computed)
arr[5, 5, 5] = 100
slicer.util.arrayFromVolumeModified(computed)
`);
result = await save(page);
check("voxels of the computed volume changed: only that volume is written", result.nodes, { written: 1, copied: 0, kept: 3 });
// painted into the segmentation, as the Segment Editor does: only the segmentation is written
await exec(page, `
import vtkSegmentationCorePython as vtkSegmentationCore
labelmap = slicer.vtkOrientedImageData()
labelmap.SetDimensions(10, 10, 10)
labelmap.AllocateScalars(3, 1)
labelmap.GetPointData().GetScalars().Fill(1)
slicer.vtkSlicerSegmentationsModuleLogic.SetBinaryLabelmapToSegment(labelmap, segmentation, segmentation.GetSegmentation().GetNthSegmentID(0))
`);
result = await save(page);
check("painted into the segmentation: only it is written", result.nodes, { written: 1, copied: 0, kept: 3 });
// for comparison: the whole scene as one bundle, as the session was kept before
const t0 = Date.now();
await exec(page, `slicer.mrmlScene.WriteToMRB("/tmp/compare.mrb", None)`);
console.log(`     for comparison, the whole scene as one bundle: ${((Date.now() - t0) / 1000).toFixed(2)} s`);
await page.waitForTimeout(1500);
await page.evaluate(() => window.slicerWeb.flushPersistentStorage());

// restored, at the next start of the tab (a session is the tab's own)
answer = true;
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(4000);
check("restored: all four nodes, with their changes", await py(page, `__import__("json").dumps([
  sorted(n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLStorableNode") if not n.GetHideFromEditors() and (n.IsA("vtkMRMLVolumeNode") or n.IsA("vtkMRMLMarkupsNode") or n.IsA("vtkMRMLSegmentationNode"))),
  slicer.util.getNode("Measurement").GetNthControlPointPosition(1)[0],
  int(slicer.util.arrayFromVolume(slicer.util.getNode("Computed"))[5, 5, 5]),
  list(slicer.util.getNode("CT-chest").GetImageData().GetDimensions())])`),
  [["CT-chest", "Computed", "Measurement", "Segmentation"], 20, 100, [512, 512, 139]]);
result = await save(page);
check("saving right after restoring writes nothing", result.reason, "nothing changed");

check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

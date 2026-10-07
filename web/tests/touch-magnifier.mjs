// Magnifier: while control points are placed or moved with a finger, the image under the finger is
// shown enlarged in a corner of the view: the one opposite to where the finger landed, and then
// the other corner of that side when the finger comes close. With --shared, the views share one
// WebGL context (Rendering settings).
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const shared = process.argv.includes("--shared");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (m.type() === "error" && !/GL Driver/.test(m.text())) console.log(`[error] ${m.text().slice(0, 200)}`); });
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
if (shared) {
  await page.evaluate(() => { window.slicerWeb.store.settings = { ...window.slicerWeb.store.settings, "Rendering/SharedWebGLContext": true }; });
  await page.waitForTimeout(8000);
  console.log("views sharing a context:", await page.evaluate(() => window.slicerWeb.bridge.evalPython("slicer.app.layoutManager().sharedCanvas().GetNumberOfViews()", "eval")));
}
const cdp = await context.newCDPSession(page);
const box = shared
  ? await page.evaluate(() => { const r = window.slicerWeb.store.viewRects.Red; return { x: r.left, y: r.top, width: r.width, height: r.height }; })
  : await page.locator("#slicer-view-Red").boundingBox();
const point = (x, y) => ({ x, y, id: 1, radiusX: 12, radiusY: 12, force: 1 });
const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.55;
const magnifier = () => page.evaluate(() => {
  const el = document.querySelector(".rounded-full.border-2");
  if (!el) return null;
  const canvas = el.querySelector("canvas");
  const context = canvas.getContext("2d");
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) nonBlack++;
  const rect = el.getBoundingClientRect();
  return { visible: true, nonBlackFraction: +(nonBlack / (data.length / 4)).toFixed(2),
    top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) };
});
let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ": " + detail}`);
};
/** Whether the magnifier sits in the corner of the view away from the finger at (x, y): against the
 *  edges opposite to it (a phone's view is narrower than two magnifiers, so it may still be beside the finger). */
const inOppositeCorner = (m, view, x, y, margin = 12 + 2) => !!m
  && (x < view.x + view.width / 2 ? m.right >= view.x + view.width - margin : m.left <= view.x + margin)
  && (y < view.y + view.height / 2 ? m.bottom >= view.y + view.height - margin : m.top <= view.y + margin);

// place a control point with a tap (place mode on)
await page.evaluate(() => window.slicerWeb.bridge.call("placeMarkup", ["vtkMRMLMarkupsFiducialNode", "Points", true]));
await page.waitForTimeout(300);
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(cx, cy)] });
await page.waitForTimeout(250);
await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(cx + 2, cy)] });
await page.waitForTimeout(400);
const placing = await magnifier();
console.log("while placing:", JSON.stringify(placing), "finger:", Math.round(cx + 2), Math.round(cy));
check("the magnifier is in the corner opposite to the finger", inOppositeCorner(placing, box, cx + 2, cy));
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(600);
console.log("after touch end:", JSON.stringify(await magnifier()));
await page.evaluate(() => window.slicerWeb.bridge.call("setInteractionMode", ["ViewTransform"]));
await page.waitForTimeout(400);

// drag the control point
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(cx, cy)] });
await page.waitForTimeout(250);
for (let i = 1; i <= 6; i++) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(cx - i * 5, cy - i * 3)] });
  await page.waitForTimeout(120);
}
const dragging = await magnifier();
console.log("while dragging:", JSON.stringify(dragging), "finger:", Math.round(cx - 30), Math.round(cy - 18));
check("while dragging it stays on the side it started on, though the finger crossed the middle",
  !!dragging && dragging.left === placing.left && dragging.top === placing.top, JSON.stringify(dragging));
// the finger comes close to the magnifier (which is in the top corner): it moves to the bottom corner
const nearY = dragging.bottom + 10;
for (let y = cy - 18; y > nearY; y -= 10) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(cx - 30, Math.max(y, nearY))] });
  await page.waitForTimeout(60);
}
await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(cx - 30, nearY)] });
await page.waitForTimeout(300);
const moved = await magnifier();
console.log("finger near it:", JSON.stringify(moved), "finger:", Math.round(cx - 30), Math.round(nearY));
check("when the finger comes close it moves to the other corner of its side",
  !!moved && moved.left === dragging.left && moved.top > nearY, JSON.stringify(moved));
if (shot) await page.screenshot({ path: shot });
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(500);
console.log("after drag end:", JSON.stringify(await magnifier()));
// a finger that lands already moving: the first move comes at once, before the view has processed
// the press, and the magnifier must still come
await page.evaluate(() => window.slicerWeb.bridge.call("placeMarkup", ["vtkMRMLMarkupsFiducialNode", "Points", true]));
await page.waitForTimeout(300);
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(cx, cy)] });
for (let i = 1; i <= 8; i++) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(cx + i * 3, cy + i)] });
  await page.waitForTimeout(16);
}
await page.waitForTimeout(400);
const moving = await magnifier();
check("a finger that lands already moving gets the magnifier too", !!moving?.visible, JSON.stringify(moving));
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(500);
await page.evaluate(() => window.slicerWeb.bridge.call("setInteractionMode", ["ViewTransform"]));
await page.waitForTimeout(300);

// no magnifier when only panning the view
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(box.x + 20, box.y + 20)] });
await page.waitForTimeout(250);
await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(box.x + 40, box.y + 40)] });
await page.waitForTimeout(400);
console.log("while panning:", JSON.stringify(await magnifier()));
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

// and while a Segment Editor effect draws with the finger: painting in a slice view, and in the
// 3D view with "Edit in 3D views"
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import numpy as np, slicer
from slicerweb import segment_editor
volume = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]
node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Magnified")
node.CreateDefaultDisplayNodes()
node.SetReferenceImageGeometryParameterFromVolumeNode(volume)
seg = node.GetSegmentation().AddEmptySegment("", "box")
a = np.zeros(slicer.util.arrayFromVolume(volume).shape, np.uint8)
a[20:-20, 100:-100, 100:-100] = 1
slicer.util.updateSegmentBinaryLabelmapFromArray(a, node, seg, volume)
e = segment_editor.editor()
e.setup(node.GetID(), volume.GetID())
e.selectSegment(seg)
`));
await page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorSetEffect", ["Paint"]));
await page.waitForTimeout(500);
const strokeWithFinger = async (x, y) => {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(x, y)] });
  await page.waitForTimeout(250);
  for (let i = 1; i <= 4; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(x + i * 4, y)] });
    await page.waitForTimeout(120);
  }
  const during = await magnifier();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(600);
  return [during, await magnifier()];
};
let [during, after] = await strokeWithFinger(cx, cy);
check("painting with a finger in a slice view shows the magnifier", !!during?.visible, JSON.stringify(during));
check("and it goes when the finger is lifted", after === null, JSON.stringify(after));
await page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorShow3D", [true]));
await page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorSetEffectParameter", ["Paint", "EditIn3DViews", 1]));
await page.evaluate(() => window.slicerWeb.bridge.evalPython("[v for v in slicer.app.layoutManager().views().values() if v.IsA('vtkSlicerWebThreeDView')][0].GetRenderer().ResetCamera()"));
await page.waitForTimeout(3000);
const box3D = shared
  ? await page.evaluate(() => { const r = window.slicerWeb.store.viewRects["1"]; return { x: r.left, y: r.top, width: r.width, height: r.height }; })
  : await page.locator("#slicer-view-1").boundingBox();
[during, after] = await strokeWithFinger(box3D.x + box3D.width / 2, box3D.y + box3D.height / 2);
check("painting with a finger in a 3D view shows the magnifier", !!during?.visible, JSON.stringify(during));
check("and it goes when the finger is lifted", after === null, JSON.stringify(after));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "ALL PASSED");
process.exit(failures ? 1 : 0);

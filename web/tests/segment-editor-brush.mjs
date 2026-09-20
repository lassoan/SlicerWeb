// Segment Editor: the brush is drawn as a circle at the cursor in the slice views (a displayable
// manager of its own draws it), and "Show 3D" shows the segments in the 3D views.
// Usage: node tests/segment-editor-brush.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json"));

// a segmentation with one segment, and the paint effect
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
_segmentation = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Segmentation")
_segmentation.CreateDefaultDisplayNodes()
_volume = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]
slicer.modules.slicerweb_bridge_call = None
`));
await page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorSetup", [
  window.slicerWeb.bridge.evalPython('_segmentation.GetID()', "eval"), null]).catch(() => {}));
await page.evaluate(async () => {
  const b = window.slicerWeb.bridge;
  const segmentation = String(await b.evalPython('_segmentation.GetID()', "eval")).replace(/^'|'$/g, "");
  const volume = String(await b.evalPython('_volume.GetID()', "eval")).replace(/^'|'$/g, "");
  await b.call("segmentEditorSetup", [segmentation, volume]);
  await b.call("segmentEditorAddSegment");
  await b.call("segmentEditorSetBrush", [8.0, null]);
  await b.call("segmentEditorSetEffect", ["Paint"]);
});
await page.waitForTimeout(1000);
console.log("editor node:", await py('json.dumps({"effect": slicer.mrmlScene.GetSingletonNode("SegmentEditor", "vtkMRMLSegmentEditorNode").GetActiveEffectName(), "diameter": slicer.mrmlScene.GetSingletonNode("SegmentEditor", "vtkMRMLSegmentEditorNode").GetAttribute("SegmentEditorEffect.Paint.BrushAbsoluteDiameter")})'));

// the brush follows the cursor: move over the Red view and read the circle back from the view
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
def brushCircle(layoutName="Red"):
    """The brush representation of the view's segment editor displayable manager."""
    view = slicer.app.layoutManager().view(layoutName)
    manager = view.GetDisplayableManagerGroup().GetDisplayableManagerByClassName(
        "vtkSlicerWebSegmentEditorDisplayableManager")
    if manager is None:
        return None
    bounds = list(manager.GetBrushRepresentation().GetBounds())
    if bounds[1] < bounds[0]:
        return {"visible": False}
    return {"visible": True,
            "centre": [round((bounds[0] + bounds[1]) / 2, 1), round((bounds[2] + bounds[3]) / 2, 1)],
            "diameterPixels": round(bounds[1] - bounds[0], 1)}
`));
const box = await page.locator("#slicer-view-Red").boundingBox();
for (const [fx, fy] of [[0.4, 0.5], [0.6, 0.4]]) {
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(600);
  console.log(`cursor at (${Math.round(box.width * fx)}, ${Math.round(box.height * (1 - fy))}):`, await py("json.dumps(brushCircle())"));
}
// zoom in: the brush keeps its size in millimetres, so the circle grows on screen
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
_sliceNode = slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeRed")
_sliceNode.SetFieldOfView(_sliceNode.GetFieldOfView()[0] / 2, _sliceNode.GetFieldOfView()[1] / 2, _sliceNode.GetFieldOfView()[2])
`));
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(800);
console.log("after zooming in x2:      ", await py("json.dumps(brushCircle())"));
// the circle must actually be on the screen: count its colour in the rendered view
const yellowPixels = async () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["Red"]);
  const view = document.querySelector("#slicer-view-Red");
  const canvas = view.matches("canvas") ? view : view.querySelector("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > 150 && pixels[i + 1] > 150 && pixels[i + 2] < 110) count++;
  }
  return count;
});
console.log("brush pixels on screen:", await yellowPixels());
if (shot) await page.screenshot({ path: shot, clip: box });

// Show 3D
console.log("closed surface before:", await py('json.dumps(bool(_segmentation.GetSegmentation().ContainsRepresentation("Closed surface")))'));
await page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorShow3D", [true]));
await page.waitForTimeout(1500);
console.log("closed surface after Show 3D:", await py('json.dumps(bool(_segmentation.GetSegmentation().ContainsRepresentation("Closed surface")))'));
await browser.close();

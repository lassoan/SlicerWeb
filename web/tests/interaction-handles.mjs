// Interaction handles of markups in the 3D view: the boxes, arrows and rings that a markup is
// moved, rotated and resized with. They are drawn by a renderer of their own, in a layer above the
// view, and they are sized for the camera of that renderer - which is not the camera the view ends
// up looking through unless the layers are pointed at it (see vtkSlicerWebView::SyncLayerCameras).
// When they are not, the handles come out a hundred times too small: there, but invisible.
// Usage: node tests/interaction-handles.mjs [url] [screenshot.png]
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
const render = async () => {
  await page.evaluate(() => window.slicerWeb.bridge.call("renderView", ["1"]));
  await page.waitForTimeout(600);
};

await run(`
import slicer, vtk
roi = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsROINode", "ROI")
roi.SetCenter(0.0, 0.0, 0.0); roi.SetSize(100.0, 100.0, 60.0)
roi.CreateDefaultDisplayNodes()
view = slicer.app.layoutManager().threeDWidget(0).threeDView()._view
dm = view.GetDisplayableManagerGroup().GetDisplayableManagerByClassName("vtkMRMLMarkupsDisplayableManager")
rep = dm.GetInteractionWidget(roi.GetDisplayNode()).GetRepresentation()

def handleScale():
    """The size in millimetres that one handle is drawn at (what the glyph mapper scales by)."""
    props = vtk.vtkPropCollection()
    rep.GetActors(props)
    instances = props.GetItemAsObject(0).GetMapper().GetInput()
    return instances.GetPointData().GetArray("scale").GetValue(0)
`);
await page.evaluate(() => window.slicerWeb.bridge.call("resetThreeDViews"));
await page.waitForTimeout(800);
await render();
await render();

// The handles are sized in millimetres for the camera of the layer they are drawn in: a handle is
// a few percent of the screen, so its size in mm follows the distance the view is looking from.
console.log(await value(`"handle renderer looks through the view camera: %s" % (
    rep.GetRenderer().GetActiveCamera() is view.GetRenderer().GetActiveCamera())`));
const handleScale = async () => Number(await value("handleScale()"));
const cameraDistance = async () => Number(await value("view.GetRenderer().GetActiveCamera().GetDistance()"));

const near = { distance: await cameraDistance(), scale: await handleScale() };
console.log(`camera at ${near.distance.toFixed(0)} mm: handles are ${near.scale.toFixed(1)} mm`);

// Twice as far away, the handles have to be twice as large to stay the same size on the screen.
await run("view.GetRenderer().GetActiveCamera().Dolly(0.5); view.GetRenderer().ResetCameraClippingRange()");
await render();
await render();
const far = { distance: await cameraDistance(), scale: await handleScale() };
console.log(`camera at ${far.distance.toFixed(0)} mm: handles are ${far.scale.toFixed(1)} mm`);
console.log("handle size follows the camera:",
  Math.abs(far.scale / near.scale - far.distance / near.distance) < 0.1);

// and they are big enough to be seen and hit: a few percent of the view, not a tenth of a pixel
const viewHeightMm = await value("2.0 * view.GetRenderer().GetActiveCamera().GetDistance() * __import__('math').tan(__import__('math').radians(view.GetRenderer().GetActiveCamera().GetViewAngle() / 2.0))");
console.log("handle glyph scale as a share of the view height:", (far.scale / Number(viewHeightMm) * 100).toFixed(1) + "%");

// what is on the screen around the corner of the ROI, where a scale handle sits
const drawn = await page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const view = document.querySelector("#slicer-view-1");
  const canvas = view.matches("canvas") ? view : view.querySelector("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  // the handles are near-white or saturated; the background is a blue gradient and the ROI is pink
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (r > 200 && g > 200 && b > 200) count++;
  }
  return count;
});
console.log("handle pixels (near white) in the 3D view:", drawn);
if (shot) await page.screenshot({ path: shot, clip: await page.locator("#slicer-view-1").boundingBox() });
await browser.close();

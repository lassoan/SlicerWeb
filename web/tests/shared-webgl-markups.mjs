// Markups look the same whether the views share one WebGL context or not: control points, lines
// and labels are drawn where they are in every slice view and in the 3D view.
// Usage: node tests/shared-webgl-markups.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);
const shared = (on) => page.evaluate((v) => { window.slicerWeb.store.settings = { ...window.slicerWeb.store.settings, "Rendering/SharedWebGLContext": v }; }, on);

await page.goto(base + "?sample=MRHead&layout=FourUp");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(4000);

// A line and two labelled points around the middle of the head, and the slices through the first
await exec(`
import slicer
volume = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]
b = [0.0] * 6
volume.GetRASBounds(b)
c = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2]
line = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode", "L")
line.CreateDefaultDisplayNodes()
line.AddControlPoint(c[0] - 30, c[1], c[2])
line.AddControlPoint(c[0] + 30, c[1] + 20, c[2])
points = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "P")
points.CreateDefaultDisplayNodes()
points.AddControlPoint(c[0], c[1] - 25, c[2], "label one")
points.AddControlPoint(c[0] - 20, c[1] + 30, c[2], "label two")
slicer.vtkMRMLSliceNode.JumpAllSlices(slicer.mrmlScene, c[0] - 30, c[1], c[2], 0)
# the box of the 3D view around the head (a view made before the head was loaded has a default one)
slicer.app.layoutManager().threeDWidget(0).threeDView().resetFocalPoint()
`);
await page.evaluate(() => window.slicerWeb.bridge.call("setInteractionMode", ["ViewTransform"]));
const showMarkups = (on) => exec(`
for n in slicer.util.getNodesByClass("vtkMRMLMarkupsNode"):
    n.GetDisplayNode().SetVisibility(${on ? "True" : "False"})
`);

const VIEWS = ["Red", "Yellow", "Green", "1"];
/** Each view as the page shows it, away from the pointer. */
async function capture() {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(2500);
  const out = {};
  for (const name of VIEWS) {
    const r = await page.evaluate((n) => {
      const own = document.querySelector(`#slicer-view-${n}`);
      if (own) { const b = own.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; }
      return window.slicerWeb.store.viewRects[n] ?? null;
    }, name);
    if (!r) continue;
    // inside the frame: the header bar and the border are the page's, not the view's
    const clip = { x: Math.ceil(r.left) + 2, y: Math.ceil(r.top) + 24, width: Math.floor(r.width) - 4, height: Math.floor(r.height) - 28 };
    out[name] = { clip, png: (await page.screenshot({ clip })).toString("base64") };
  }
  return out;
}
/** How many pixels differ clearly between two captures of a view. */
const differing = (a, b) => page.evaluate(async ([pa, pb]) => {
  const load = async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  };
  const [ia, ib] = [await load(pa), await load(pb)];
  if (ia.width !== ib.width || ia.height !== ib.height) return -1;
  let n = 0;
  for (let i = 0; i < ia.data.length; i += 4) {
    const d = Math.max(Math.abs(ia.data[i] - ib.data[i]), Math.abs(ia.data[i + 1] - ib.data[i + 1]), Math.abs(ia.data[i + 2] - ib.data[i + 2]));
    if (d > 60) n++;
  }
  return n;
}, [a, b]);

await showMarkups(false);
const plain = await capture();
await showMarkups(true);
const own = await capture();
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-own.png") });

// the 3D view is made anew when the mode changes, and its camera reset: it is put back where it was
const camera = await py('__import__("json").dumps([list(c.GetPosition()), list(c.GetFocalPoint()), list(c.GetViewUp()), c.GetViewAngle()] if (c := slicer.util.getNodesByClass("vtkMRMLCameraNode")[0].GetCamera()) else [])');
await shared(true);
await page.waitForTimeout(8000);
await exec(`
import json
p, f, u, a = json.loads(${JSON.stringify(camera)})
node = slicer.util.getNodesByClass("vtkMRMLCameraNode")[0]
node.SetPosition(p); node.SetFocalPoint(f); node.SetViewUp(u); node.SetViewAngle(a)
node.ResetClippingRange()
`);
check("the views share one canvas", await py("slicer.app.layoutManager().sharedCanvas().GetNumberOfViews()") === "4");
const sharedShots = await capture();
if (shot) await page.screenshot({ path: shot });

for (const name of VIEWS) {
  if (!own[name] || !sharedShots[name]) { check(`view ${name} is shown in both modes`, false); continue; }
  const markupPixels = await differing(plain[name].png, own[name].png);
  const wrong = await differing(own[name].png, sharedShots[name].png);
  // the markups are there in this view (a few hundred pixels), and drawn the same in both modes
  check(`view ${name}: the markups drawn in the same place with a shared context`,
    markupPixels > 50 && wrong >= 0 && wrong < markupPixels * 0.2,
    `${markupPixels} pixels of markups, ${wrong} pixels differ between the modes`);
}

// a point placed with a click lands under the pointer, in a view that is not the first on the canvas
{
  // the point goes to the point list that is the active place node (P, the last one made), as on the desktop
  await page.evaluate(() => window.slicerWeb.bridge.call("placeMarkup", ["vtkMRMLMarkupsFiducialNode"]));
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => window.slicerWeb.store.viewRects.Yellow);
  const [x, y] = [Math.round(r.left + r.width * 0.37), Math.round(r.top + r.height * 0.62)];
  await page.mouse.move(x - 5, y - 5);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(800);
  await exec(`
import json, vtk
node = slicer.mrmlScene.GetNodeByID(slicer.app.applicationLogic().GetSelectionNode().GetActivePlaceNodeID())
rasToXY = vtk.vtkMatrix4x4()
vtk.vtkMatrix4x4.Invert(slicer.mrmlScene.GetNodeByID("vtkMRMLSliceNodeYellow").GetXYToRAS(), rasToXY)
slicer._placedXY = json.dumps(rasToXY.MultiplyPoint(list(node.GetNthControlPointPositionWorld(node.GetNumberOfControlPoints() - 1)) + [1.0])[:2])
`);
  const xy = JSON.parse(await py("slicer._placedXY"));
  const expected = [x - r.left, r.top + r.height - y];
  const off = Math.hypot(xy[0] - expected[0], xy[1] - expected[1]);
  check("a point placed with a click in the Yellow view lands under the pointer", off < 3, `${off.toFixed(1)} px away`);
  await page.evaluate(() => window.slicerWeb.bridge.call("setInteractionMode", ["ViewTransform"]));
  // the point placed is taken away again, so that the views are compared as they were
  await exec(`n = slicer.mrmlScene.GetNodeByID(slicer.app.applicationLogic().GetSelectionNode().GetActivePlaceNodeID())
n.RemoveNthControlPoint(n.GetNumberOfControlPoints() - 1)`);
}

// and back: the views made anew with contexts of their own draw as they did at first
await shared(false);
await page.waitForTimeout(8000);
await exec(`
import json
p, f, u, a = json.loads(${JSON.stringify(camera)})
node = slicer.util.getNodesByClass("vtkMRMLCameraNode")[0]
node.SetPosition(p); node.SetFocalPoint(f); node.SetViewUp(u); node.SetViewAngle(a)
node.ResetClippingRange()
`);
const ownAgain = await capture();
if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-own-again.png") });
for (const name of VIEWS) {
  if (!ownAgain[name]) continue;
  const wrong = await differing(own[name].png, ownAgain[name].png);
  console.log(`     view ${name}: ${wrong} pixels differ from the first capture with contexts of their own`);
}
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

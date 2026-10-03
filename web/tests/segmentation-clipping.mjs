// Segmentations module: the "Clipping" section of the display settings, as the desktop's segmentation display widget
// has it - clipping on and off, the cap and outline, the clip node, and the nodes that clip with the side they keep.
// Usage: node tests/segmentation-clipping.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
page.on("console", (m) => { if (/error|Error/.test(m.text()) && !/GL Driver/.test(m.text())) console.log("[console] " + m.text().slice(0, 300)); });
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

// A segmentation with a ball, shown in 3D as binary labelmap
await run(`
import numpy as np, slicer
volume = slicer.util.getNode("CT-chest")
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Segmentation")
seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(volume)
segmentId = seg.GetSegmentation().AddEmptySegment("ball", "ball", (0.1, 0.9, 0.1))
shape = slicer.util.arrayFromVolume(volume).shape
k, j, i = np.indices(shape)
c = np.array(shape) // 2
slicer.util.updateSegmentBinaryLabelmapFromArray((((k - c[0]) ** 2 + (j - c[1]) ** 2 + (i - c[2]) ** 2) < 30 ** 2).astype(np.uint8), seg, segmentId, volume)
seg.GetDisplayNode().SetPreferredDisplayRepresentationName3D("Binary labelmap")
`);
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Segmentations"; });
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
const section = panel.locator("[data-name=clippingSection]");
check("the Display section has a Clipping section", (await section.count()) === 1);
check("there is no clip node at first", (await py(`slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLClipNode") is None`)) === "True");
await section.getByText("Clipping", { exact: true }).first().click();   // expand it
await page.waitForTimeout(1500);
const display0 = `slicer.util.getNode("Segmentation").GetDisplayNode()`;
check("opening the Clipping section makes a clip node for the segmentation", (await py(`${display0}.GetClipNode() is not None`)) === "True");
const order = await section.evaluate((el) => [...el.querySelectorAll("[data-name]")].map((e) => e.getAttribute("data-name"))
  .filter((n) => ["clippingEnabled", "clippingNodeRow", "clipType", "clippingCapSurface", "clippingOutline", "clippingAdvanced"].includes(n)));
check("the options are in order: Clipping, nodes, type, cap, outline, advanced",
  JSON.stringify([...new Set(order)]) === JSON.stringify(["clippingEnabled", "clippingNodeRow", "clipType", "clippingCapSurface", "clippingOutline", "clippingAdvanced"]),
  JSON.stringify([...new Set(order)]));
check("the clip node selector is in the Advanced section, which is collapsed", !(await section.locator("[data-name=clipNodeSelector]").isVisible()));

const display = `slicer.util.getNode("Segmentation").GetDisplayNode()`;
await section.locator("[data-name=clippingEnabled]").click();
await page.waitForTimeout(800);
check("the Clipping check box turns clipping on", (await py(`${display}.GetClipping()`)) === "1");
const capBefore = await py(`${display}.GetClippingCapSurface()`);
await section.locator("[data-name=clippingCapSurface]").click();
await page.waitForTimeout(800);
const capAfter = await py(`${display}.GetClippingCapSurface()`);
check("Cap visibility switches the cap", capAfter !== capBefore, `${capBefore} -> ${capAfter}`);

// The red slice clipping
const rows = section.locator("[data-name=clippingNodeRow]");
check("with a row for adding a clipping node", (await rows.count()) === 1);
await rows.first().locator("select").selectOption("vtkMRMLSliceNodeRed");
await page.waitForTimeout(1500);
const clipNodeState = `(lambda c: f"{c.GetNumberOfClippingNodes()} {c.GetNthClippingNodeID(0)} {c.GetNthClippingNodeState(0)}")(${display}.GetClipNode())`;
check("choosing the red slice makes it clip, keeping its positive side", (await py(clipNodeState)) === "1 vtkMRMLSliceNodeRed 1", await py(clipNodeState));
check("and another row is offered", (await rows.count()) === 2);
const stateButtons = await rows.first().locator("button[data-state]").evaluateAll((buttons) =>
  buttons.map((b) => ({ state: b.dataset.state, text: b.textContent.trim(), icon: b.querySelector("img")?.getAttribute("src") ?? "", tip: b.title })));
check("each clipping node has negative, positive, off buttons, as on desktop", JSON.stringify(stateButtons.map((b) => b.state)) === '["negative","positive","off"]',
  JSON.stringify(stateButtons.map((b) => b.state)));
check("with icons and tooltips, without text", stateButtons.every((b) => /svg/.test(b.icon) && b.tip && !b.text), JSON.stringify(stateButtons));
const typeButtons = await section.locator("[data-name=clipType] button").evaluateAll((buttons) =>
  buttons.map((b) => ({ type: b.dataset.type, text: b.textContent.trim(), icon: b.querySelector("img")?.getAttribute("src") ?? "" })));
check("the clipping type is chosen with Union and Intersection buttons with icons",
  JSON.stringify(typeButtons.map((b) => [b.type, b.text])) === '[["union","Union"],["intersection","Intersection"]]' && typeButtons.every((b) => /svg/.test(b.icon)),
  JSON.stringify(typeButtons));
const iconsLoaded = await section.locator("img").evaluateAll((images) => images.every((i) => i.complete && i.naturalWidth > 0));
check("the icons are loaded", iconsLoaded);
await rows.first().locator("[data-state=negative]").click();
await page.waitForTimeout(1500);
check("Negative keeps the other side", (await py(clipNodeState)) === "1 vtkMRMLSliceNodeRed 2", await py(clipNodeState));

// The surfaces computed on the GPU are clipped by the plane
await page.evaluate(() => window.slicerWeb.bridge.call("renderView", ["1"]));
await page.waitForTimeout(1000);
const planes = `[a.GetMapper().GetClippingPlanes().GetNumberOfItems() if a.GetMapper().GetClippingPlanes() else 0 for a in slicer.app.layoutManager().threeDWidget(0).threeDView().renderWindow().GetRenderers().GetFirstRenderer().GetActors() if a.GetMapper() and a.GetMapper().IsA("vtkSegmentationLabelmapSurfaceMapper")]`;
check("the segmentation is clipped in 3D views", (await py(planes)) === "[1]", await py(planes));

// Outline visibility: the curve where the clipping plane cuts the surface, in the edge color (black)
const darkPixels = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const gl = canvas?.getContext("webgl2");
  if (!gl) return -1;
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let count = 0;
  for (let p = 0; p < pixels.length; p += 4) if (pixels[p] < 25 && pixels[p + 1] < 25 && pixels[p + 2] < 25) count++;
  return count;
});
await run(`
v = slicer.app.layoutManager().threeDWidget(0).threeDView()
v.resetFocalPoint(); v.resetCamera()
c = v.renderWindow().GetRenderers().GetFirstRenderer().GetActiveCamera(); c.Elevation(40); c.OrthogonalizeViewUp(); c.Zoom(4)
`);
const darkWithoutOutline = await darkPixels();
await section.locator("[data-name=clippingOutline]").click();
await page.waitForTimeout(1500);
check("Outline visibility sets the outline", (await py(`${display}.GetClippingOutline()`)) === "True");
const darkWithOutline = await darkPixels();
check("and the outline of the cut is drawn", darkWithOutline > darkWithoutOutline + 100, `${darkWithoutOutline} -> ${darkWithOutline} dark pixels`);
if (process.argv.find((a) => a.endsWith(".png"))) await page.locator("#slicer-view-1").screenshot({ path: process.argv.find((a) => a.endsWith(".png")) });

// Union / intersection
await section.locator("[data-name=clipType] [data-type=union]").click();
await page.waitForTimeout(800);
check("Union sets the clipping type", (await py(`${display}.GetClipNode().GetClipType()`)) === "1");

// The clip type with two clipping nodes: the surfaces computed on the GPU keep the same region as the closed surfaces.
// Union clips away the union of what the nodes clip away, intersection only the intersection of it.
const greenPixels = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const gl = canvas.getContext("webgl2");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let count = 0;
  for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 1] > pixels[p] + 40 && pixels[p + 1] > pixels[p + 2] + 40) count++;
  return count;
});
await run(`
import slicer
seg = slicer.util.getNode("Segmentation")
d = seg.GetDisplayNode()
seg.CreateClosedSurfaceRepresentation()
d.SetClippingOutline(False); d.SetClippingCapSurface(True)
c = d.GetClipNode()
c.RemoveAllClippingNodeIDs()
for name in ("Red", "Yellow"):
    sliceNode = slicer.app.layoutManager().sliceWidget(name).mrmlSliceNode()
    c.AddAndObserveClippingNodeID(sliceNode.GetID())
    c.SetClippingNodeState(sliceNode.GetID(), slicer.vtkMRMLClipNode.ClipPositiveSpace)
v = slicer.app.layoutManager().threeDWidget(0).threeDView()
v.resetFocalPoint(); v.resetCamera()
cam = v.renderWindow().GetRenderers().GetFirstRenderer().GetActiveCamera(); cam.Azimuth(35); cam.Elevation(25); cam.OrthogonalizeViewUp()
`);
const kept = {};
for (const clipType of ["union", "intersection"]) {
  await run(`slicer.util.getNode("Segmentation").GetDisplayNode().GetClipNode().SetClipType(slicer.vtkMRMLClipNode.Clip${clipType === "union" ? "Union" : "Intersection"})`);
  for (const representation of ["Closed surface", "Binary labelmap"]) {
    await run(`slicer.util.getNode("Segmentation").GetDisplayNode().SetPreferredDisplayRepresentationName3D("${representation}")`);
    await page.waitForTimeout(1500);
    kept[`${clipType} ${representation}`] = await greenPixels();
  }
}
console.log("     segment pixels:", JSON.stringify(kept));
for (const clipType of ["union", "intersection"]) {
  const closed = kept[`${clipType} Closed surface`];
  const gpu = kept[`${clipType} Binary labelmap`];
  check(`${clipType}: the surfaces computed on the GPU are clipped as the closed surfaces`, closed > 500 && Math.abs(gpu - closed) < 0.2 * closed, `${gpu} vs ${closed} pixels`);
}
check("union keeps less than intersection", kept["union Binary labelmap"] < 0.9 * kept["intersection Binary labelmap"],
  `${kept["union Binary labelmap"]} vs ${kept["intersection Binary labelmap"]} pixels`);

// Turning clipping off
await section.locator("[data-name=clippingEnabled]").click();
await page.waitForTimeout(1000);
await page.evaluate(() => window.slicerWeb.bridge.call("renderView", ["1"]));
check("unchecking Clipping turns it off", (await py(`${display}.GetClipping()`)) === "0");
check("and the segmentation is not clipped", (await py(planes)) === "[0]", await py(planes));

await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

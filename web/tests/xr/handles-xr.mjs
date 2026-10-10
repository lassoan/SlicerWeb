// Markups' interaction handles in the headset: the panel's Handles button shows them (and hides
// them); the controller's tip in a handle highlights it (as Slicer highlights a handle under the
// mouse), and the trigger drags it: a translation arrow moves the markup along its axis, a rotation
// ring turns it about its axis, a plane's scale handle moves that side of the plane.
//
// Usage: node tests/xr/handles-xr.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=&layout=OneUp3D";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => {
  if (m.type() === "error") console.log(`[error] ${m.text().slice(0, 300)}`);
});
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const python = (expression) => page.evaluate((e) => window.slicerWeb.bridge.evalPython(e, "eval"), expression);
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
let time = 0;
const frames = (count) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start: (time += count * 14) });
const trigger = (type) => page.evaluate((type) => window.__xrMock.session.dispatch(type, { inputSource: window.__xrMock.controller }), type);
/** Puts the controller where its tip is at this point of Slicer's coordinates. */
const tipTo = (world) => page.evaluate((world) => {
  const { M } = window.slicerXR.internals;
  const room = M.point(M.invert(window.slicerXR.session.worldFromRoom), world);
  window.__xrMock.controllerPosition = [room[0], room[1], room[2] + 0.075]; // the tip is 7.5 cm ahead (-z)
}, world);
/** Moves the controller by this much in the room (metres). */
const moveBy = (d) => page.evaluate((d) => {
  const p = window.__xrMock.controllerPosition;
  window.__xrMock.controllerPosition = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
}, d);
/** A handle of the plane, as slicer_xr.py sees it: [componentType, index, kind, where, tolerance]. */
const handle = (type, index) => python(`[list(h[:3]) + [h[3]] for h in slicerXR._handles(slicer.util.getNode('Plane'), slicer.util.getNode('Plane').GetDisplayNode()) if h[0] == ${type} and h[1] == ${index}][0]`)
  .then((s) => JSON.parse(s.replace(/\(/g, "[").replace(/\)/g, "]").replace(/'/g, '"')));
const active = () => python("(lambda d: [d.GetActiveComponentType(), d.GetActiveComponentIndex()])(slicer.util.getNode('Plane').GetDisplayNode())");
const point0 = () => python("list(slicer.util.getNode('Plane').GetNthControlPointPositionWorld(0))").then(JSON.parse);
const normal = () => python("(lambda n: (n.GetNormalWorld(v), v)[1])(slicer.util.getNode('Plane')) if (v := [0.0, 0.0, 0.0]) is not None else None").then(JSON.parse);

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(2);

// A plane square to the room's floor... standing in front of the viewer: in Slicer's R-S plane
await exec(`
plane = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsPlaneNode", "Plane")
plane.SetPlaneType(slicer.vtkMRMLMarkupsPlaneNode.PlaneType3Points)
for p in ([-40, 0, -40], [40, 0, -40], [-40, 0, 40]): plane.AddControlPoint(p)
`);
await frames(2);
check(await python("slicer.util.getNode('Plane').GetDisplayNode().GetTranslationHandleVisibility()") === "False", "a plane shows no translation handles at first (Slicer's default)");
await page.evaluate(() => window.slicerXR.session.press({ id: "handles" }));
await frames(2);
const d = "slicer.util.getNode('Plane').GetDisplayNode()";
check(await python(`[${d}.GetHandlesInteractive(), ${d}.GetTranslationHandleVisibility(), ${d}.GetRotationHandleVisibility()]`) === "[True, True, True]", "the panel's Handles button shows them all");

// The X translation arrow: highlighted, and dragged 3 cm along its axis (and 3 cm across, which it ignores)
const arrow = await handle(6, 0);
const [a, b] = arrow[3];
const arrowMiddle = a.map((v, i) => (v + b[i]) / 2);
await tipTo(arrowMiddle);
await frames(2);
check(await active() === "[6, 0]", `the tip in the X translation arrow highlights it (${await active()})`);
const before = await point0();
await trigger("selectstart");
await frames(1);
const mmPerMetre = await page.evaluate(() => window.slicerXR.internals.M.scaleOf(window.slicerXR.session.worldFromRoom));
// Slicer's +R is the room's -x: moving the controller 3 cm to the left drags along +R; 3 cm up is across the arrow
await moveBy([-0.03, 0.03, 0]);
await frames(2);
await trigger("selectend");
await frames(1);
const after = await point0();
check(Math.abs(after[0] - before[0] - 0.03 * mmPerMetre) < 0.5 && Math.abs(after[2] - before[2]) < 0.5,
  `dragging it moves the plane along its X axis only (${(after[0] - before[0]).toFixed(1)} mm along, ${(after[2] - before[2]).toFixed(1)} mm across)`);
const status = await page.evaluate(() => window.slicerXR.session.panel.status);
check(/Plane/.test(status), `the panel says what was moved (${status})`);

// A rotation ring: dragged a quarter of the way round, the plane turns about that axis
const ring = await handle(5, 2);
const [center, axis, radius] = ring[3];
// A point on the ring, and one a little further round it (the ring is about the plane's normal axis)
const perpendicular = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
const u = [axis[1] * perpendicular[2] - axis[2] * perpendicular[1], axis[2] * perpendicular[0] - axis[0] * perpendicular[2], axis[0] * perpendicular[1] - axis[1] * perpendicular[0]];
const ul = Math.hypot(...u);
const w = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]].map((v) => v / ul);
// 45 degrees round from u (at u itself this ring crosses another one)
const onRing = center.map((c, i) => c + ((u[i] / ul + w[i]) / Math.SQRT2) * radius);
await tipTo(onRing);
await frames(2);
check(await active() === "[5, 2]", `the tip on a rotation ring highlights it (${await active()})`);
const normalBefore = await python("(lambda n: [n.GetInteractionHandleToWorldMatrix().GetElement(r, 0) for r in range(3)])(slicer.util.getNode('Plane'))").then(JSON.parse);
await trigger("selectstart");
await frames(1);
const quarterRound = center.map((c, i) => c + ((w[i] - u[i] / ul) / Math.SQRT2) * radius);
await tipTo(quarterRound);
await frames(2);
await trigger("selectend");
await frames(1);
const normalAfter = await python("(lambda n: [n.GetInteractionHandleToWorldMatrix().GetElement(r, 0) for r in range(3)])(slicer.util.getNode('Plane'))").then(JSON.parse);
const turned = Math.acos(Math.max(-1, Math.min(1, normalBefore.reduce((s, v, i) => s + v * normalAfter[i], 0)))) * 180 / Math.PI;
check(Math.abs(turned - 90) < 3, `dragging it a quarter round turns the plane 90° (${turned.toFixed(1)}°)`);

// A scale handle (the plane's L edge; its R edge is where a control point is): dragged outwards,
// the plane gets wider on that side
const boundsBefore = await python("list(slicer.util.getNode('Plane').GetPlaneBounds())").then(JSON.parse);
const edge = await handle(7, 0);
await tipTo(edge[3]);
await frames(2);
check(await active() === "[7, 0]", `the tip in a scale handle highlights it (${await active()})`);
await trigger("selectstart");
await frames(1);
const xAxis = await python("(lambda x, y, z: (slicer.util.getNode('Plane').GetAxesWorld(x, y, z), x)[1])([0.0]*3, [0.0]*3, [0.0]*3)").then(JSON.parse);
await tipTo(edge[3].map((v, i) => v - xAxis[i] * 20));
await frames(2);
await trigger("selectend");
await frames(1);
const boundsAfter = await python("list(slicer.util.getNode('Plane').GetPlaneBounds())").then(JSON.parse);
const wider = boundsBefore[0] - boundsAfter[0];
check(Math.abs(wider - 20) < 1 && Math.abs(boundsAfter[1] - boundsBefore[1]) < 0.5, `dragging it 20 mm outwards widens that side by 20 mm (${wider.toFixed(1)} mm; the other side stays)`);

// An ROI (volume rendering makes one for cropping): its handles are read (this ended the session on
// the Quest), and its R face, dragged 20 mm outwards, makes it 20 mm longer on that side only
await exec(`
roi = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsROINode", "R")
roi.SetCenterWorld([0, 0, 150])
roi.SetSize([40, 40, 40])
`);
await page.evaluate(() => window.slicerXR.session.python.setHandlesShown(true));
await frames(3);
check(await page.evaluate(() => !window.__xrMock.ended), "with an ROI's handles in the scene, the session goes on");
const roiFace = await python("[list(h[1]) for h in slicerXR._scaleHandles(slicer.util.getNode('R')) if h[0] == 1][0]").then(JSON.parse);
const roiAxis = await python("slicerXR._roiFrame(slicer.util.getNode('R'))[2][0]").then(JSON.parse);
await tipTo(roiFace);
await frames(2);
const roiActive = await python("(lambda d: [d.GetActiveComponentType(), d.GetActiveComponentIndex()])(slicer.util.getNode('R').GetDisplayNode())");
check(roiActive === "[7, 1]", `the tip in the ROI's R face handle highlights it (${roiActive})`);
await trigger("selectstart");
await frames(1);
await tipTo(roiFace.map((v, i) => v + roiAxis[i] * 20));
await frames(2);
await trigger("selectend");
await frames(1);
const roiSize = await python("slicerXR._roiFrame(slicer.util.getNode('R'))[1]").then(JSON.parse);
const roiCenter = await python("slicerXR._roiFrame(slicer.util.getNode('R'))[0]").then(JSON.parse);
check(Math.abs(roiSize[0] - 60) < 0.5 && Math.abs(roiSize[1] - 40) < 0.5 && Math.abs(roiCenter[0] - 10 * Math.sign(roiAxis[0] || 1)) < 0.5,
  `dragging it 20 mm makes the ROI 20 mm longer on that side (${roiSize.map((v) => v.toFixed(0)).join(" x ")} mm, centre moved ${roiCenter[0].toFixed(1)} mm)`);

// Hidden again: nothing to highlight there
await page.evaluate(() => window.slicerXR.session.press({ id: "handles" }));
await tipTo(arrowMiddle);
await frames(2);
check(await python(`${d}.GetHandlesInteractive()`) === "False", "the Handles button hides them again");

await page.evaluate(() => window.__xrMock.session.end());
await page.waitForTimeout(500);
check(await python(`${d}.GetUseGlyphScale()`) === "True", "after the session the plane's glyphs are sized as before");
await browser.close();
process.exit(failed ? 1 : 0);

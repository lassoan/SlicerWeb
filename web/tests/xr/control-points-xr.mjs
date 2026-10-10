// A control point the controller's tip is in is highlighted (the display node's active component,
// and a sphere around it), and the trigger drags it: it moves as the controller moves, without
// jumping to the tip, also while a markup is being placed (the trigger does not add a point then),
// and a line's length follows on the panel. Out of the point, the highlight goes.
//
// Usage: node tests/xr/control-points-xr.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
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
const moveController = (p) => page.evaluate((p) => (window.__xrMock.controllerPosition = p), p);
const trigger = (type) => page.evaluate((type) => window.__xrMock.session.dispatch(type, { inputSource: window.__xrMock.controller }), type);
/** Where the controller's tip is in Slicer's coordinates, for the controller at this room position. */
const tipAt = (p) => page.evaluate((p) => {
  const { M } = window.slicerXR.internals;
  const session = window.slicerXR.session;
  return M.point(M.multiply(session.worldFromRoom, M.translation(...p)), [0, 0, -0.075]);
}, p);
const point = (node, i) => python(`list(slicer.util.getNode('${node}').GetNthControlPointPositionWorld(${i}))`).then(JSON.parse);
const highlighted = () => python("[a.GetVisibility() for a in slicerXR.highlights][0]");
const activePoint = (node) => python(`(lambda d: [d.GetActiveComponentType(), d.GetActiveComponentIndex()])(slicer.util.getNode('${node}').GetDisplayNode())`);

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(2);
const mmPerMetre = await page.evaluate(() => window.slicerXR.internals.M.scaleOf(window.slicerXR.session.worldFromRoom));

// A point list with a point 1 cm (in the room) from where the tip will be, and a line above it
// (Slicer's S is the room's up; its R is to the viewer's left)
const home = [0.15, 1.1, -0.4];
const tip = await tipAt(home);
await exec(`
import slicer
points = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "P")
points.AddControlPoint([${tip[0] + 0.01 * mmPerMetre}, ${tip[1]}, ${tip[2]}])
line = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode", "L")
line.AddControlPoint([${tip[0]}, ${tip[1]}, ${tip[2] + 0.3 * mmPerMetre}])
line.AddControlPoint([${tip[0]}, ${tip[1]}, ${tip[2] + 0.4 * mmPerMetre}])
`);
await moveController([0.6, 1.6, 0.3]); // away from everything
await frames(2);
check(await highlighted() === "0", "with the tip in no control point, nothing is highlighted");

await moveController(home);
await frames(2);
check(await highlighted() === "1", "the tip in a control point highlights it");
check(await activePoint("P") === "[1, 0]", "as Slicer does: it is the display node's active control point");

// Drag it 5 cm along the room's x
const before = await point("P", 0);
await trigger("selectstart");
await frames(1);
await moveController([home[0] + 0.05, home[1], home[2]]);
await frames(2);
await trigger("selectend");
await frames(1);
const after = await point("P", 0);
const moved = Math.hypot(...after.map((v, i) => v - before[i]));
check(Math.abs(moved - 0.05 * mmPerMetre) < 0.5, `the trigger drags it as far as the controller moved (${moved.toFixed(1)} mm, ${(0.05 * mmPerMetre).toFixed(1)} expected)`);
check(Math.abs(after[0] - (before[0] - 0.05 * mmPerMetre)) < 0.5, "it does not jump to the tip (it keeps its offset)");
check(await python("slicer.util.getNode('P').GetNumberOfControlPoints()") === "1", "and no point is added");

// The line's end, dragged while Line is being placed: no new point, and its length on the panel
await page.evaluate(() => window.slicerXR.session.press({ tool: "vtkMRMLMarkupsLineNode" }));
const lineEnd = await point("L", 1);
const lineTip = [home[0], home[1] + 0.4, home[2]];
await moveController(lineTip);
await frames(2);
check(await activePoint("L") === "[1, 1]", "the line's end is highlighted");
const lines = await python("len(slicer.util.getNodesByClass('vtkMRMLMarkupsLineNode'))");
await trigger("selectstart");
await frames(1);
await moveController([lineTip[0] + 0.1, lineTip[1], lineTip[2]]);
await frames(2);
const status = await page.evaluate(() => window.slicerXR.session.panel.status);
await trigger("selectend");
await frames(1);
const lineEndAfter = await point("L", 1);
const length = Number(await python("slicer.util.getNode('L').GetLineLengthWorld()"));
check(Math.abs(Math.hypot(...lineEndAfter.map((v, i) => v - lineEnd[i])) - 0.1 * mmPerMetre) < 0.5, "while placing a line, the trigger in a point drags it");
check(await python("len(slicer.util.getNodesByClass('vtkMRMLMarkupsLineNode'))") === lines, "and places no new line");
check(status.includes(`${length.toFixed(1)} mm`), `the panel shows the length as it changes (${status})`);

await moveController([0.6, 1.6, 0.3]);
await frames(2);
check(await highlighted() === "0" && (await activePoint("L")) === "[0, -1]", "out of the point, the highlight goes");

await page.evaluate(() => window.__xrMock.session.end());
await page.waitForTimeout(500);
await browser.close();
process.exit(failed ? 1 : 0);

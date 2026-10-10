// The panel in the headset (slicer-xr.js XRPanel), against the stand-in for WebXR (xr-mock.js):
// it is shown in front of the viewer, offers no loading of data (that is done on the page; a volume
// loaded there is volume rendered on entering), and its buttons work when a controller is aimed at
// them and the trigger pulled: markups are placed at the controller's tip, taken back and deleted.
// B hides the panel.
//
// Usage: node tests/xr/panel-mock.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=&layout=OneUp3D";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("console", (m) => {
  if (m.type() === "error" || /Slicer XR/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 400)}`);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const python = (expression) => page.evaluate((e) => window.slicerWeb.bridge.evalPython(e, "eval"), expression);
let time = 0;
const frames = (count) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start: (time += count * 14) });
const saveImage = async (file) => {
  const data = await page.evaluate(() => window.__xrMock.image());
  fs.writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
};

/** Aims the controller's ray at a button of the panel (from below and to the right of it). */
const aimAt = (id) => page.evaluate((id) => {
  const { M } = window.slicerXR.internals;
  const panel = window.slicerXR.session.panel;
  const button = panel.buttons.find((b) => b.id === id);
  const x = ((button.x + button.width / 2) / panel.layoutWidth - 0.5) * panel.widthM;
  const y = (0.5 - (button.y + button.height / 2) / panel.height) * panel.heightM;
  const target = M.point(panel.roomFromPanel, [x, y, 0]);
  const origin = [0.1, 1.0, -0.25];
  const z = [0, 1, 2].map((i) => origin[i] - target[i]);
  const l = Math.hypot(...z);
  const zz = z.map((v) => v / l);
  const up = [0, 1, 0];
  let xx = [up[1] * zz[2] - up[2] * zz[1], up[2] * zz[0] - up[0] * zz[2], up[0] * zz[1] - up[1] * zz[0]];
  const lx = Math.hypot(...xx);
  xx = xx.map((v) => v / lx);
  const yy = [zz[1] * xx[2] - zz[2] * xx[1], zz[2] * xx[0] - zz[0] * xx[2], zz[0] * xx[1] - zz[1] * xx[0]];
  window.__xrMock.rayMatrix = new Float32Array([...xx, 0, ...yy, 0, ...zz, 0, ...origin, 1]);
}, id);
const aimAway = () => page.evaluate(() => (window.__xrMock.rayMatrix = null));
const trigger = async () => {
  await page.evaluate(() => window.__xrMock.session.dispatch("selectstart", { inputSource: window.__xrMock.controller }));
  await page.evaluate(() => window.__xrMock.session.dispatch("selectend", { inputSource: window.__xrMock.controller }));
};
const press = async (id) => {
  await aimAt(id);
  await frames(1);
  const hover = await page.evaluate(() => window.slicerXR.session.panel.hover);
  await trigger();
  await frames(1);
  return hover;
};
const panelState = () => page.evaluate(() => {
  const p = window.slicerXR.session.panel;
  return { status: p.status, busy: p.busy, activeTool: p.activeTool, visible: p.visible };
});

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 30000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 30000 });
await frames(3);

let state = await panelState();
check(state.visible, "the panel is shown");
check(await python("slicerXR.panel.GetVisibility()") === "1", "the panel is shown in the scene");
const sections = await page.evaluate(() => window.slicerXR.session.panel.buttons.filter((b) => b.heading).map((b) => b.heading));
check(!sections.includes("Sample data") && !(await page.evaluate(() => window.slicerXR.session.panel.buttons.some((b) => b.sample))),
  `the panel offers no sample data (its sections: ${sections.join(", ")}); data is loaded on the page`);
await saveImage("tests/panel-mock-empty.png");

// The scene, as the page loads it: a volume, shown volume rendered on entering
await page.evaluate(() => window.__xrMock.session.end());
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__xrMock.ended = false;
  window.__xrMock.callbacks.length = 0;
});
await page.evaluate(async () => {
  const path = await window.slicerWeb.downloadFile("sample-data/MR-head.nrrd", "MR-head.nrrd");
  await window.slicerWeb.bridge.call("loadFiles", [[path], {}]);
});
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 30000 });
await frames(3);
check(await python("len(slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode'))") === "1", "the scene has the volume loaded on the page");
check(await python("any(d.GetVisibility() for d in slicer.util.getNodesByClass('vtkMRMLVolumeRenderingDisplayNode'))") === "True", "entering shows it volume rendered");
await aimAway();
await frames(2);
await saveImage("tests/panel-mock-mrhead.png");

// A line, placed with the controller's tip at two places 10 cm apart
await press("tool:vtkMRMLMarkupsLineNode");
check((await panelState()).activeTool === "vtkMRMLMarkupsLineNode", "Line is the markup being placed");
await aimAway();
await page.evaluate(() => (window.__xrMock.controllerPosition = [0.0, 1.1, -0.45]));
await frames(1);
await trigger();
await page.evaluate(() => (window.__xrMock.controllerPosition = [0.1, 1.1, -0.45]));
await frames(1);
await trigger();
await frames(1);
state = await panelState();
const mmPerMetre = Number(await page.evaluate(() => window.slicerXR.internals.M.scaleOf(window.slicerXR.session.worldFromRoom)));
const length = Number(await python("slicer.util.getNodesByClass('vtkMRMLMarkupsLineNode')[0].GetLineLengthWorld()"));
check(Math.abs(length - 0.1 * mmPerMetre) < 0.5, `a line of two points 10 cm apart is ${(0.1 * mmPerMetre).toFixed(1)} mm long (${length.toFixed(1)} mm; ${state.status})`);
const glyph = Number(await python("slicer.util.getNodesByClass('vtkMRMLMarkupsLineNode')[0].GetDisplayNode().GetGlyphSize()"));
check(Math.abs(glyph - 0.008 * mmPerMetre) < 1e-6, `its points are sized for the room (${glyph.toFixed(1)} mm: 8 mm in the room)`);

// Grabbing with the grip still moves the scene while a markup is being placed
const before = await page.evaluate(() => Array.from(window.slicerXR.session.worldFromRoom));
await page.evaluate(() => window.__xrMock.session.dispatch("squeezestart", { inputSource: window.__xrMock.controller }));
await frames(1);
await page.evaluate(() => (window.__xrMock.controllerPosition = [0.2, 1.1, -0.45]));
await frames(1);
await page.evaluate(() => window.__xrMock.session.dispatch("squeezeend", { inputSource: window.__xrMock.controller }));
const after = await page.evaluate(() => Array.from(window.slicerXR.session.worldFromRoom));
check(before.some((v, i) => Math.abs(v - after[i]) > 1e-6), "the grip still holds the scene while placing");
check(await python("len(slicer.util.getNodesByClass('vtkMRMLMarkupsLineNode'))") === "1", "and places no point");

// An angle of three points
await press("tool:vtkMRMLMarkupsAngleNode");
await aimAway();
// (above the line: a point placed in one of the line's would drag it instead)
for (const position of [[0.1, 1.35, -0.45], [0.0, 1.25, -0.45], [0.1, 1.25, -0.45]]) {
  await page.evaluate((p) => (window.__xrMock.controllerPosition = p), position);
  await frames(1);
  await trigger();
}
await frames(1);
state = await panelState();
check(/done: 45\.0°/.test(state.status), `an angle of three points is measured (${state.status})`);
await saveImage("tests/panel-mock-markups.png");

// Undo, delete
await press("undo");
check(await python("slicer.util.getNodesByClass('vtkMRMLMarkupsAngleNode')[0].GetNumberOfControlPoints()") === "2", `Undo point takes back the last point (${(await panelState()).status})`);
await press("delete");
check(await python("len(slicer.util.getNodesByClass('vtkMRMLMarkupsNode'))") === "0", `Delete markups deletes them (${(await panelState()).status})`);
await press("done");
check((await panelState()).activeTool === null, "Done ends placing");

// Pointing away from the panel and pulling the trigger holds the scene again (nothing is placed)
await aimAway();
await trigger();
check(await python("len(slicer.util.getNodesByClass('vtkMRMLMarkupsNode'))") === "0", "with no markup chosen, the trigger places nothing");

// B hides the panel, and shows it again
await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[5].pressed = true));
await frames(1);
await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[5].pressed = false));
await frames(1);
check(!(await panelState()).visible && (await python("slicerXR.panel.GetVisibility()")) === "0", "B hides the panel");
await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[5].pressed = true));
await frames(1);
await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[5].pressed = false));
await frames(1);
check((await panelState()).visible, "B shows it again");

await press("exit");
await page.waitForTimeout(500);
check(await page.evaluate(() => window.__xrMock.ended), "Exit VR on the panel ends the session");
check(await python("len([a for a in slicer.app.layoutManager().views()['1'].GetRenderer().GetActors()])") !== null, "the session ends");
const restored = await python("(lambda v: v.GetRenderer().GetActiveCamera() is v.GetCameraNode().GetCamera())(slicer.app.layoutManager().views()['1'])");
check(restored === "True", "the view looks through the camera of the scene's camera node again (the scene was loaded anew)");
await page.screenshot({ path: "tests/panel-mock.png" });
await browser.close();
process.exit(failed ? 1 : 0);

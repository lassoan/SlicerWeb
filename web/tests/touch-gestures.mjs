// Two fingers on a view: one continuous gesture. Zooming, panning and (in 3D) turning go on
// together, with no jump when one of them overtakes another - VTK's recognizer would end the
// pinch and start a pan with everything the fingers had panned so far. A slice view does not
// turn with the slight turn of a pinch; it turns once the fingers have turned past 30 degrees.
// Usage: node tests/touch-gestures.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
// evalPython gives the repr of the value, so the JSON comes back in quotes
const py = async (code) => JSON.parse(String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), `json.dumps(${code})`)).replace(/^'|'$/g, ""));

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import json", "exec"));

const cdp = await context.newCDPSession(page);
const canvasCenter = (name) => page.evaluate((n) => {
  const r = document.querySelector(`#slicer-view-${n}`).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, name);

/** Two fingers, moved step by step; `at(i)` gives their positions; `sample()` reads the view after each step. */
async function gesture(at, steps, sample) {
  const points = (i) => at(i).map(([x, y], id) => ({ x, y, id }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(0) });
  const samples = [];
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(i) });
    await page.waitForTimeout(40);
    samples.push(await sample());
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
  return samples;
}
const maxStepLogRatio = (values) => Math.max(...values.slice(1).map((v, i) => Math.abs(Math.log(v / values[i]))));
const stepDistances = (points) => points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1], (p[2] ?? 0) - (points[i][2] ?? 0)));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// ---- slice view: pinch out, then pan takes over; the fingers turn 10 degrees meanwhile
// (A pan moves the slice's origin in its plane; turning the fingers turns the slices that
// intersect this one about its normal, as Ctrl+Alt+drag does, so the Yellow slice's axes tell.)
const red = await canvasCenter("Red");
const sliceState = () => py('[slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode().GetFieldOfView()[0], list(slicer.app.layoutManager().sliceWidget("Red").mrmlSliceNode().GetXYZOrigin()), [slicer.app.layoutManager().sliceWidget("Yellow").mrmlSliceNode().GetSliceToRAS().GetElement(r, 0) for r in range(3)]]');
const [fov0, , axis0] = await sliceState();
const pinchThenPan = (c) => (i) => {
  // first 20 steps mostly pinch (+4 px of distance, +1 px of pan), then mostly pan (+1, +6)
  const d = 100 + Math.min(i, 20) * 4 + Math.max(0, i - 20) * 1;
  const pan = Math.min(i, 20) * 1 + Math.max(0, i - 20) * 6;
  const a = (i * 0.25 * Math.PI) / 180;
  const [dx, dy] = [(d / 2) * Math.cos(a), (d / 2) * Math.sin(a)];
  return [[c.x + pan - dx, c.y - dy], [c.x + pan + dx, c.y + dy]];
};
let samples = await gesture(pinchThenPan(red), 40, sliceState);
const fovs = [fov0, ...samples.map((s) => s[0])];
const origins = samples.map((s) => s[1]);
console.log(`     slice field of view ${fov0.toFixed(1)} -> ${fovs.at(-1).toFixed(1)} mm`);
check("the slice zoomed in with the pinch", fovs.at(-1) < fov0 * 0.6, true);
check("smoothly: no step changed the field of view by more than 15%", maxStepLogRatio(fovs) < Math.log(1.15), true);
const originSteps = stepDistances(origins);
console.log(`     slice moved by ${Math.hypot(...origins.at(-1).map((v, k) => v - origins[0][k])).toFixed(1)} mm; largest step ${Math.max(...originSteps).toFixed(2)}, median ${median(originSteps).toFixed(2)}`);
check("the slice panned along", Math.hypot(...origins.at(-1).map((v, k) => v - origins[0][k])) > 5, true);
check("without a jump when the pan overtook the pinch", Math.max(...originSteps) < 5 * Math.max(median(originSteps), 0.5), true);
const [, , axis1] = await sliceState();
const turned = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
check("a 10 degree turn of the fingers did not turn the intersecting slices", turned(axis0, axis1) < 1, true);

// ---- slice view: the fingers turn 80 degrees, at a fixed distance and place. The slices that
// intersect this one turn - once their intersections are shown, as on the desktop.
await page.evaluate(() => window.slicerWeb.bridge.evalPython('for name in ("Red", "Green", "Yellow"): slicer.app.layoutManager().sliceWidget(name).sliceLogic().GetSliceDisplayNode().SetIntersectingSlicesVisibility(True)', "exec"));
await page.waitForTimeout(500);
const turn = (c) => (i) => {
  const a = (i * 2 * Math.PI) / 180;
  const [dx, dy] = [60 * Math.cos(a), 60 * Math.sin(a)];
  return [[c.x - dx, c.y - dy], [c.x + dx, c.y + dy]];
};
await gesture(turn(red), 40, sliceState);
const [, , axis2] = await sliceState();
console.log(`     intersecting slices turned by ${turned(axis1, axis2).toFixed(1)} degrees`);
check("an 80 degree turn turned the intersecting slices, by what went past 30 degrees or so", turned(axis1, axis2) > 15 && turned(axis1, axis2) < 60, true);

// ---- 3D view: the same pinch-then-pan; the camera also rolls with the fingers
const threeD = await canvasCenter("1");
const cameraState = () => py('[slicer.app.layoutManager().threeDWidget(0).threeDView().cameraNode().GetCamera().GetDistance(), list(slicer.app.layoutManager().threeDWidget(0).threeDView().cameraNode().GetCamera().GetFocalPoint()), list(slicer.app.layoutManager().threeDWidget(0).threeDView().cameraNode().GetCamera().GetViewUp())]');
const [dist0, , up0] = await cameraState();
samples = await gesture(pinchThenPan(threeD), 40, cameraState);
const dists = [dist0, ...samples.map((s) => s[0])];
const focals = samples.map((s) => s[1]);
console.log(`     camera distance ${dist0.toFixed(1)} -> ${dists.at(-1).toFixed(1)} mm`);
check("the 3D view zoomed in with the pinch", dists.at(-1) < dist0 * 0.7, true);
check("smoothly: no step changed the camera distance by more than 15%", maxStepLogRatio(dists) < Math.log(1.15), true);
const focalSteps = stepDistances(focals);
check("the 3D view panned along", Math.hypot(...focals.at(-1).map((v, k) => v - focals[0][k])) > 5, true);
check("without a jump when the pan overtook the pinch", Math.max(...focalSteps) < 5 * Math.max(median(focalSteps), 0.5), true);
const [, , up1] = await cameraState();
console.log(`     camera rolled by ${turned(up0, up1).toFixed(1)} degrees`);
check("the camera rolled with the fingers' 10 degree turn", turned(up0, up1) > 5, true);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

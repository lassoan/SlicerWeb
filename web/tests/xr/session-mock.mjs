// The XR session of slicer-xr.js, from the button to the end, against a stand-in for WebXR: a
// navigator.xr whose session draws into a framebuffer of the page, with one controller. Clicks
// "Enter VR", draws frames, grabs the scene with the controller and moves it to the right (the
// sphere must follow), presses A (it must go back), and ends the session (the 3D view must be the
// page's again, and the button say "Enter VR").
//
// Usage: node tests/xr/session-mock.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
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

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

// The stand-in for WebXR (xr-mock.js), before the page's scripts run
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import vtk
sphere = vtk.vtkSphereSource()
sphere.SetRadius(60)
sphere.SetThetaResolution(48)
sphere.SetPhiResolution(48)
sphere.Update()
model = slicer.modules.models.logic().AddModel(sphere.GetOutput())
model.GetDisplayNode().SetColor(1, 0, 0)
`));
const button = page.locator("#slicer-xr button.vr");
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 30000 });
check(true, "Enter VR is enabled once Slicer is ready");
await button.click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 30000 });
const requested = await page.evaluate(() => ({ ...window.__xrMock.requested, layer: window.__xrMock.layerOptions }));
check(requested.mode === "immersive-vr" && requested.options.requiredFeatures.includes("local-floor"), "an immersive-vr session with local-floor is asked for");
check(requested.layer.antialias === false, "the layer is not multisampled (a copy could not go into it)");
check((await button.textContent()) === "Exit VR", "the button offers to exit");

const frames = (count, start = 0) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start });

// (the panel has red in it too: this test looks at the sphere alone)
await page.evaluate(() => (window.slicerXR.session.panel.visible = false));
await frames(3);
const before = await page.evaluate(() => window.__xrMock.sphere());
check(before.every((e) => e.pixels > 500), `both eyes see the sphere (${before.map((e) => e.pixels)} pixels)`);

// Grab with the trigger, move the controller 10 cm to the right, let go
await page.evaluate(() => {
  const mock = window.__xrMock;
  mock.session.dispatch("selectstart", { inputSource: mock.controller });
});
await frames(1, 100);
await page.evaluate(() => (window.__xrMock.controllerPosition = [0.3, 1.1, -0.45]));
await frames(2, 200);
await page.evaluate(() => {
  const mock = window.__xrMock;
  mock.session.dispatch("selectend", { inputSource: mock.controller });
});
await frames(1, 300);
const moved = await page.evaluate(() => window.__xrMock.sphere());
check(moved.every((e, i) => e.pixels > 300 && e.x > before[i].x + 0.06), `grabbed and moved right, the sphere goes right (${before.map((e) => e.x.toFixed(2))} -> ${moved.map((e) => e.x?.toFixed(2))})`);

// Moving the controller when it does not hold the scene changes nothing
await page.evaluate(() => (window.__xrMock.controllerPosition = [0.0, 1.0, -0.3]));
await frames(2, 400);
const notHeld = await page.evaluate(() => window.__xrMock.sphere());
check(notHeld.every((e, i) => Math.abs(e.x - moved[i].x) < 0.01), "let go of, the scene stays where it was put");

// A puts it back
await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[4].pressed = true));
await frames(1, 500);
await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[4].pressed = false));
await frames(1, 520);
const reset = await page.evaluate(() => window.__xrMock.sphere());
check(reset.every((e, i) => Math.abs(e.x - before[i].x) < 0.01 && Math.abs(e.y - before[i].y) < 0.01), "A puts the scene back where it started");

// A push inside the dead zone does nothing
const stick = (x, y) => page.evaluate(([x, y]) => {
  window.__xrMock.controller.gamepad.axes[2] = x;
  window.__xrMock.controller.gamepad.axes[3] = y;
}, [x, y]);
const worldFromRoom = () => page.evaluate(() => Array.from(window.slicerXR.session.worldFromRoom));
const still = await worldFromRoom();
await stick(0.3, -0.4);
await frames(20, 560);
await stick(0, 0);
const afterSmallPush = await worldFromRoom();
check(still.every((v, i) => Math.abs(v - afterSmallPush[i]) < 1e-9), "a push inside the dead zone moves nothing");

// Pushed up (a little to the side, as a push is), it makes the scene larger and does not turn it
await stick(0.35, -1);
await frames(40, 900);
await stick(0, 0);
await frames(1, 1600);
const zoomed = await page.evaluate(() => window.__xrMock.sphere());
const turned = await worldFromRoom();
const yawOf = (m) => Math.atan2(m[8], m[0]);
check(Math.abs(yawOf(turned) - yawOf(still)) < 1e-6, "pushed mostly up, the stick only zooms");
check(zoomed.every((e, i) => e.pixels > before[i].pixels * 1.3), `the thumbstick pushed up makes it larger (${before.map((e) => e.pixels)} -> ${zoomed.map((e) => e.pixels)} pixels)`);

// Something going wrong in following the controllers (as reading an ROI's handles did on the Quest)
// is reported once and does not end the session; the frames go on being drawn
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.evaluate(() => {
  const session = window.slicerXR.session;
  session.updateControlPointsWas = session.updateControlPoints;
  session.updateControlPoints = () => {
    throw new Error("a test failure in following the controllers");
  };
});
await frames(30, 1100);
const going = await page.evaluate(() => !window.__xrMock.ended);
const drawn = await page.evaluate(() => window.__xrMock.sphere());
check(going && drawn.every((e) => e.pixels > 300), "a failure in following the controllers does not end the session");
check(errors.filter((e) => /test failure/.test(e)).length === 1, `it is reported once, not every frame (${errors.filter((e) => /test failure/.test(e)).length})`);
await page.evaluate(() => {
  const session = window.slicerXR.session;
  session.updateControlPoints = session.updateControlPointsWas;
});

const sizeInSession = await page.evaluate(() => window.slicerWeb.bridge.evalPython(
  "[list(v.GetRenderWindow().GetSize()) for v in slicer.app.layoutManager().views().values() if v.IsA('vtkSlicerWebThreeDView')][0]", "eval"));
check(sizeInSession === "[320, 360]", `in the session the view is an eye's size (${sizeInSession})`);

await page.evaluate(() => window.__xrMock.session.end());
await page.waitForTimeout(500);
check((await button.textContent()) === "Enter VR", "after the session the button offers to enter again");
const after = await page.evaluate(() => window.slicerWeb.bridge.evalPython(
  "(lambda v: [list(v.GetRenderWindow().GetSize()), v.GetRenderer().GetActiveCamera() is v.GetCameraNode().GetCamera(), v.GetRenderEnabled()])" +
  "([v for v in slicer.app.layoutManager().views().values() if v.IsA('vtkSlicerWebThreeDView')][0])", "eval"));
console.log(`after: ${after}`);
check(after === "[[574, 716], True, True]", "the view has its size, its camera node's camera and its rendering back");

// The page shows the 3D view again
await page.waitForTimeout(1000);
await page.screenshot({ path: "tests/session-mock.png" });
await browser.close();
process.exit(failed ? 1 : 0);

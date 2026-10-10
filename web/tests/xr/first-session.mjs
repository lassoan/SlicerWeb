// The first session of a page must show the scene (it did not on the Quest: see the draw buffers
// check below), also when the 3D view's WebGL context is lost on the way to XR, or during a session. Making a context XR
// compatible may lose it and restore it (the WebXR specification allows it, and the Quest's browser
// seems to do it the first time), and SlicerWeb then makes the view anew, on a new canvas: the first
// session showed nothing. Each way here must show the scene, in the first session and the next:
//   - the context lost while slicer-xr.js makes it ready on the page (what a headset does),
//   - lost when Enter VR is pressed (?xrPrepare=0: not made ready on the page),
//   - lost in the middle of a session (a browser letting go of the GPU for a while).
//
// Usage: node tests/xr/first-session.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

async function scenario(label, query, { midSession = false } = {}) {
  console.log(`--- ${label}`);
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || /Slicer XR/.test(m.text())) console.log(`  [${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e}`));
  await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });
  let time = 0;
  const frames = (count) => page.evaluate(({ count, start }) => {
    for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
  }, { count, start: (time += count * 14) });

  await page.goto(`${base}?sample=&layout=OneUp3D&${query}`);
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
  await page.evaluate(() => window.slicerXR.preparing);
  await page.waitForTimeout(1500); // SlicerWeb makes the view anew, if it was lost
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
  await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });

  /** Draws the session's frames as they come, until the eyes see the sphere (or 10 s pass). */
  async function watch() {
    let seen = null;
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(30);
      const state = await page.evaluate(() => ({ callbacks: window.__xrMock.callbacks.length, ended: window.__xrMock.ended }));
      if (state.ended) break;
      if (!state.callbacks) continue;
      await frames(1);
      seen = await page.evaluate(() => (window.__xrMock.layer ? window.__xrMock.sphere() : null));
      if (seen?.every((e) => e.pixels > 500)) break;
    }
    const ended = await page.evaluate(() => window.__xrMock.ended);
    const message = await page.locator("#slicer-xr .message").textContent();
    return { ok: !ended && !!seen?.every((e) => e.pixels > 500), text: `${seen ? seen.map((e) => e.pixels) : "no frame"} red pixels${ended ? "; the session ended" : ""}${message ? `; "${message}"` : ""}` };
  }

  for (const which of ["first", "second"]) {
    await button.click();
    let result = await watch();
    if (midSession && which === "first" && result.ok) {
      // Lost now, mid-session: the session goes on with the view made anew
      const selector = await page.evaluate(() => window.slicerXR.session.python.viewCanvasSelector());
      await page.evaluate((selector) => {
        window.__xrMock.layer = null; // the sphere is looked for in the new layer
        window.__xrMock.loseContext(selector);
      }, selector);
      result = await watch();
      check(result.ok, `after the context is lost mid-session, the headset shows the scene again (${result.text})`);
    } else {
      check(result.ok, `the ${which} session shows the scene (${result.text})`);
    }
    await page.evaluate(() => window.__xrMock.session?.end());
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__xrMock.ended = false;
      window.__xrMock.callbacks.length = 0;
    });
  }
  // The framebuffer of an XR layer is "opaque": setting its draw buffers turns drawing into it off
  // in Chromium (xr-mock.js does the same). That was done in the first frame of the first session.
  check(await page.evaluate(() => window.__xrMock.opaqueDrawBuffersCalls) === 0, "the draw buffers of the headset's framebuffer are never set");
  const lost = await page.evaluate(() => window.__xrMock.contextsLost ?? 0);
  if (query.includes("loseContextOnce")) check(lost === 1, "making the context XR compatible lost it once");
  const restored = await page.evaluate(() => window.slicerWeb.bridge.evalPython(
    "(lambda v: v.GetRenderer().GetActiveCamera() is v.GetCameraNode().GetCamera() and v.GetRenderEnabled())(slicer.app.layoutManager().views()['1'])", "eval"));
  check(restored === "True", "afterwards the page has its 3D view back");
  await page.context().close();
}

await scenario("lost while made ready on the page", "loseContextOnce");
await scenario("lost when Enter VR is pressed", "loseContextOnce&xrPrepare=0");
await scenario("lost in the middle of a session", "xrPrepare=0", { midSession: true });
await browser.close();
process.exit(failed ? 1 : 0);

// Draws XR frames without a headset: a framebuffer of the page's own stands in for the headset's,
// two eyes looking at a red sphere are rendered into it the way a session does (slicer-xr.js), and
// what each eye's half holds is checked - that the sphere is there, below the middle (it is placed
// below the eyes), and further right for the left eye than for the right one (parallax). Then the
// view must be the page's again, at its own size.
//
// Usage: node tests/xr/render-eyes.mjs [url] [--shared]  (an application with the feature webxr, examples/full: python slicerweb.py dev; --shared: the views
// share one WebGL context, the other way SlicerWeb draws them)
import fs from "node:fs";
import { chromium } from "playwright-core";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const shared = process.argv.includes("--shared");
const url = args[0] ?? "http://localhost:5173/?sample=&layout=OneUp3D";

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

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
check(await page.locator("#slicer-xr button.vr").isVisible(), "the Enter VR button is on the page");

if (shared) {
  await page.evaluate(() => (window.slicerWeb.store.settings["Rendering/SharedWebGLContext"] = true));
  await page.waitForTimeout(3000);
}
await page.waitForFunction(() => window.slicerWeb.bridge.evalPython(
  "len([v for v in slicer.app.layoutManager().views().values() if v.IsA('vtkSlicerWebThreeDView')])", "eval").then((n) => n !== "0"),
  null, { timeout: 60000 });
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import vtk
sphere = vtk.vtkSphereSource()
sphere.SetRadius(60)
sphere.SetThetaResolution(48)
sphere.SetPhiResolution(48)
sphere.Update()
model = slicer.modules.models.logic().AddModel(sphere.GetOutput())
model.SetName("XRTestSphere")
model.GetDisplayNode().SetColor(1, 0, 0)
`));
await page.waitForTimeout(1000);

const result = await page.evaluate(async (sharedMode) => {
  const { XRSessionView, redirectDefaultFramebuffer, slicerXRPython, slicerWebApp } = window.slicerXR.internals;
  const app = slicerWebApp();
  const viewSize = async () => JSON.parse(await app.bridge.evalPython(
    "[list(v.GetRenderWindow().GetSize()) for v in slicer.app.layoutManager().views().values() if v.IsA('vtkSlicerWebThreeDView')][0]", "eval"));
  const python = await slicerXRPython(app);
  const sizeBefore = await viewSize();

  const session = new XRSessionView(app, python, "immersive-vr", 1, { sessionEnded() {}, showError() {} });
  const started = python.start(false);
  const info = started.toJs({ dict_converter: Object.fromEntries });
  started.destroy();
  session.bounds = info.bounds;
  session.resetPlacement();

  const gl = document.querySelector(info.canvasSelector).getContext("webgl2");
  const redirect = redirectDefaultFramebuffer(gl);
  // The stand-in for the XR layer: both eyes side by side
  const W = 320, H = 360;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 2 * W, H);
  const framebuffer = gl.createFramebuffer();
  const previous = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previous);

  // Eyes 1.2 m above the floor (a little above the scene's centre), 64 mm apart, looking ahead (-z) with a 90 degree field of view
  const n = 0.03, f = 50;
  // (square pixels: the eye is taller than wide)
  const projection = new Float32Array([H / W, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0]);
  const eye = (x) => ({ transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 1.2, 0, 1]) }, projectionMatrix: projection });
  const views = [eye(-0.032), eye(0.032)];

  const t0 = performance.now();
  const frames = 3;
  for (let frame = 0; frame < frames; frame++) {
    redirect.begin(framebuffer);
    try {
      python.beginFrame(W, H, [[], []], [[], []], []);
      views.forEach((view, i) => {
        redirect.offset = [i * W, 0];
        python.renderEye(session.eyeCamera(view));
      });
    } finally {
      redirect.end();
    }
  }
  const msPerFrame = (performance.now() - t0) / frames;

  const pixels = new Uint8Array(2 * W * H * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
  gl.readPixels(0, 0, 2 * W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  const eyes = [0, 1].map((e) => {
    let count = 0, sx = 0, sy = 0, lit = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * 2 * W + e * W + x) * 4;
        const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
        if (r + g + b > 30) lit++;
        if (r > 90 && g < 60 && b < 60) {
          count++;
          sx += x;
          sy += y;
        }
      }
    }
    return { red: count, lit, x: count ? sx / count / W : null, y: count ? sy / count / H : null };
  });

  // What the eyes saw, as an image (upside down rows: WebGL reads from the bottom)
  const image = document.createElement("canvas");
  image.width = 2 * W;
  image.height = H;
  const context = image.getContext("2d");
  const data = context.createImageData(2 * W, H);
  for (let y = 0; y < H; y++) data.data.set(pixels.subarray((H - 1 - y) * 2 * W * 4, (H - y) * 2 * W * 4), y * 2 * W * 4);
  context.putImageData(data, 0, 0);
  const frameImage = image.toDataURL("image/png");

  python.stop();
  await new Promise((r) => setTimeout(r, 500));
  const sizeAfter = await viewSize();
  return { frameImage, info, eyes, msPerFrame, sizeBefore, sizeAfter, sharedSetting: sharedMode };
}, shared);

fs.writeFileSync(`tests/render-eyes-frame${shared ? "-shared" : ""}.png`, Buffer.from(result.frameImage.split(",")[1], "base64"));
delete result.frameImage;
console.log(JSON.stringify(result));
check(result.info.shared === shared, `the 3D view draws ${shared ? "on the shared canvas" : "on a canvas of its own"}`);
const [left, right] = result.eyes;
for (const [name, e] of [["left", left], ["right", right]]) {
  check(e.lit > 0.9 * 320 * 360, `the ${name} eye is drawn all over (${e.lit} pixels lit)`);
  check(e.red > 500, `the ${name} eye sees the sphere (${e.red} pixels)`);
  check(e.y !== null && e.y < 0.5, `the ${name} eye sees it below the middle (at ${e.y?.toFixed(2)} of the height from the bottom)`);
}
check(left.x !== null && right.x !== null && left.x > right.x, `parallax: the left eye sees it further right (${left.x?.toFixed(3)} vs ${right.x?.toFixed(3)})`);
check(JSON.stringify(result.sizeAfter) === JSON.stringify(result.sizeBefore), `the view has its size back (${result.sizeAfter})`);
console.log(`${result.msPerFrame.toFixed(0)} ms per frame of two eyes (software rendering)`);

await page.screenshot({ path: "tests/render-eyes.png" });
await browser.close();
process.exit(failed ? 1 : 0);

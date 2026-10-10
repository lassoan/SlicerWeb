// A plane markup's translucent fill, in VR and in AR. In AR the headset blends what is drawn over
// the room by its alpha, so the fill must be there in the colour and in the alpha of the frame.
//
// Usage: node tests/xr/plane-fill-xr.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/?sample=&layout=OneUp3D&ar";
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

const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });
await page.goto(base);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
// A green plane, square to the viewer, 20 cm across: its fill is half opaque
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
plane = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsPlaneNode", "Plane")
plane.SetPlaneType(slicer.vtkMRMLMarkupsPlaneNode.PlaneType3Points)
plane.AddControlPoint([-100, 0, -100])
plane.AddControlPoint([100, 0, -100])
plane.AddControlPoint([-100, 0, 100])
d = plane.GetDisplayNode()
d.SetSelectedColor(0, 1, 0)
d.SetColor(0, 1, 0)
`));
let time = 0;
const frames = (count) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start: (time += count * 14) });

for (const mode of ["vr", "ar"]) {
  await page.waitForFunction((mode) => !document.querySelector(`#slicer-xr button.${mode}`).disabled, mode, { timeout: 60000 });
  await page.locator(`#slicer-xr button.${mode}`).click();
  await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
  await frames(2);
  await page.evaluate(() => (window.slicerXR.session.panel.visible = false));
  await frames(2);
  const result = await page.evaluate(() => {
    const { W, H, gl, layer } = window.__xrMock;
    const pixels = new Uint8Array(2 * W * H * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.framebuffer);
    gl.readPixels(0, 0, 2 * W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    let fill = 0, alphaSum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 1] > pixels[i] + 40 && pixels[i + 1] > pixels[i + 2] + 40) {
        fill++;
        alphaSum += pixels[i + 3];
      }
    }
    return { fill, alpha: fill ? alphaSum / fill : 0, image: window.__xrMock.image() };
  });
  fs.writeFileSync(`tests/plane-fill-${mode}.png`, Buffer.from(result.image.split(",")[1], "base64"));
  console.log(`${mode}: ${result.fill} green pixels, mean alpha ${result.alpha.toFixed(0)}`);
  check(result.fill > 2000, `${mode.toUpperCase()}: the plane's fill is drawn (${result.fill} pixels)`);
  if (mode === "ar") check(result.alpha > 60 && result.alpha < 250, `AR: the fill is translucent in the frame's alpha (mean ${result.alpha.toFixed(0)} of 255)`);
  await page.evaluate(() => window.__xrMock.session.end());
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__xrMock.ended = false;
    window.__xrMock.callbacks.length = 0;
  });
}
await browser.close();
process.exit(failed ? 1 : 0);

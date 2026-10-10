// A volume loaded the way the page loads it - ?sample=MRHead, the Samples button, a file - is not
// volume rendered, so the headset showed nothing of it. Entering VR shows it volume rendered (when
// nothing else of the scene is shown in 3D), and the volume's eye in the panel's data tree turns it off
// and on again. Also: what the page logs reaches the server (xr/log).
//
// Usage: node tests/xr/volume-rendering-xr.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=MRHead&layout=OneUp3D";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => {
  if (/volume texture|WebGL 2 context/.test(m.text())) console.log(`  [${m.type()}] ${m.text()}`);
});
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });
const logged = [];
page.on("request", (r) => {
  if (r.url().endsWith("/xr/log")) logged.push(r.postData());
});

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

/** Pixels of the eyes that are skin: the volume rendered head (the background is blue-grey). */
const skin = () => page.evaluate(() => {
  const { W, H, gl, layer } = window.__xrMock;
  const pixels = new Uint8Array(2 * W * H * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.framebuffer);
  gl.readPixels(0, 0, 2 * W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > pixels[i + 2] + 30 && pixels[i] > 60) count++;
  return count;
});
/** Aims the controller at a button of the panel and pulls the trigger. */
const press = async (id) => {
  await page.evaluate((id) => {
    const { M } = window.slicerXR.internals;
    const panel = window.slicerXR.session.panel;
    const button = panel.buttons.find((b) => b.id === id);
    const x = ((button.x + button.width / 2) / panel.layoutWidth - 0.5) * panel.widthM;
    const y = (0.5 - (button.y + button.height / 2) / panel.height) * panel.heightM;
    const target = M.point(panel.roomFromPanel, [x, y, 0]);
    const origin = [0.1, 1.0, -0.25];
    const z = [0, 1, 2].map((i) => origin[i] - target[i]);
    const zz = z.map((v) => v / Math.hypot(...z));
    let xx = [zz[2], 0, -zz[0]];
    xx = xx.map((v) => v / Math.hypot(...xx));
    const yy = [zz[1] * xx[2] - zz[2] * xx[1], zz[2] * xx[0] - zz[0] * xx[2], zz[0] * xx[1] - zz[1] * xx[0]];
    window.__xrMock.rayMatrix = new Float32Array([...xx, 0, ...yy, 0, ...zz, 0, ...origin, 1]);
  }, id);
  await frames(1);
  await page.evaluate(() => window.__xrMock.session.dispatch("selectstart", { inputSource: window.__xrMock.controller }));
  await page.evaluate(() => window.__xrMock.session.dispatch("selectend", { inputSource: window.__xrMock.controller }));
  await page.evaluate(() => (window.__xrMock.rayMatrix = null));
};
const waitStatus = async (pattern) => {
  for (let i = 0; i < 300; i++) {
    const status = await page.evaluate(() => window.slicerXR.session.panel.status);
    if (pattern.test(status)) return status;
    await frames(1);
    await page.waitForTimeout(100);
  }
  return page.evaluate(() => window.slicerXR.session.panel.status);
};

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
for (let i = 0; i < 300 && Number(await python("len(slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode'))")) === 0; i++) await page.waitForTimeout(1000);
check(await python("len(slicer.util.getNodesByClass('vtkMRMLVolumeRenderingDisplayNode'))") === "0", "MRHead is loaded by the page without volume rendering");

await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(3);
await page.evaluate(() => (window.slicerXR.session.panel.visible = false)); // only the head, in the eyes
await frames(2);
const status = await page.evaluate(() => window.slicerXR.session.panel.status);
check(await python("any(d.GetVisibility() for d in slicer.util.getNodesByClass('vtkMRMLVolumeRenderingDisplayNode'))") === "True", `entering VR shows it volume rendered (${status})`);
const on = await skin();
check(on > 2000, `the headset shows the head (${on} pixels)`);

await page.evaluate(() => (window.slicerXR.session.panel.visible = true));
await frames(1);
await page.evaluate(() => window.slicerXR.session.panel.setCategory("data"));
await frames(2);
const volumeEye = await page.evaluate(() => `eye:${window.slicerXR.session.panel.dataItems.find((i) => i.kind === "Volume").id}`);
await press(volumeEye);
await waitStatus(/hidden/);
await page.evaluate(() => (window.slicerXR.session.panel.visible = false));
await frames(2);
const off = await skin();
check(off < on / 10, `the volume's eye in the panel's data tree turns it off (${off} pixels)`);

await page.evaluate(() => (window.slicerXR.session.panel.visible = true));
await frames(1);
await press(volumeEye);
const again = await waitStatus(/is shown volume rendered/);
await page.evaluate(() => (window.slicerXR.session.panel.visible = false));
await frames(2);
const onAgain = await skin();
check(onAgain > 2000, `and on again (${onAgain} pixels; ${again})`);

await page.evaluate(() => window.__xrMock.session.end());
await page.waitForTimeout(1500);
check(logged.some((body) => /Slicer XR: page opened/.test(body ?? "")), "the page's messages are sent to the server");
await browser.close();
process.exit(failed ? 1 : 0);

// The first session showed nothing on the Quest, the next ones were fine. The frames were drawn: what
// framebuffer VTK copies its frame into is the one bound when it starts (framebuffer 0, made the
// headset's), and if the page left another bound - one of VTK's own - the frames went there. This
// leaves one bound before entering VR, as the page may, and the headset must show the scene.
//
// Usage: node tests/xr/stale-binding.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=&layout=OneUp3D";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
let time = 0;
const frames = (count) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start: (time += count * 14) });

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
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
// What the page may leave behind: a framebuffer of VTK's own bound, VTK's state knowing it
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
v = [v for v in slicer.app.layoutManager().views().values() if v.IsA('vtkSlicerWebThreeDView')][0]
w = v.GetRenderWindow()
w.MakeCurrent()
w.GetState().vtkglBindFramebuffer(0x8CA9, w.GetRenderFramebuffer().GetFBOIndex())
`));
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(3);
await page.evaluate(() => (window.slicerXR.session.panel.visible = false));
await frames(3);
const seen = await page.evaluate(() => window.__xrMock.sphere());
check(seen.every((e) => e.pixels > 500), `the first session shows the scene though the page left a framebuffer of VTK's bound (${seen.map((e) => e.pixels)} pixels)`);
await page.evaluate(() => window.__xrMock.session.end());
await browser.close();
process.exit(failed ? 1 : 0);

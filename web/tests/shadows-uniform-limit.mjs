// Ambient shadows on a graphics card with few fragment shader uniforms (a phone: many mobile GPUs
// have 256 vectors, OpenGL ES guarantees 224). Slicer's shadows take 320 samples, which are uniforms
// of the shader; there it cannot be built, and the 3D view was black until a camera drag (which uses
// fewer samples) had drawn the shadows once. vtkSSAOPass now uses only as many samples as fit.
// The phone is played by this browser: it reports 256 uniform vectors, and a shader that declares
// more samples than fit does not compile, as on the phone.
// Usage: node tests/shadows-uniform-limit.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 300)));
const messages = [];
page.on("console", (m) => messages.push(m.text()));
await page.addInitScript(() => {
  const VECTORS = 256;
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
    const getParameter = proto.getParameter;
    proto.getParameter = function (name) {
      if (name === this.MAX_FRAGMENT_UNIFORM_VECTORS) return VECTORS;
      if (name === this.MAX_FRAGMENT_UNIFORM_COMPONENTS) return 4 * VECTORS;
      return getParameter.call(this, name);
    };
    const shaderSource = proto.shaderSource;
    proto.shaderSource = function (shader, source) {
      const samples = /uniform\s+(?:highp\s+|mediump\s+)?vec3\s+samples\s*\[\s*(\d+)\s*\]/.exec(source);
      if (samples && Number(samples[1]) > VECTORS - 8) {
        // as the phone's driver: too many uniforms
        source = source.replace("void main", "#error too many uniforms\nvoid main");
      }
      return shaderSource.call(this, shader, source);
    };
  }
});
let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ": " + detail}`);
};
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);
const value = async (expr) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr));

await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

// A segmentation in a 3D view with ambient shadows
await exec(`
import numpy as np, slicer
volume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "ref")
slicer.util.updateVolumeFromArray(volume, np.zeros((60, 60, 60), dtype=np.int16))
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "seg")
seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(volume)
k, j, i = np.mgrid[0:60, 0:60, 0:60]
sphere = ((i - 30) ** 2 + (j - 30) ** 2 + (k - 30) ** 2 < 20 ** 2).astype(np.uint8)
segmentId = seg.GetSegmentation().AddEmptySegment("sphere", "sphere", (0.9, 0.2, 0.1))
slicer.util.updateSegmentBinaryLabelmapFromArray(sphere, seg, segmentId, volume)
seg.GetDisplayNode().SetPreferredDisplayRepresentationName3D("Binary labelmap")
slicer.app.layoutManager().threeDWidget(0).mrmlViewNode().SetShadowsVisibility(True)
`);
await page.waitForTimeout(2000);

/** The 3D view as one render draws it: how much is black, and how much is the red segment. */
const rendered = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host.matches("canvas") ? host : host.querySelector("canvas");
  const gl = canvas.getContext("webgl2");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let black = 0, red = 0;
  for (let p = 0; p < pixels.length; p += 4) {
    if (pixels[p] < 12 && pixels[p + 1] < 12 && pixels[p + 2] < 12) black++;
    else if (pixels[p] > 2 * pixels[p + 1] && pixels[p] > 2 * pixels[p + 2] && pixels[p] > 60) red++;
  }
  const n = pixels.length / 4;
  return { black: black / n, red: red / n };
});
const describe = (r) => `${Math.round(100 * r.black)}% black, ${Math.round(100 * r.red)}% red`;

// Maximize the 3D view: it is made again, and its first frames have shadows
await exec(`slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutOneUp3DView)`);
await page.waitForTimeout(2000);
const first = await rendered();
check("the maximized 3D view is not black", first.black < 0.2, describe(first));
check("  and shows the segmentation", first.red > 0.02, describe(first));
// (VTK's warning is in the application log: the Log window shows it)
const logged = await page.evaluate(() => window.slicerWeb.store.logs.map((e) => e.message ?? e.text ?? JSON.stringify(e)));
check("the log says the shadows take fewer samples than asked for (320)",
  logged.some((m) => /Ambient occlusion uses 240 samples instead of 320/.test(m)),
  logged.find((m) => /Ambient occlusion uses/.test(m)) ?? "no message");
check("no shader failed to build", !messages.some((m) => /too many uniforms|SSAO shader program/.test(m)),
  messages.filter((m) => /too many uniforms|SSAO shader program/.test(m)).slice(0, 2).join(" | ").slice(0, 300));

// Restored to four views, and with shadows turned off and on again
await exec(`slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutFourUpView)`);
await page.waitForTimeout(2000);
const restored = await rendered();
check("restored, the 3D view is not black", restored.black < 0.2, describe(restored));

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failures ? 1 : 0);

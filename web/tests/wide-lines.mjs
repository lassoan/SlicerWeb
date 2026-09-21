// Lines wider than one pixel: VTK draws those with a geometry shader, which a WebGL build has not
// got. Nothing must ask for one - a shader that is refused leaves the whole actor undrawn, which is
// what took the interaction handles of markups with it on some devices.
// Usage: node tests/wide-lines.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const shaderMessages = [];
page.on("console", (m) => {
  const t = m.text();
  if (/Geometry shaders are not supported|Could not set shader program/.test(t)) shaderMessages.push(t.slice(0, 120));
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json, vtk"));

// a markups line with a thick line, a curve, and an ROI with its interaction handles
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
line = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode", "Line")
line.AddControlPoint(-80.0, 0.0, -150.0); line.AddControlPoint(80.0, 0.0, -150.0)
line.GetDisplayNode().SetLineThickness(3.0)
line.GetDisplayNode().SetColor(1.0, 1.0, 0.0)
line.GetDisplayNode().SetSelectedColor(1.0, 1.0, 0.0)
roi = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsROINode", "ROI")
roi.SetCenter(0.0, 0.0, -150.0); roi.SetSize(120.0, 120.0, 80.0)
roi.CreateDefaultDisplayNodes(); roi.GetDisplayNode().SetHandlesInteractive(True)
`));
await page.waitForTimeout(3000);
await page.evaluate(() => window.slicerWeb.bridge.call("resetThreeDViews"));
await page.waitForTimeout(1500);

// what is on the screen: coloured (not grey) pixels of the 3D view
const coloured = await page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const view = document.querySelector("#slicer-view-1");
  const canvas = view.matches("canvas") ? view : view.querySelector("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) count++;
  }
  return count;
});
console.log("markups pixels drawn in the 3D view:", coloured);
console.log("shader failures:", shaderMessages.length, shaderMessages[0] ?? "");
console.log("hardware line width range:", await py('json.dumps(list(slicer.app.layoutManager().view("1").GetRenderWindow().GetMaximumHardwareLineWidth() for _ in [0]))'));
if (shot) await page.screenshot({ path: shot, clip: await page.locator("#slicer-view-1").boundingBox() });
await browser.close();

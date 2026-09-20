// Thick lines: WebGL has no geometry shaders, which VTK uses for lines wider than one pixel.
// Places a markups line in a slice view and counts its coloured pixels in the rendered view.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on("console", (m) => { if (/shader|Could not set/i.test(m.text())) errors.push(m.text().slice(0, 120)); });
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json"));

// a line between two points in the Red slice view
await page.evaluate(() => window.slicerWeb.bridge.call("placeMarkup", ["vtkMRMLMarkupsLineNode", "Line", true]));
const box = await page.locator("#slicer-view-Red").boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
for (const p of [[0.35, 0.4], [0.65, 0.6]]) { await page.mouse.click(...at(...p)); await page.waitForTimeout(500); }
await page.evaluate(() => window.slicerWeb.bridge.call("setInteractionMode", ["ViewTransform"]));
await page.waitForTimeout(1500);
// the labels are hidden so that only the line is measured in the middle of the view
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
_display = slicer.util.getNode("Line").GetDisplayNode()
_display.SetPointLabelsVisibility(False)
_display.SetPropertiesLabelVisibility(False)
`));
await page.waitForTimeout(500);

// count the pixels of the line colour (the markups colour is far from the grey CT image)
const count = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["Red"]);
  const view = document.querySelector("#slicer-view-Red");
  const canvas = view.matches("canvas") ? view : view.querySelector("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  // only the middle of the view, half way between the two control points, where just the line is
  let coloured = 0;
  const half = 40;
  for (let y = canvas.height / 2 - half; y < canvas.height / 2 + half; y++) {
    for (let x = canvas.width / 2 - half; x < canvas.width / 2 + half; x++) {
      const i = (Math.round(y) * canvas.width + Math.round(x)) * 4;
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) coloured++;   // not grey: markups colour
    }
  }
  return { coloured, pixels: 4 * half * half };
});
const counts = await count();
console.log(`line thickness default: coloured pixels ${counts.coloured} of ${counts.pixels} around the middle`);
for (const thickness of [0.5, 1.0, 3.0]) {
  await page.evaluate((t) => window.slicerWeb.bridge.evalPython(`slicer.util.getNode("Line").GetDisplayNode().SetLineThickness(${t})`), thickness);
  await page.waitForTimeout(800);
  const c = await count();
  console.log(`line thickness ${thickness}: coloured pixels ${c.coloured}`);
}
console.log(`shader errors: ${errors.length}${errors.length ? " e.g. " + errors[0] : ""}`);
if (shot) await page.screenshot({ path: shot, clip: box });
await browser.close();

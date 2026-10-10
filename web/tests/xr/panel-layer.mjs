// The panel as a WebXR quad layer (where the browser has layers, as the Quest's does): the headset
// draws it at the resolution of its display, not at the 3D view's. The session gets two layers
// (the 3D view's and the panel's), the panel's picture is put in the quad's texture - the right way
// up, at twice the panel layout's pixels - and again when it changes (a button pressed), the plane
// in the scene is not drawn, and B hides the layer and shows it again.
//
// Usage: node tests/xr/panel-layer.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=&layout=OneUp3D&layers";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => {
  if (m.type() === "error" || /quad|layers/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });

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
/** How bright the top and the bottom tenth of the quad's picture are, and a digest of it. */
const quad = () => page.evaluate(() => {
  const q = window.__xrMock.quadPixels();
  if (!q) return null;
  const { w, h, pixels } = q;
  const white = (y0, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) n++;
    }
    return n;
  };
  let digest = 0;
  for (let i = 0; i < pixels.length; i += 97) digest = (digest * 31 + pixels[i]) >>> 0;
  // As an image (rows from the top) for looking at
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  const image = context.createImageData(w, h);
  for (let y = 0; y < h; y++) image.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  context.putImageData(image, 0, 0);
  // the first row is the bottom: the top strip is the last rows
  // The title strip (white) against the footer strip (grey): which way up the picture is
  return { w, h, top: white(Math.floor(h * 0.93), h), bottom: white(0, Math.ceil(h * 0.035)), digest, image: canvas.toDataURL("image/png") };
});
const layers = () => page.evaluate(() => {
  const state = window.__xrMock.session.renderState;
  return { count: state.layers?.length ?? 0, second: state.layers?.[1] === window.__xrMock.quad };
});
const press = (id) => page.evaluate((id) => {
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
}, id).then(() => frames(1)).then(() => page.evaluate(() => {
  window.__xrMock.session.dispatch("selectstart", { inputSource: window.__xrMock.controller });
  window.__xrMock.session.dispatch("selectend", { inputSource: window.__xrMock.controller });
  window.__xrMock.rayMatrix = null;
})).then(() => frames(2));
const toggle = async () => {
  await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[5].pressed = true));
  await frames(1);
  await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[5].pressed = false));
  await frames(1);
};

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(4);

const requested = await page.evaluate(() => window.__xrMock.requested.options.optionalFeatures);
check(requested.includes("layers"), "the session asks for WebXR layers");
let l = await layers();
check(l.count === 2, `the session draws two layers: the 3D view's and the panel's quad (${l.count})`);
const size = await page.evaluate(() => {
  const q = window.__xrMock.quad, p = window.slicerXR.session.panel;
  return { w: q.width, h: q.height, pw: p.widthM, ph: p.heightM, px: q.init.viewPixelWidth };
});
check(Math.abs(size.w - size.pw) < 1e-9 && Math.abs(size.h - size.ph) < 1e-9 && size.px === 1000, `the quad is the panel's size (${size.w.toFixed(2)} x ${size.h.toFixed(2)} m), at 1000 pixels across`);
check(await python("slicerXR.panel.GetVisibility()") === "0", "the panel is not drawn in the scene as well");
let picture = await quad();
fs.writeFileSync("tests/panel-layer.png", Buffer.from(picture.image.split(",")[1], "base64"));
check(picture.top > 3 * Math.max(1, picture.bottom), `its picture is the right way up: the white title at the top (${picture.top} white pixels at the top, ${picture.bottom} at the bottom)`);

// Where the panel is: off to the right of where the viewer looks, about 85 cm away, a little low
const placed = await page.evaluate(() => {
  const m = window.slicerXR.session.panel.roomFromPanel, head = window.slicerXR.session.head;
  return { x: m[12] - head[12], y: m[13] - head[13], z: m[14] - head[14], width: window.slicerXR.session.panel.widthM };
});
const distance = Math.hypot(placed.x, placed.y, placed.z);
check(placed.x > 0.3 && distance > 0.75 && distance < 0.95 && placed.y < 0, `the panel is off to the right, ${distance.toFixed(2)} m away, a little below the eyes`);
check(placed.width < 0.35, `and smaller (${(placed.width * 100).toFixed(0)} cm across)`);

// The panel's layer is under the 3D view's, which is clear where the panel is (but for what is in
// front of it: the rays, the controllers) and opaque elsewhere (VR)
const order = () => page.evaluate(() => {
  const layers = window.__xrMock.session.renderState.layers ?? [];
  return { count: layers.length, first: layers[0] === window.__xrMock.quad, last: layers[layers.length - 1] === window.__xrMock.layer };
});
l = await order();
check(l.count === 2 && l.first && l.last, "the panel's layer is under the 3D view's");
/** Pixels of the 3D view's frame: how many are clear (alpha 0), partly clear, and white. */
const alpha = () => page.evaluate(() => {
  const { W, H, gl, layer } = window.__xrMock;
  const pixels = new Uint8Array(2 * W * H * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.framebuffer);
  gl.readPixels(0, 0, 2 * W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  let clear = 0, partly = 0, white = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) clear++;
    else if (pixels[i + 3] < 250) partly++;
    else if (pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220) white++;
  }
  return { clear, partly, white, total: 2 * W * H };
});
let a0 = await alpha();
check(a0.clear > 2000 && a0.clear < a0.total / 2, `the 3D view is clear where the panel is (${a0.clear} of ${a0.total} pixels), opaque elsewhere`);
check(a0.partly > 300, `with a soft edge: the sky fades out over a few pixels at the panel's edge (${a0.partly} partly clear pixels)`);
const saveComposite = async (file, zoom, crop) => fs.writeFileSync(file, Buffer.from((await page.evaluate(([zoom, crop]) => window.__xrMock.composite(zoom, crop), [zoom, crop])).split(",")[1], "base64"));
await saveComposite("tests/panel-layer-eye.png", 3, [0.55, 0.3, 1, 0.95]);

// Pointing at the panel: the ray is drawn in the 3D view, over the panel; the button pointed at is
// shown lighter by a small layer of its own over the panel's, and the panel's picture is not drawn again
const pictureBefore = await quad();
await page.evaluate(() => {
  const { M } = window.slicerXR.internals;
  const panel = window.slicerXR.session.panel;
  const button = panel.buttons.find((b) => b.id === "tool:vtkMRMLMarkupsLineNode");
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
  window.__testTarget = target;
});
await frames(3);
check(await page.evaluate(() => window.slicerXR.session.panel.hover) === "tool:vtkMRMLMarkupsLineNode", "the ray points at the Line button");
l = await order();
check(l.count === 3 && l.first && l.last, `the button pointed at is a layer between the panel's and the 3D view's (${l.count} layers)`);
const hover = await page.evaluate(() => {
  const mock = window.__xrMock, panel = window.slicerXR.session.panel;
  const layer = mock.session.renderState.layers[1];
  const button = panel.buttons.find((b) => b.id === "tool:vtkMRMLMarkupsLineNode");
  const p = layer.transform.position, t = window.__testTarget;
  const picture = mock.quadPixels(layer);
  const at = (fx, fy) => {
    const i = (Math.floor(fy * picture.h) * picture.w + Math.floor(fx * picture.w)) * 4;
    return [picture.pixels[i], picture.pixels[i + 1], picture.pixels[i + 2], picture.pixels[i + 3]];
  };
  return {
    offCentre: Math.hypot(p.x - t[0], p.y - t[1], p.z - t[2]),
    width: layer.width, height: layer.height,
    expected: [(button.width + 8) / 3200, (button.height + 8) / 3200],
    pixels: [picture.w, picture.h],
    fill: at(0.9, 0.5), // inside the button
    edge: at(0.5, 0.06), // on its top edge (the texture's first row is its bottom: either edge will do)
    corner: at(0.002, 0.01), // outside the button's rounded corner
    drawn: layer.drawn,
  };
});
check(hover.offCentre < 0.001 && Math.abs(hover.width - hover.expected[0]) < 1e-6 && Math.abs(hover.height - hover.expected[1]) < 1e-6,
  `it is exactly over the button (${(hover.offCentre * 1000).toFixed(2)} mm off its centre; ${(hover.width * 1000).toFixed(1)} x ${(hover.height * 1000).toFixed(1)} mm)`);
check(hover.pixels[0] * hover.pixels[1] * 4 < 150000, `its picture is small to send (${hover.pixels.join("x")}: ${Math.round(hover.pixels[0] * hover.pixels[1] * 4 / 1024)} KB)`);
check(hover.fill[3] > 40 && hover.fill[3] < 62 && hover.fill.slice(0, 3).every((v) => Math.abs(v - hover.fill[3]) < 3),
  `it lights the button: a clear white over it, premultiplied (${hover.fill})`);
check(hover.edge[3] > 200 && hover.corner[3] === 0, `with a bright edge, and nothing outside the button's shape (edge ${hover.edge}, corner ${hover.corner})`);

// Pointing at its neighbour moves the layer, and that is all: the layer has no label on it, and its
// picture is not drawn again (a label drawn on it showed on the wrong button for a moment, the
// headset not changing a layer's picture and its place in the same instant)
await page.evaluate(() => {
  const { M } = window.slicerXR.internals;
  const panel = window.slicerXR.session.panel;
  const button = panel.buttons.find((b) => b.id === "tool:vtkMRMLMarkupsAngleNode");
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
  window.__testTarget = target;
});
await frames(3);
const moved = await page.evaluate(() => {
  const layer = window.__xrMock.session.renderState.layers[1];
  const p = layer.transform.position, t = window.__testTarget;
  return { hover: window.slicerXR.session.panel.hover, off: Math.hypot(p.x - t[0], p.y - t[1], p.z - t[2]), drawn: layer.drawn };
});
check(moved.hover === "tool:vtkMRMLMarkupsAngleNode" && moved.off < 0.001 && moved.drawn === hover.drawn && hover.drawn === 1,
  `pointing at the next button moves the layer onto it, and its picture is not drawn again (drawn ${moved.drawn} time)`);
check(await python("[slicerXR.rays[0].GetVisibility(), slicerXR.hole.GetVisibility(), slicerXR.ring.GetVisibility()]") === "[1, 1, 1]",
  "the ray is drawn in the 3D view, with the clear plane and its soft edge over the panel");
await saveComposite("tests/panel-layer-pointing.png", 3, [0.55, 0.3, 1, 0.95]);
const a1 = await alpha();
check(a1.clear < a0.clear && a1.white > a0.white + 20, `the ray is drawn over the panel (${a0.clear - a1.clear} clear pixels fewer, ${a1.white - a0.white} white ones more)`);
// The ray's edges are soft: over the panel they are partly clear, and over the sky there are
// pixels between the sky's colour and the ray's white (a line drawn as a line has neither)
const blended = await page.evaluate(() => {
  const { W, H, gl, layer } = window.__xrMock;
  const pixels = new Uint8Array(2 * W * H * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, layer.framebuffer);
  gl.readPixels(0, 0, 2 * W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  // Opaque pixels whose neighbour to the right is the ray's white, and that are neither white nor
  // as dark as the sky two pixels further away from the ray
  let soft = 0;
  for (let y = 0; y < H; y++) for (let x = 2; x < 2 * W - 1; x++) {
    const i = (y * 2 * W + x) * 4, right = i + 4, far = i - 8;
    const white = (k) => pixels[k] > 240 && pixels[k + 1] > 240 && pixels[k + 2] > 240 && pixels[k + 3] === 255;
    if (pixels[i + 3] === 255 && pixels[far + 3] === 255 && white(right) && !white(i) && pixels[i] > pixels[far] + 12) soft++;
  }
  return soft;
});
check(a1.partly > a0.partly + 20 && blended > 20, `the ray has soft edges (${a1.partly - a0.partly} partly clear pixels more over the panel, ${blended} blended pixels beside it over the sky)`);
const pictureAfter = await quad();
check(pictureAfter.digest === pictureBefore.digest, "the panel's picture is not drawn again for pointing at a button");
check(pictureAfter.w * pictureAfter.h * 4 < 7e6, `the panel's picture is ${(pictureAfter.w * pictureAfter.h * 4 / 1048576).toFixed(1)} MB (${pictureAfter.w}x${pictureAfter.h})`);
await page.evaluate(() => (window.__xrMock.rayMatrix = null));
await frames(2);
l = await order();
check(await python("slicerXR.rays[0].GetVisibility()") === "0" && l.count === 2, "pointing away, the ray and the button's layer go");
await frames(1);

// What is behind the panel is hidden by it: a red ball 20 cm behind its middle does not show
await page.evaluate(() => {
  const { M } = window.slicerXR.internals;
  const s = window.slicerXR.session;
  const world = M.point(M.multiply(s.worldFromRoom, s.panel.roomFromPanel), [0, 0, -0.2]);
  const radius = 0.04 * M.scaleOf(s.worldFromRoom);
  return window.slicerWeb.bridge.evalPython([
    "import vtk, slicer",
    "ball = vtk.vtkSphereSource()",
    `ball.SetCenter(${world[0]}, ${world[1]}, ${world[2]})`,
    `ball.SetRadius(${radius})`,
    "ball.Update()",
    "BALL = slicer.modules.models.logic().AddModel(ball.GetOutput())",
    "BALL.GetDisplayNode().SetColor(1, 0, 0)",
  ].join("\n"));
});
await frames(3);
const red = () => page.evaluate(() => window.__xrMock.sphere().map((e) => e.pixels));
const hidden = await red();
check(hidden.every((n) => n === 0) && (await python("slicerXR.renderer.GetViewProps().GetItemAsObject(0) is slicerXR.hole")) === "True",
  `something behind the panel is hidden by it (${hidden} of its pixels show)`);
await page.evaluate(() => (window.slicerXR.session.panel.visible = false));
await frames(3);
const shown = await red();
check(shown.every((n) => n > 50), `and shows when the panel is hidden (${shown} pixels)`);
await page.evaluate(() => {
  window.slicerXR.session.panel.visible = true;
  return window.slicerWeb.bridge.evalPython("slicer.mrmlScene.RemoveNode(BALL)");
});
await frames(3);

await press("tool:vtkMRMLMarkupsLineNode");
const chosen = await page.evaluate(() => window.slicerXR.session.panel.activeTool);
const after = await quad();
check(chosen === "vtkMRMLMarkupsLineNode" && after.digest !== picture.digest, "a button pressed on it works, and its picture is drawn again");

await toggle();
l = await layers();
check(l.count === 1, "B hides the panel's layer");
check(await python("slicerXR.hole.GetVisibility()") === "0", "and the 3D view is not clear there any more");
await toggle();
l = await layers();
check(l.count === 2, "and shows it again");

await page.evaluate(() => window.__xrMock.session.end());
await page.waitForTimeout(500);
await browser.close();
process.exit(failed ? 1 : 0);

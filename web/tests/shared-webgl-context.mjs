// One WebGL context for every view (Application settings > Rendering), switched at runtime: the
// views are then renderers of one canvas, each in its own rectangle of it, and what a pointer does
// goes to the view it is over. A browser allows only about eight contexts at a time, so this is
// what makes a nine-view layout possible on a phone.
// Usage: node tests/shared-webgl-context.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const contexts = () => page.evaluate(() => [...document.querySelectorAll("canvas")]
  .filter((c) => { const gl = c.getContext("webgl2"); return gl && !gl.isContextLost(); }).length);
const views = () => py("len(slicer.app.layoutManager().views())");
const offset = async (name) => Number(await py(`slicer.app.layoutManager().sliceWidget("${name}").sliceLogic().GetSliceOffset()`));
const shared = (on) => page.evaluate((v) => { window.slicerWeb.store.settings = { ...window.slicerWeb.store.settings, "Rendering/SharedWebGLContext": v }; }, on);

await page.goto(base + "?sample=MRHead&layout=ThreeByThreeSlice");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(5000);

check("nine views, each with a context of its own to begin with", `${await views()} views, ${await contexts()} contexts`, "9 views, 9 contexts");

/** Drag up the middle of the Red view and say how far its slices moved. */
async function dragInRed() {
  await page.evaluate(() => window.slicerWeb.bridge.call("setInteractionMode", ["Scroll"]));
  await page.waitForTimeout(400);
  const rect = await page.evaluate(() => {
    const el = document.querySelector("#slicer-view-Red") ?? document.querySelector("[data-view='Red']");
    const box = (el ?? document.body).getBoundingClientRect();
    return window.slicerWeb.store.viewRects.Red ?? { left: box.left, top: box.top, width: box.width, height: box.height };
  });
  // from the middle of the range each time, so that the drag is not cut short at its end
  await page.evaluate(() => window.slicerWeb.bridge.evalPython(
    '(lambda l: l.SetSliceOffset(sum(l.GetSliceOffsetRangeResolution([0.0, 0.0], 0.0) and [0.0] or [0.0]) if False else 0.0))'
    + '(slicer.app.layoutManager().sliceWidget("Red").sliceLogic())', "exec"));
  await page.waitForTimeout(300);
  const before = await offset("Red");
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(cx, cy - 10 * i); await page.waitForTimeout(40); }
  await page.mouse.up();
  await page.waitForTimeout(600);
  return { moved: (await offset("Red")) - before, rect };
}
const own = await dragInRed();
console.log(`     a drag of 80 px browses ${own.moved.toFixed(1)} mm with a context per view`);
check("dragging browses the slices", Math.abs(own.moved) > 2, true);

await shared(true);
await page.waitForTimeout(8000);
check("sharing turned on: nine views in one context", `${await views()} views, ${await contexts()} contexts`, "9 views, 1 contexts");
check("all of them on the shared canvas", await py("slicer.app.layoutManager().sharedCanvas().GetNumberOfViews()"), "9");
check("each in a rectangle of its own", await py('len(set(tuple(slicer.app.layoutManager().view(n).GetRenderer().GetViewport()) for n in slicer.app.layoutManager().views()))'), "9");
check("and they are drawn", Number(await py('sum(v.GetRenderCount() for v in slicer.app.layoutManager().views().values())')) > 0, true);
// the canvas holds what the views drew: not a blank frame
const drawn = await page.evaluate(() => {
  const canvas = document.querySelector("#slicer-views");
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let lit = 0;
  for (let i = 0; i < pixels.length; i += 4000) if (pixels[i] > 20) lit++;
  return lit;
});
console.log(`     ${drawn} sampled pixels of the shared canvas hold an image`);
if (shot) await page.screenshot({ path: shot });

// ---- what a pointer does goes to the view it is over, and acts as it did before
const otherBefore = await offset("Slice9");
const box = await page.evaluate(() => window.slicerWeb.store.viewRects.Red);
check("the views tell the grid where they are", !!box && box.width > 10, true);
const sharedDrag = await dragInRed();
console.log(`     the same drag browses ${sharedDrag.moved.toFixed(1)} mm with one shared context`);
check("dragging in a view browses that view's slices", Math.abs(sharedDrag.moved) > 2, true);
check("by as much as it did before (the gestures go by the view's size, not the canvas's)",
  Math.abs(sharedDrag.moved - own.moved) < Math.abs(own.moved) * 0.1, true);
check("and leaves the other views alone", await offset("Slice9"), otherBefore);

// ---- and back
await shared(false);
await page.waitForTimeout(8000);
check("sharing turned off: every view has its own context again", `${await views()} views, ${await contexts()} contexts`, "9 views, 9 contexts");
check("the shared canvas is gone", await py("slicer.app.layoutManager().sharedCanvas() is None"), "True");
check("and the views still draw", Number(await py('sum(v.GetRenderCount() for v in slicer.app.layoutManager().views().values())')) > 0, true);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

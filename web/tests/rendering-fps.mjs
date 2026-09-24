// Application settings > Developer > Show rendering FPS: every view shows in its top right corner
// how many times it rendered in the last second and how long its last render took.
// Usage: node tests/rendering-fps.mjs [url] [screenshot.png]
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
const views = (expr) => py(`",".join(str(${expr}) for v in slicer.app.layoutManager().views().values())`);

await page.goto(base + "?sample=MRHead&layout=FourUp");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(3000);
check("hidden to begin with", await views("v.GetFPSVisible()"), "False,False,False,False");

/** Tick the box in the dialog. */
async function toggleInDialog() {
  await page.evaluate(() => { window.slicerWeb.store.settingsDialogOpen = true; });
  await page.getByRole("button", { name: "Developer", exact: true }).click();
  await page.locator("[data-name=showRenderingFPS]").click();
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.slicerWeb.store.settingsDialogOpen = false; });
}
/** Rotate the 3D view for a while: it renders at every move. */
async function rotate3D() {
  const r = await page.evaluate(() => {
    const el = document.querySelector("#slicer-view-1");
    if (el) { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; }
    return window.slicerWeb.store.viewRects["1"];
  });
  const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) { await page.mouse.move(cx + 3 * i, cy); await page.waitForTimeout(30); }
  await page.mouse.up();
}

await toggleInDialog();
check("the setting is on", await page.evaluate(() => window.slicerWeb.store.settings["Developer/ShowRenderingFPS"]), true);
check("every view shows it", await views("v.GetFPSVisible()"), "True,True,True,True");
await rotate3D();
const fps = Number(await py('slicer.app.layoutManager().views()["1"].GetFramesPerSecond()'));
const ms = Number(await py('slicer.app.layoutManager().views()["1"].GetLastRenderTime()'));
console.log(`     3D view while rotating: ${fps} fps, last render ${ms.toFixed(1)} ms`);
check("the 3D view counts its renders", fps > 0, true);
check("and times them", ms > 0, true);
if (shot) await page.screenshot({ path: shot });

// kept with the views when they are made anew, as they are when the context is shared
await page.evaluate(() => { window.slicerWeb.store.settings = { ...window.slicerWeb.store.settings, "Rendering/SharedWebGLContext": true }; });
await page.waitForTimeout(8000);
check("views sharing a context show it too", await views("v.GetFPSVisible()"), "True,True,True,True");
await rotate3D();
check("and count their renders", Number(await py('slicer.app.layoutManager().views()["1"].GetFramesPerSecond()')) > 0, true);
await page.evaluate(() => { window.slicerWeb.store.settings = { ...window.slicerWeb.store.settings, "Rendering/SharedWebGLContext": false }; });
await page.waitForTimeout(8000);

await toggleInDialog();
check("turned off: hidden again", await views("v.GetFPSVisible()"), "False,False,False,False");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

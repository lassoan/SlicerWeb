// What is done differently for the Quest: its browser's compositor takes a quad layer's width and
// height for half of the quad (the panel showed twice as large, its buttons not where the ray and
// the outline were), so they are halved there; and depth peeling is off for the session (sessions
// with it showed nothing on the Quest), the view node getting it back after.
//
// Usage: node tests/xr/quest-specifics.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=&layout=OneUp3D&layers";
const QUEST = "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/152.1.0.34.52 Chrome/152.0.7977.83 VR Safari/537.36";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

for (const [name, userAgent] of [["the Quest's browser", QUEST], ["another browser", undefined]]) {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 }, ...(userAgent ? { userAgent } : {}) })).newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
  await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });
  await page.goto(url);
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
  const python = (e) => page.evaluate((e) => window.slicerWeb.bridge.evalPython(e, "eval"), e);
  const peelingBefore = await python("slicer.app.layoutManager().views()['1'].GetMRMLViewNode().GetUseDepthPeeling()");
  await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
  await page.locator("#slicer-xr button.vr").click();
  await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
  await page.evaluate(() => { for (let i = 0; i < 3; i++) window.__xrMock.frame(i * 14); });
  const size = await page.evaluate(() => ({ w: window.__xrMock.quad.width, pw: window.slicerXR.session.panel.widthM, h: window.__xrMock.quad.height, ph: window.slicerXR.session.panel.heightM }));
  const factor = userAgent ? 0.5 : 1;
  check(Math.abs(size.w - size.pw * factor) < 1e-9 && Math.abs(size.h - size.ph * factor) < 1e-9,
    `${name}: the panel's layer is given ${factor === 0.5 ? "half its width and height" : "its width and height"} (${size.w.toFixed(3)} x ${size.h.toFixed(3)} for a ${size.pw.toFixed(3)} x ${size.ph.toFixed(3)} m panel)`);
  if (userAgent) {
    check(await python("slicer.app.layoutManager().views()['1'].GetMRMLViewNode().GetUseDepthPeeling()") === "0", `depth peeling is off in the session (it was ${peelingBefore})`);
    await page.evaluate(() => window.__xrMock.session.end());
    await page.waitForTimeout(500);
    check(await python("slicer.app.layoutManager().views()['1'].GetMRMLViewNode().GetUseDepthPeeling()") === peelingBefore, "and as it was after");
  }
  await page.context().close();
}
await browser.close();
process.exit(failed ? 1 : 0);

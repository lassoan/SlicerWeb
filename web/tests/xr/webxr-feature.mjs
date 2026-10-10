// The feature webxr of application.json decides whether the page offers WebXR: with it, the page
// loads xr/slicer-xr.js and shows Enter VR; without it (or with it false), the page asks for no XR
// file and shows no XR button. The application's configuration (wheels/application.json) is
// replaced here, so that one server shows all three.
//
// Usage: node tests/xr/webxr-feature.mjs [url]  (python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

/** The page with this configuration: whether it asked for XR files, and shows the XR buttons. */
async function open(features) {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
  await page.route("**/wheels/application.json", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ features }) }));
  const asked = [];
  page.on("request", (r) => {
    if (/\/xr\/slicer(-xr\.js|_xr\.py)/.test(r.url())) asked.push(r.url().split("/").pop());
  });
  await page.goto(url);
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
  await page.waitForTimeout(3000);
  const buttons = await page.evaluate(() => !!document.querySelector("#slicer-xr button.vr") && !!window.slicerXR);
  await page.context().close();
  return { asked, buttons };
}

let r = await open({ webxr: true });
check(r.asked.includes("slicer-xr.js") && r.buttons, `with "webxr": true the page loads the XR script and shows Enter VR (asked for ${r.asked.join(", ")})`);
r = await open({});
check(r.asked.length === 0 && !r.buttons, "without the feature it asks for no XR file and shows no XR button");
r = await open({ webxr: false });
check(r.asked.length === 0 && !r.buttons, 'with "webxr": false the same');
await browser.close();
process.exit(failed ? 1 : 0);

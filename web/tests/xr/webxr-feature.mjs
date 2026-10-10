// The feature webxr of application.json decides whether the page offers WebXR, and whether its
// setting (Application settings > General > Virtual and augmented reality, XR/Enabled) is on at
// first: enabledByDefault - the XR script loaded and Enter VR shown; disabledByDefault - the script
// loaded but no button until the setting is turned on (and a user's choice kept across a reload);
// unavailable, or no feature - no XR file asked for, no button. The application's configuration
// (wheels/application.json) is replaced here, so that one server shows them all.
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

/** A page with this configuration (in a browser profile of its own, or the one given). */
async function open(features, context = null) {
  context ??= await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
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
  const shown = () => page.evaluate(() => {
    const root = document.querySelector("#slicer-xr");
    return !!root && !root.hidden && !!root.querySelector("button.vr");
  });
  return { page, context, asked, shown };
}

let r = await open({ webxr: "enabledByDefault" });
check(r.asked.includes("slicer-xr.js") && await r.shown(), `enabledByDefault: the page loads the XR script and shows Enter VR (asked for ${r.asked.join(", ")})`);
await r.context.close();

r = await open({ webxr: "disabledByDefault" });
check(r.asked.includes("slicer-xr.js") && !(await r.shown()), "disabledByDefault: the page loads the XR script, but shows no XR button");
// The setting turned on (as its checkbox in Application settings does): the buttons, and kept
await r.page.evaluate(() => {
  const store = window.slicerWeb.store;
  store.settings = { ...store.settings, "XR/Enabled": true };
  localStorage.setItem("slicerweb.settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("slicerweb.settings") ?? "{}"), "XR/Enabled": true }));
});
await r.page.waitForTimeout(1500);
check(await r.shown(), "the setting turned on, Enter VR is shown");
await r.page.close();
const again = await open({ webxr: "disabledByDefault" }, r.context);
check(await again.shown(), "and after a reload too: a user's choice stays, whatever the default");
await r.context.close();

for (const features of [{ webxr: "unavailable" }, {}]) {
  r = await open(features);
  check(r.asked.length === 0 && !(await r.shown()), `${JSON.stringify(features)}: no XR file asked for, no XR button`);
  await r.context.close();
}
await browser.close();
process.exit(failed ? 1 : 0);

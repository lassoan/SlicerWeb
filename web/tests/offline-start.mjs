// What a start needs is kept by a service worker: the second start is served from the cache, and
// a start with no network at all still reaches the views.
// Usage: node tests/offline-start.mjs [url]   (a built site: the development server has no worker)
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:4173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const ready = (page) => page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });

// First start: the worker installs and fills its cache as the start goes
let page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let t0 = Date.now();
await page.goto(base + "?sample=");
await ready(page);
console.log(`first start: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready.then(() => true), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
const cached = await page.evaluate(async () => {
  const names = (await caches.keys()).filter((n) => n.startsWith("slicerweb-"));
  const entries = names.length ? (await (await caches.open(names[0])).keys()).map((r) => r.url) : [];
  return { names, count: entries.length, wheels: entries.filter((u) => u.endsWith(".whl")).length,
           pyodide: entries.filter((u) => /\/pyodide\//.test(u)).length, cdn: entries.filter((u) => u.includes("cdn.jsdelivr.net")).length };
});
check("one cache, named after the build", cached.names.length, 1);
check("the wheels are in it", cached.wheels >= 5, true);
console.log(`cached: ${cached.count} entries - ${cached.wheels} wheels, ${cached.pyodide} runtime files, ${cached.cdn} from the Pyodide distribution`);
await page.close();

// Second start, with the network gone
await context.setOffline(true);
page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
t0 = Date.now();
let started = true;
await page.goto(base + "?sample=").catch((e) => { started = false; console.log("offline navigation failed:", e.message.split("\n")[0]); });
if (started) await ready(page).catch(() => { started = false; });
check("a start with no network reaches the views", started, true);
if (started) {
  console.log(`offline start: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  check("and the scene is there", await page.evaluate(() => window.slicerWeb.bridge.evalPython("slicer.mrmlScene.GetNumberOfNodes() > 0", "eval")), "True");
}
await context.setOffline(false);
await page.close();

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

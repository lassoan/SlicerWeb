// Install an extension through the Extensions Manager and report its modules.
// Usage: node tests/extension-install.mjs <ExtensionName> [url] [screenshot.png]
import { chromium } from "playwright-core";

const [name, url = "http://localhost:5173/?sample=", shot] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
page.on("console", (m) => {
  const t = m.text();
  if (/GL Driver|Feedback loop/.test(t)) return;
  if (m.type() === "error" || m.type() === "warning" || /need Python package|Python package/.test(t)) console.log(`${stamp()} [${m.type()}] ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`${stamp()} [pageerror] ${e}`));
await page.goto(url);
await page.evaluate(() => localStorage.removeItem("slicerweb.extensions"));
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 180000 });
console.log(`${stamp()} app ready`);
// The Extensions Manager is in the application menu, behind the cogwheel at the end of the toolbar
await page.getByLabel("Application menu").click();
await page.locator("[role=menuitem]", { hasText: /extensions manager/i }).first().click();
// The card whose title is the name - not one that only mentions it among its dependencies
const card = page.locator("div.mb-2").filter({ has: page.locator("*", { hasText: new RegExp("^" + name + "$") }) }).first();
await card.getByRole("button", { name: /install/i }).click();
await page.waitForFunction((n) => new RegExp(`${n} installed|failed`).test(document.body.innerText), name, { timeout: 600000 });
console.log(`${stamp()} ${(await page.locator(".bg-accent").first().innerText()).slice(0, 400)}`);
const report = await page.evaluate(async () => {
  const b = window.slicerWeb.bridge;
  await b.evalPython(`
import slicer, json, logging
mm = slicer.app.moduleManager()
_report = json.dumps({"loaded": sorted(mm.loadedModulesNames()), "missing": mm.missingPythonModules})
`);
  return b.evalPython("_report", "eval");
});
console.log(report);
if (process.env.EXTRA_PY) { const fs = await import("node:fs"); await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), fs.readFileSync(process.env.EXTRA_PY, "utf8")); console.log(await page.evaluate(() => window.slicerWeb.bridge.evalPython("_out", "eval"))); }
if (process.env.EXTRA_PY) {
  const fs = await import("node:fs");
  const code = fs.readFileSync(process.env.EXTRA_PY, "utf8");
  await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
  console.log(await page.evaluate(() => window.slicerWeb.bridge.evalPython("_out", "eval")));
}
if (shot) await page.screenshot({ path: shot });
await browser.close();

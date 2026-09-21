// Open a module's GUI (e.g. of an installed extension) and report Python errors and warnings.
// Usage: node tests/module-gui.mjs "<Module title>" [--ext Name,Name] [--url URL] [--shot file.png] [--py file.py]
//   --ext: extensions to install at startup (by name, from <url>/extensions/index.json)
//   --py:  Python code to run after the module is shown; its variable _out is printed
import fs from "node:fs";
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const title = argv[0];
const base = opt("--url", "http://localhost:5173/");
const exts = (opt("--ext", "") || "").split(",").filter(Boolean);
const shot = opt("--shot");
const pyFile = opt("--py");

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
page.on("console", (m) => {
  const t = m.text();
  if (/GL Driver|Feedback loop|texParameter|bindTexture/.test(t)) return;
  if (m.type() === "error" || /Python package/.test(t)) console.log(`${stamp()} [${m.type()}] ${t.slice(0, 400)}`);
});
page.on("pageerror", (e) => console.log(`${stamp()} [pageerror] ${e}`));

// Extensions to install at startup (the Extensions Manager keeps the same list)
const index = exts.length ? await (await fetch(new URL("extensions/index.json", base))).json() : { extensions: [] };
const wheels = [];
const wheelIndex = exts.length ? await (await fetch(new URL("wheels/index.json", base))).json() : { packages: [] };
const add = (name) => {
  const e = index.extensions.find((x) => x.name === name);
  if (!e) return;
  for (const d of e.depends ?? []) add(d);
  for (const r of e.requires ?? []) {
    const w = wheelIndex.packages.find((p) => p.name === r);
    if (!w) continue;
    const url = new URL("wheels/" + w.file, base).href;
    if (!wheels.includes(url)) wheels.push(url);
  }
  const url = new URL("extensions/" + e.wheel, base).href;
  if (!wheels.includes(url)) wheels.push(url);
};
exts.forEach(add);
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge, null, { timeout: 60000 });
await page.evaluate(() => {
  window.__logs = [];
  window.slicerWeb.bridge.events.on("log", (e) => window.__logs.push(e));
});
await page.waitForFunction(() => document.querySelector("canvas"), null, { timeout: 300000 });
console.log(`${stamp()} app ready (${wheels.length} extension wheels)`);

// Select the module in the module panel
await page.locator("button.h-8.w-full").first().click();
await page.getByPlaceholder("Search modules").fill(title);
await page.waitForTimeout(300);
await page.keyboard.press("Enter");   // the module finder opens the module that is highlighted
await page.waitForTimeout(6000);
if (pyFile) {
  await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), fs.readFileSync(pyFile, "utf8"));
  console.log(await page.evaluate(() => window.slicerWeb.bridge.evalPython("_out", "eval")));
}
const logs = await page.evaluate(() => window.__logs);
for (const l of logs.filter((l) => /error|warning|critical/i.test(l.level ?? ""))) {
  console.log(`[python ${l.level}] ${String(l.message ?? l.text ?? JSON.stringify(l)).slice(0, 1500)}`);
}
const panelText = await page.locator(".sw-panel-scroll").last().innerText();
console.log(`panel text (${panelText.length} chars): ${panelText.slice(0, 300).replace(/\n+/g, " | ")}`);
if (shot) await page.screenshot({ path: shot });
await browser.close();

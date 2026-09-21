// Module panel layout: a Python module GUI must fit the module panel (no widget reaching outside it,
// as on a phone, where the panel is narrow).
// Usage: node tests/panel-layout.mjs "<Module title>" [--ext Name] [--url URL] [--width 322] [--shot file.png]
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const title = argv[0] ?? "Clip Vessel";
const base = opt("--url", "http://localhost:5173/");
const ext = opt("--ext", "SlicerVMTK");
const width = Number(opt("--width", "1500"));
const shot = opt("--shot");

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
const wheels = [];
if (ext) {
  const index = await (await fetch(new URL("extensions/index.json", base))).json();
  const entry = index.extensions.find((e) => e.name === ext);
  if (entry) wheels.push(new URL("extensions/" + entry.wheel, base).href);
}
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
// The modules of an extension are there once it has finished loading.
await page.waitForFunction((t) => (window.slicerWeb?.store?.modules ?? []).some((m) => m.title.includes(t) || m.name === t),
  title, { timeout: 120000 });
await page.locator("[data-name='moduleTitle']").click();
await page.getByPlaceholder("Search modules").fill(title);
await page.waitForTimeout(300);
await page.keyboard.press("Enter");   // the module finder opens the module that is highlighted
await page.waitForTimeout(6000);

const report = await page.evaluate(() => {
  const panel = document.querySelector(".sw-scripted-module");
  if (!panel) return null;
  const bounds = panel.getBoundingClientRect();
  const outside = [];
  for (const el of panel.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > bounds.right + 1 || r.left < bounds.left - 1) {
      outside.push({ name: el.getAttribute("data-name") ?? el.tagName.toLowerCase(), over: Math.round(r.right - bounds.right) });
    }
  }
  return { width: Math.round(bounds.width), widgets: panel.querySelectorAll("*").length, outside };
});
if (!report) {
  console.log(`${title}: no module panel`);
} else {
  console.log(`${title}: panel ${report.width} px, ${report.widgets} elements, ${report.outside.length} outside the panel`);
  for (const o of report.outside.slice(0, 10)) console.log(`  ${o.name} reaches ${o.over} px past the panel`);
}
if (shot) await page.screenshot({ path: shot });
await browser.close();
process.exit(report && report.outside.length ? 1 : 0);

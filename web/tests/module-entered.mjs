// isEntered of a scripted module's parent widget, which modules ask to do something only while they
// are shown (qSlicerAbstractModuleWidget.isEntered on the desktop): true once the module is selected,
// while it is shown - also in its handlers of scene events, such as the scene being closed - and
// false once another module is. Any error the page logs meanwhile fails the test.
// Usage: node tests/module-entered.mjs [url] ExtensionName Module [Module ...]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const base = args[0] && /^https?:/.test(args[0]) ? args.shift() : "http://localhost:5173/";
const extension = args.shift();
const modules = args;
if (!extension || !modules.length) {
  console.log("Usage: node tests/module-entered.mjs [url] ExtensionName Module [Module ...]");
  process.exit(2);
}

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
let current = "startup";
const errors = [];
const report = (kind, text) => {
  if (/GL Driver|Feedback loop|favicon|Failed to load resource|icon of extension/.test(text)) return;
  errors.push(`${current}: ${text}`);
  console.log(`  [${kind}] ${current}: ${text.slice(0, 800)}`);
};
page.on("pageerror", (e) => report("pageerror", String(e)));
page.on("console", (m) => { if (m.type() === "error") report("error", m.text()); });

await page.goto(`${base}?sample=&extensions=${encodeURIComponent(extension)}`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
await page.waitForFunction(async (mods) => {
  const text = String(await window.slicerWeb.bridge.evalPython("','.join(slicer.app.moduleManager().loadedModulesNames())", "eval"));
  return mods.every((m) => text.replace(/^'|'$/g, "").split(",").includes(m));
}, modules, { timeout: 600000, polling: 2000 });

let failures = 0;
const expect = (what, actual, wanted) => {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${actual}${ok ? "" : ` (expected ${wanted})`}`);
};
// isEntered as module code sees it: self.parent of its widget
const entered = (m) => py(`str(slicer.util.getModuleWidget(${JSON.stringify(m)}).parent.isEntered)`);

for (const module of modules) {
  current = module;
  console.log(module);
  const before = errors.length;
  await page.evaluate((m) => window.slicerWeb.bridge.evalPython(`slicer.util.selectModule(${JSON.stringify(m)})`), module);
  await page.waitForTimeout(2000);
  expect("isEntered when selected", await entered(module), "True");
  // the scene closed while the module is shown: its handlers ask isEntered
  await page.evaluate(() => window.slicerWeb.bridge.evalPython("slicer.mrmlScene.Clear(0)"));
  await page.waitForTimeout(1500);
  expect("isEntered after the scene is closed", await entered(module), "True");
  await page.evaluate(() => window.slicerWeb.bridge.evalPython("slicer.util.selectModule('Data')"));
  await page.waitForTimeout(1500);
  expect("isEntered when another module is selected", await entered(module), "False");
  if (errors.length !== before) {
    failures++;
    console.log(`  FAIL errors while using ${module}`);
  }
}
await browser.close();
console.log(failures ? `${failures} failure(s)` : "ok");
process.exit(failures ? 1 : 0);

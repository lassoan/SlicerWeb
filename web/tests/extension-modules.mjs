// Open the panel of every module of the given extensions, as a user selecting each module would, and
// report what went wrong in each: an error in the module widget's setup() or enter(), or any error
// the page logs meanwhile. Errors are printed as they happen; the exit code is 1 if there was any.
// Installing an extension proves only that its modules load - a panel that fails (qt.QHeaderView
// missing, say) fails when it is built, which is what this does.
// Usage: node tests/extension-modules.mjs [url] [ExtensionName ...]   (no name: every extension of the index)
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const base = args[0] && /^https?:/.test(args[0]) ? args.shift() : "http://localhost:5173/";
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const names = args.length ? args : index.extensions.map((e) => e.name);
let failures = 0;

for (const name of names) {
  const entry = index.extensions.find((e) => e.name === name);
  if (!entry) { console.log(`FAIL ${name}: not in ${base}extensions/index.json`); failures++; continue; }
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  let current = `${name} (startup)`;
  const errors = [];
  const report = (kind, text) => {
    if (/GL Driver|Feedback loop|favicon|Failed to load resource/.test(text)) return;
    errors.push(`${current}: ${text}`);
    console.log(`  [${kind}] ${current}: ${text.slice(0, 600)}`);
  };
  page.on("pageerror", (e) => report("pageerror", String(e)));
  page.on("console", (m) => { if (m.type() === "error") report("error", m.text()); });

  await page.goto(`${base}?sample=&extensions=${encodeURIComponent(name)}`);
  await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
  // the value of a Python expression, passed as base64 of its JSON: evalPython gives the repr of a
  // string, whose escapes (', \) are not JSON's, and tracebacks have plenty of both
  const pyJson = async (code) => {
    const b64 = String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(
      `__import__('base64').b64encode(__import__('json').dumps(${c}).encode()).decode()`, "eval"), code)).replace(/^'|'$/g, "");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  };
  // installed at startup: wait until its modules are there
  await page.waitForFunction(async (mods) => {
    const text = String(await window.slicerWeb.bridge.evalPython("','.join(slicer.app.moduleManager().loadedModulesNames())", "eval"));
    const loaded = text.replace(/^'|'$/g, "").split(",");
    return mods.every((m) => loaded.includes(m));
  }, entry.modules, { timeout: 600000, polling: 2000 });
  console.log(`${name}: ${entry.modules.length} module(s)`);

  // Builds a module's GUI as the page does when the module is first shown, and says how it went
  await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import json, traceback, slicer
from slicerweb import modules as _slicerweb_modules
def _open_panel(name):
    module = slicer.app.moduleManager().module(name)
    if module is None:
        return {"kind": None}
    if module.kind != "scripted":
        return {"kind": module.kind}
    # a module without a widget class (a file reader, a helper) has no panel, on the desktop neither
    if not hasattr(module.pythonModule, name + "Widget"):
        return {"kind": "scripted without a widget"}
    try:
        _slicerweb_modules.create_scripted_module_widget(name)
    except Exception:
        return {"kind": "scripted", "error": traceback.format_exc()}
    return {"kind": "scripted", "setupError": module._setupError}
`));

  for (const module of entry.modules) {
    current = module;
    const before = errors.length;
    const result = await pyJson(`_open_panel(${JSON.stringify(module)})`).catch((e) => ({ kind: "?", error: String(e) }));
    if (result.error) report("python", result.error);
    if (result.setupError) report("setup", result.setupError);
    if (result.kind === "scripted") {
      // selecting it shows the panel and runs enter()
      await page.evaluate((m) => window.slicerWeb.bridge.evalPython(`slicer.util.selectModule(${JSON.stringify(m)})`), module).catch((e) => report("select", String(e)));
      await page.waitForTimeout(1500);
    }
    const ok = errors.length === before;
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${module}${result.kind === "scripted" ? "" : ` (${result.kind ?? "not loaded"}: no Python panel)`}`);
  }
  await browser.close();
}
console.log(failures ? `${failures} module(s) with errors` : "no errors");
process.exit(failures ? 1 : 0);

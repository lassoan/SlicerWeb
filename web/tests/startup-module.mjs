// ?module=Elastix opens that module at startup, once the extension of ?extensions=SlicerElastix that
// has it is installed. Its panel shows the Advanced section collapsed, and without what has no
// meaning in a browser (temporary files, preset folders, the elastix executable).
// Usage: node tests/startup-module.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { const t = m.text(); if (/GL Driver|Vue warn/.test(t)) return; if (m.type() === "error" || m.type() === "warning" || /Traceback/.test(t)) console.log(`[${m.type()}] ${t.slice(0, 400)}`); });
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};

await page.goto(base + "?sample=&extensions=SlicerElastix&module=Elastix");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(3000);
check("the module is open", await page.evaluate(() => window.slicerWeb.store.activeModule), "Elastix");
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
check("Advanced is collapsed", await py("slicer.modules.ElastixWidget.ui.advancedCollapsibleButton.collapsed"), "True");
check("what has no meaning in a browser is hidden",
  await py("all(getattr(slicer.modules.ElastixWidget.ui, name).isHidden() for name in ['label_10', 'frame', 'label_12', 'showBuiltinPresetFolderButton', 'label_15', 'showUserPresetFolderButton', 'label_11', 'customElastixBinDirSelector'])"),
  "True");
check("the rest of Advanced is not",
  await py("not any(getattr(slicer.modules.ElastixWidget.ui, name).isHidden() for name in ['forceDisplacementFieldOutputCheckbox', 'showDetailedLogDuringExecutionCheckBox', 'initialTransformSelector'])"),
  "True");
if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

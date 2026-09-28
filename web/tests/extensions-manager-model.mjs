// slicer.app.extensionsManagerModel(): modules ask which extensions are installed and install the
// ones they need, as on the desktop. Extensions of SlicerWeb's index are installed (with what they
// depend on) and their modules loaded - Guided Artery Segmentation asks for SegmentEditorExtraEffects,
// and gets it; one no index has is reported as not installable.
// Usage: node tests/extensions-manager-model.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const pyYielding = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.callYielding("evalPython", [c, "eval"]), code)).replace(/^'|'$/g, "");

// SlicerVMTK installed (Guided Artery Segmentation is one of its modules), MarkupsToModel not
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheel = (name) => new URL("extensions/" + index.extensions.find((e) => e.name === name).wheel, base).href;
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), [wheel("SlicerVMTK")]);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.evaluate(() => { window.__logs = []; window.slicerWeb.bridge.events.on("log", (e) => window.__logs.push(e)); });
await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "GuidedArterySegmentation"), null, { timeout: 120000 });
await page.waitForTimeout(1500);

const em = "slicer.app.extensionsManagerModel()";
check("SlicerVMTK is installed", await py(`${em}.isExtensionInstalled("SlicerVMTK")`), "True");
check("MarkupsToModel is not, yet", await py(`${em}.isExtensionInstalled("MarkupsToModel")`), "False");

// ---- the module that asks for an extension it needs: installed, as on the desktop
await page.evaluate(() => { window.slicerWeb.store.activeModule = "GuidedArterySegmentation"; });
await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "SegmentEditorFloodFilling"), null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(1500);
const logs = await page.evaluate(() => window.__logs.map((l) => String(l.message)).join("\n"));
check("no complaint about a missing extensionsManagerModel", /extensionsManagerModel/.test(logs), false);
check("the extension it asks for is installed", await py(`${em}.isExtensionInstalled("SegmentEditorExtraEffects")`), "True");
check("with its modules", await page.evaluate(() => window.slicerWeb.store.modules.some((m) => m.name === "SegmentEditorFloodFilling")), true);
check("the module's GUI is there", (await page.locator(".sw-scripted-module").first().innerText()).length > 50, true);
check("without an error above it", await page.locator("[data-name=moduleError]").count(), 0);

// ---- an extension of the index, installed on request
check("an extension of the index is installed on request", await pyYielding(`${em}.installExtensionFromServer("MarkupsToModel", True)`), "True");
await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "MarkupsToModel"), null, { timeout: 120000 }).catch(() => {});
check("its modules are loaded", await page.evaluate(() => window.slicerWeb.store.modules.some((m) => m.name === "MarkupsToModel")), true);
check("and it is installed now", await py(`${em}.isExtensionInstalled("MarkupsToModel")`), "True");
check("an extension no index has cannot be", await py(`${em}.installExtensionFromServer("NoSuchExtension", True)`), "False");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

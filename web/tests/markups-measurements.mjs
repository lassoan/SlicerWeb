// Markups module: which measurements a markup has computed and shown is chosen in the Measurements
// section: its edit button lists every measurement the markup offers, each with a checkbox (not
// computed meanwhile); when editing is done, the enabled measurements are shown.
// Usage: node tests/markups-measurements.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

// a closed curve: its measurements (length, area, curvature, ...) are offered, none enabled at first
await run(`
import slicer, math
curve = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsClosedCurveNode", "C")
for a in range(8):
    curve.AddControlPoint(30 * math.cos(a * math.pi / 4), 30 * math.sin(a * math.pi / 4), 0)
def enabled(name):
    return bool(curve.GetMeasurement(name).GetEnabled())
`);
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Markups"; });
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
const section = panel.locator("[data-name=measurements]");
const edit = section.locator("[data-name=editMeasurements]");
const shown = async () => (await section.innerText()).replace(/\n/g, " | ");
const checkbox = (name) => section.locator(`[data-measurement="${name}"] input[type=checkbox]`);
check("the Markups module has a Measurements section, with an edit button", (await section.count()) === 1 && (await edit.count()) === 1);
check("nothing is enabled at first", (await py("str(enabled('length') or enabled('area'))")) === "False");
check("so no measurement is shown, and no checkboxes", /No measurement/.test(await shown()) && (await section.locator("input[type=checkbox]").count()) === 0,
  await shown());

await edit.click();
await page.waitForTimeout(500);
const names = await section.locator("[data-measurement]").evaluateAll((items) => items.map((i) => i.getAttribute("data-measurement")));
check("editing lists every measurement the markup offers, with a checkbox", names.includes("length") && names.includes("area") && names.length >= 6,
  names.join(", "));
check("without their values", !/mm|cm2/.test(await shown()), await shown());

await checkbox("length").check();
await checkbox("area").check();
await page.waitForTimeout(1000);
check("checking enables them", (await py("str(enabled('length') and enabled('area'))")) === "True");
await checkbox("length").uncheck();
await page.waitForTimeout(800);
check("unchecking disables", (await py("str(enabled('length'))")) === "False");

await edit.click();
await page.waitForTimeout(800);
check("when editing is done, the enabled measurements are shown, with their values",
  /area \| 28\.21cm2/.test(await shown()) && !/length/.test(await shown()) && (await section.locator("input[type=checkbox]").count()) === 0,
  await shown());

// a change made elsewhere (from Python) is shown too
await run(`curve.GetMeasurement("length").SetEnabled(True)`);
await page.waitForTimeout(1500);
check("enabling a measurement from Python shows it in the panel", /length \| [\d.]+mm/.test(await shown()), await shown());

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

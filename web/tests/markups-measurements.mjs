// Markups module: which measurements a markup has computed and shown is chosen in the Measurements
// section, as in desktop Slicer's "Measurement settings" (each measurement with an Enabled checkbox).
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
    for i in range(curve.GetNumberOfMeasurements()):
        if curve.GetNthMeasurement(i).GetName() == name:
            return curve.GetNthMeasurement(i).GetEnabled()
`);
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Markups"; });
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
const section = panel.locator("[data-name=measurements]");
check("the Markups module has a Measurements section", (await section.count()) === 1);
const shown = async () => (await section.innerText()).split("Measurement settings")[0];
check("nothing is enabled at first", (await py("str(bool(enabled('length')) or bool(enabled('area')))")) === "False");
check("so no measurement is shown", /No measurement/.test(await shown()), (await shown()).replace(/\n/g, " | "));

await section.getByText("Measurement settings", { exact: true }).click();
await page.waitForTimeout(400);
const settings = panel.locator("[data-name=measurementSettings]");
const names = await settings.locator("tr[data-measurement]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-measurement")));
check("the settings list every measurement of the markup", names.includes("length") && names.includes("area"), names.join(", "));

await settings.locator('tr[data-measurement="length"] input[type=checkbox]').check();
await page.waitForTimeout(1200);
check("enabling the length computes it", (await py("str(bool(enabled('length')))")) === "True");
check("and shows it", /length/i.test(await shown()) && !/No measurement/.test(await shown()), (await shown()).replace(/\n/g, " | "));

await settings.locator('tr[data-measurement="area"] input[type=checkbox]').check();
await page.waitForTimeout(1200);
check("enabling the area computes it", (await py("str(bool(enabled('area')))")) === "True");
check("and shows it, with the length", /area/i.test(await shown()) && /length/i.test(await shown()), (await shown()).replace(/\n/g, " | "));

await settings.locator('tr[data-measurement="length"] input[type=checkbox]').uncheck();
await page.waitForTimeout(1200);
check("disabling the length stops it", (await py("str(bool(enabled('length')))")) === "False");
check("and it is not shown any more", !/length/i.test(await shown()), (await shown()).replace(/\n/g, " | "));

// a change made elsewhere (from Python) is shown too
await run(`curve.GetMeasurement("length").SetEnabled(True)`);
await page.waitForTimeout(1500);
check("enabling a measurement from Python shows it in the panel",
  /length/i.test(await shown()) && await settings.locator('tr[data-measurement="length"] input[type=checkbox]').isChecked());

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

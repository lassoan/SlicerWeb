// Scripted modules of extensions build their GUI from the Qt and CTK widgets of desktop Slicer,
// which the qt/ctk compatibility layer stands in for. A widget that is only a stub there stops the
// module's setup() as soon as it touches something the real one has - Echo Volume Render connects
// to qMRMLRangeWidget's valuesChanged, which is a ctkRangeWidget signal.
// Usage: node tests/scripted-module-widgets.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 200)));

const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheels = [];
const add = (name) => {
  const extension = index.extensions.find((x) => x.name === name);
  if (!extension) return;
  for (const dependency of extension.depends ?? []) add(dependency);
  const url = new URL("extensions/" + extension.wheel, base).href;
  if (!wheels.includes(url)) wheels.push(url);
};
add("SlicerHeart");
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(4000);

const text = async (expr) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr)).replace(/^['"]|['"]$/g, "");
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

check("the range widget of MRML is a range widget, not a stub", (await text(`
str(all(hasattr(__import__("slicer").qMRMLRangeWidget(), name)
        for name in ("valuesChanged", "minimumValue", "maximumValue", "setValues", "setRange")))`)) === "True");

// the module that asked for it: its GUI has to build without stopping
async function openModule(title) {
  if (await page.getByPlaceholder("Search modules").count() === 0) {
    await page.locator("[data-name='moduleTitle']").click();
    await page.waitForTimeout(300);
  }
  await page.getByPlaceholder("Search modules").fill(title);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
}
await openModule("Echo Volume Render");
check("Echo Volume Render is the module that is open",
  (await page.evaluate(() => window.slicerWeb.store.activeModule)) === "EchoVolumeRender");
const panel = (await page.locator(".sw-panel-scroll").last().innerText()).replace(/\s+/g, " ");
check("and its GUI is built, not an error", !/error|Traceback|no attribute/i.test(panel), panel.slice(0, 200));
check("with the controls the module sets up", /depth|smoothing|threshold|volume/i.test(panel), panel.slice(0, 160));

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

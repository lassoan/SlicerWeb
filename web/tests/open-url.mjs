// A link with ?url=<address of a file> opens the application on that file: read directly where its
// server allows cross-origin requests, else through the site's download proxy.
// Usage: node tests/open-url.mjs <site url> <file url> [screenshot.png]
import { chromium } from "playwright-core";
const [base, file] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on("pageerror", (e) => console.log("[pageerror] " + e));
page.on("dialog", (d) => { console.log("[dialog] " + d.message().slice(0, 120)); d.dismiss(); });
await page.goto(base + "?url=" + encodeURIComponent(file));
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
const t0 = Date.now(); let v = "";
while (Date.now() - t0 < 120000) {
  v = await page.evaluate(() => window.slicerWeb.bridge.evalPython(
    "', '.join(f'{n.GetName()} {n.GetImageData().GetDimensions()}' for n in slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode') if n.GetImageData())", "eval"));
  v = String(v ?? "").replace(/^'|'$/g, "");
  if (v) break;
  await page.waitForTimeout(2000);
}
console.log("volumes:", v || "(none)");
if (process.argv[4]) await page.screenshot({ path: process.argv[4] });
if (!v) process.exitCode = 1;
await browser.close();

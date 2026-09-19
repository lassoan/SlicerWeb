// Open the application, wait for startup, then run Python code in the page and print the result.
// Usage: node tests/browser-eval.mjs <url> <python file> [screenshot.png]
import fs from "node:fs";
import { chromium } from "playwright-core";

const [url, pyFile, screenshot] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
page.on("console", (m) => { if ((m.type() === "error" || m.type() === "warning") && !/GL Driver Message/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 400)}`); });
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(url);
await page.waitForFunction(() => (window).slicerWeb?.bridge && document.querySelectorAll("canvas").length > 0, null, { timeout: 180000 });
await page.waitForTimeout(8000);
const code = fs.readFileSync(pyFile, "utf8");
// The Python code stores its output in the variable _out
await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const result = await page.evaluate(() => window.slicerWeb.bridge.evalPython("_out", "eval"));
console.log(typeof result === "string" ? result : JSON.stringify(result, null, 1));
if (screenshot) await page.screenshot({ path: screenshot });
await browser.close();

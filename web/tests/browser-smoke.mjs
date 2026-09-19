// Browser smoke test: open the application with a sample data set, wait until it is loaded, report
// console errors and save a screenshot.
// Usage: node tests/browser-smoke.mjs [url] [screenshot.png] [--mobile]
import { chromium } from "playwright-core";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const mobile = process.argv.includes("--mobile");
const url = args[0] ?? "http://localhost:5173/?sample=CTChest";
const screenshot = args[1] ?? "browser-smoke.png";

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext(
  mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1600, height: 900 } },
);
const page = await context.newPage();
const errors = [];
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
page.on("console", (m) => {
  const text = m.text();
  if (m.type() === "error") errors.push(text);
  if (m.type() === "error" || m.type() === "warning" || /SlicerWeb|slicer/i.test(text)) console.log(`${stamp()} [${m.type()}] ${text.slice(0, 500)}`);
});
page.on("pageerror", (e) => {
  errors.push(String(e));
  console.log(`${stamp()} [pageerror] ${e}`);
});
await page.goto(url);
try {
  await page.waitForFunction(() => document.querySelectorAll("canvas").length > 0, null, { timeout: 180000 });
  console.log(`${stamp()} views created`);
  // Loaded when the subject hierarchy shows a volume
  await page.waitForFunction(() => /CTChest|CT-chest|MRHead/i.test(document.body.innerText), null, { timeout: 180000 });
  console.log(`${stamp()} sample data loaded`);
} catch (e) {
  console.log(`${stamp()} TIMEOUT: ${e.message.split("\n")[0]}`);
}
await page.waitForTimeout(3000);
await page.screenshot({ path: screenshot });
console.log(`screenshot: ${screenshot}; console errors: ${errors.length}`);
await browser.close();

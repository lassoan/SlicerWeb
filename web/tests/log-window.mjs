// Application log: the messages of the application with their levels, filtered and cleared.
// Usage: node tests/log-window.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

await page.getByRole("button", { name: /application log/i }).click();
await page.waitForTimeout(600);
const log = page.locator("[data-name='logWindow']");
console.log("log window open:", await log.count() > 0);
console.log("messages from startup:", await log.locator("[data-level]").count());

// messages of every level, from Python and from VTK
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import logging, vtk
logging.getLogger("test").debug("a debug message")
logging.getLogger("test").info("an info message")
logging.getLogger("test").warning("a warning message")
logging.getLogger("test").error("an error message")
vtk.vtkObject().InvokeEvent(vtk.vtkCommand.WarningEvent)
`));
await page.waitForTimeout(800);
const counts = async () => page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll("[data-name='logWindow'] [data-level]")) {
    out[el.dataset.level] = (out[el.dataset.level] ?? 0) + 1;
  }
  return out;
});
console.log("shown by level:", JSON.stringify(await counts()));

// debug messages are off by default; switching them on starts logging them
await log.locator("[data-name='level:DEBUG']").click();
await page.waitForTimeout(500);
await page.evaluate(() => window.slicerWeb.bridge.evalPython('__import__("logging").getLogger("test").debug("a debug message")'));
await page.waitForTimeout(500);
console.log("with debug on:  ", JSON.stringify(await counts()));
await log.locator("[data-name='level:INFO']").click();
await page.waitForTimeout(400);
console.log("with info off:  ", JSON.stringify(await counts()));

// search
await log.locator("input").fill("warning message");
await page.waitForTimeout(400);
console.log("searching 'warning message':", await log.locator("[data-level]").count(), "line(s)");
await log.locator("input").fill("");
if (shot) await page.screenshot({ path: shot });

await log.locator("[data-name='clearLog']").click();
await page.waitForTimeout(500);
console.log("after clearing:", await log.locator("[data-level]").count(), "lines,",
  "Python side:", await page.evaluate(() => window.slicerWeb.bridge.evalPython("len(__import__('slicerweb.logging_handler', fromlist=['x']).error_log().entries)", "eval")));
await browser.close();

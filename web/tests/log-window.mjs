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

// the log window is opened from the application menu at the end of the toolbar
await page.getByRole("button", { name: /application menu/i }).click();
await page.waitForTimeout(300);
await page.locator("[data-name='menu:log']").click();
await page.waitForTimeout(600);
const log = page.locator("[data-name='logWindow']");
console.log("log window open:", await log.count() > 0);
console.log("messages from startup:", await log.locator("[data-level]").count());
// what this device renders with is logged, so that a report from a phone says so
console.log("WebGL line:", (await log.locator("[data-level]").allInnerTexts()).find((t) => /WebGL/.test(t))?.replace(/\s+/g, " ").slice(0, 120) ?? "(missing)");

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

// a shader that will not compile is reported with what the driver said
await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const shader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(shader, ["#version 300 es", "void main() { gl_Position = nonsense; }"].join(String.fromCharCode(10)));
  gl.compileShader(shader);
});
await page.waitForTimeout(600);
console.log("shader failure logged:", (await log.locator("[data-level='ERROR']").allInnerTexts())
  .find((t) => /Shader compilation/.test(t))?.replace(/\s+/g, " ").slice(0, 160) ?? "(missing)");

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

// the messages can be selected, copied and saved
console.log("selectable:", await log.locator("[data-level]").first().evaluate((el) => getComputedStyle(el).userSelect));
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await log.locator("[data-name='copyLog']").click();
await page.waitForTimeout(500);
const clipboard = await page.evaluate(() => navigator.clipboard.readText());
console.log("copied", clipboard.split(String.fromCharCode(10)).length, "lines, first:", clipboard.split(String.fromCharCode(10))[0].slice(0, 90));
const download = page.waitForEvent("download", { timeout: 20000 });
await log.locator("[data-name='downloadLog']").click();
const file = await download;
const stream = await file.createReadStream();
let saved = "";
for await (const chunk of stream) saved += chunk;
console.log("saved", await file.suggestedFilename(), "-", saved.split(String.fromCharCode(10)).length, "lines");

// with the Python console open as well, both are visible: one above the other, not one over the other
await page.getByRole("button", { name: /application menu/i }).click();
await page.waitForTimeout(300);
await page.locator("[data-name='menu:python']").click();
await page.waitForTimeout(800);
const boxes = await page.evaluate(() => {
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  const logRect = rect(document.querySelector("[data-name='logWindow']"));
  const console_ = [...document.querySelectorAll("div")].find((d) => d.textContent.startsWith("Python console") && d.className.includes("border-t"));
  const canvas = rect(document.querySelector("canvas"));
  return { log: logRect && { top: Math.round(logRect.top), bottom: Math.round(logRect.bottom) },
           console: console_ && { top: Math.round(rect(console_).top), bottom: Math.round(rect(console_).bottom) },
           canvasHeight: canvas && Math.round(canvas.height) };
});
console.log("log and console together:", JSON.stringify(boxes));
console.log("log above the console, not under it:", Boolean(boxes.log && boxes.console && boxes.log.bottom <= boxes.console.top + 1));
console.log("log still on screen:", await log.locator("[data-name='clearLog']").isVisible(), "- views still drawn:", boxes.canvasHeight > 0);
await page.locator("[data-name='menu:python']").click().catch(() => {});

await log.locator("[data-name='clearLog']").click();
await page.waitForTimeout(500);
console.log("after clearing:", await log.locator("[data-level]").count(), "lines,",
  "Python side:", await page.evaluate(() => window.slicerWeb.bridge.evalPython("len(__import__('slicerweb.logging_handler', fromlist=['x']).error_log().entries)", "eval")));
await browser.close();

// Python console on a phone: completions follow typing. The console is opened from the Application
// menu; typing asks for completions after a pause (phones have no Tab key), for what has been typed
// so far, and the suggestions for it are listed. The events and the completion requests are logged
// with their times, to see how the requests follow the keys.
// Usage: node tests/console-timing.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:4173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};

await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 180000 });
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 180000 });

// the Application menu (the gear at the right of the toolbar) opens the Python console
await page.getByRole("button", { name: "Application menu" }).tap();
await page.locator("[data-name='menu:python']").tap();
await page.waitForTimeout(500);
check("the console is open", await page.evaluate(() => window.slicerWeb.store.pythonConsoleOpen), true);

const input = page.getByPlaceholder(/>>>/);
await input.tap();
await page.evaluate(() => {
  window.__log = [];
  const t0 = performance.now();
  const ta = document.querySelector("textarea[placeholder^='>>>']");
  for (const ev of ["input", "keydown", "compositionstart", "compositionend"]) {
    ta.addEventListener(ev, (e) => window.__log.push(`${(performance.now() - t0).toFixed(0)} ${ev} ${e.key ?? e.data ?? ""}`));
  }
  const call = window.slicerWeb.bridge.call.bind(window.slicerWeb.bridge);
  window.slicerWeb.bridge.call = (m, a) => {
    if (m === "completePython") window.__log.push(`${(performance.now() - t0).toFixed(0)} completePython ${JSON.stringify(a)}`);
    return call(m, a);
  };
});
await input.pressSequentially("slicer.util.getN", { delay: 60 });
await page.waitForTimeout(1500);
const log = await page.evaluate(() => window.__log);
console.log(log.slice(-12).map((l) => "     " + l).join("\n"));

const requests = log.filter((l) => l.includes("completePython"));
check("completions are asked for after the typing pauses, not at every key", requests.length > 0 && requests.length < 16, true);
check("for what has been typed", requests.length > 0 && requests[requests.length - 1].includes('"slicer.util.getN"'), true);
const suggestions = await page.getByRole("listbox", { name: "Completions" }).getByRole("option").allInnerTexts();
console.log(`     suggestions: ${suggestions.slice(0, 5).map((s) => s.split("\n")[0]).join(", ")}`);
check("and they are listed", suggestions.some((s) => s.startsWith("getNode")), true);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

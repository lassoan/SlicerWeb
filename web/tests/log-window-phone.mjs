// The application log on a phone (Samsung S24 size): it covers the views rather than lying in a
// strip below them, its bar wraps onto more rows without lying over the messages, and every button
// of it - Copy above all - can be tapped. On a large screen it is still a strip below the views.
// Usage: node tests/log-window-phone.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ": " + detail}`);
};

async function openLog(context) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
  await page.goto(base + "?sample=");
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
  await page.waitForTimeout(1500);
  // long messages, as a WebGL error with a shader excerpt is
  await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import logging
for i in range(30):
    logging.getLogger("test").error("vtkSSAOPass (0x11c74978): Couldn't build the SSAO shader program. " + "x" * 120 + " message %d" % i)
`, "exec"));
  await page.evaluate(() => { window.slicerWeb.store.logWindowOpen = true; });
  await page.locator("[data-name=logWindow]").waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  return page;
}

/** Whether a tap at the middle of the element lands on it (not on something lying over it). */
const tappable = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return "missing";
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return el.contains(hit) ? "yes" : `covered by ${hit?.tagName} ${hit?.className?.toString().slice(0, 60)}`;
}, selector);

// ------------------------------------------------------------------ a phone held upright
{
  const context = await browser.newContext({ viewport: { width: 384, height: 832 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await openLog(context);
  const log = page.locator("[data-name=logWindow]");
  const box = await log.boundingBox();
  const main = await page.locator("main").boundingBox();
  check("on a phone the log covers the views", box && main && Math.abs(box.height - main.height) < 2 && Math.abs(box.width - main.width) < 2,
    `${box?.width}x${box?.height} over ${main?.width}x${main?.height}`);
  for (const name of ["copyLog", "downloadLog", "clearLog", "closeLog", "level:ERROR"]) {
    check(`  its ${name} button can be tapped`, (await tappable(page, `[data-name='${name}']`)) === "yes", await tappable(page, `[data-name='${name}']`));
  }
  const copyBox = await page.locator("[data-name=copyLog]").boundingBox();
  check("  with a finger-sized target", copyBox && copyBox.width >= 32 && copyBox.height >= 32, `${copyBox?.width}x${copyBox?.height}`);
  const bar = await page.locator("[data-name=logWindow] > div").first().boundingBox();
  const messages = await page.locator("[data-name=logWindow] > div").nth(1).boundingBox();
  check("  the messages are below the bar", messages && bar && messages.y >= bar.y + bar.height - 1, `bar ends ${bar && bar.y + bar.height}, messages start ${messages?.y}`);
  const overflow = await page.evaluate(() => {
    const list = document.querySelector("[data-name=logWindow] [data-level]")?.parentElement;
    return list ? list.scrollWidth - list.clientWidth : -1;
  });
  check("  long messages wrap (no scrolling sideways)", overflow <= 1, `${overflow} px wider`);
  await page.locator("[data-name=copyLog]").tap();
  await page.waitForTimeout(300);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch((e) => "error " + e));
  check("  Copy puts the messages on the clipboard", /Couldn't build the SSAO shader program/.test(clipboard), clipboard.slice(0, 80));
  if (shot) await page.screenshot({ path: shot });
  await page.locator("[data-name=closeLog]").tap();
  await page.waitForTimeout(300);
  check("  and Close closes it", (await page.locator("[data-name=logWindow]").count()) === 0);
  await context.close();
}

// ------------------------------------------------------------------ a phone held sideways
{
  const context = await browser.newContext({ viewport: { width: 832, height: 384 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await openLog(context);
  check("held sideways, the log covers the views too", (await page.locator("[data-name=logWindow]").getAttribute("data-fill")) === "true");
  check("  and Copy can be tapped", (await tappable(page, "[data-name='copyLog']")) === "yes", await tappable(page, "[data-name='copyLog']"));
  await context.close();
}

// ------------------------------------------------------------------ a desktop screen
{
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await openLog(context);
  const box = await page.locator("[data-name=logWindow]").boundingBox();
  const main = await page.locator("main").boundingBox();
  check("on a large screen the log is a strip below the views", box && main && box.height < main.height / 3 && box.y + box.height >= main.y + main.height - 1
    && (await page.locator("[data-name=logWindow]").getAttribute("data-fill")) === null, `${box?.height} px high, of ${main?.height}`);
  check("  and Copy can be clicked", (await tappable(page, "[data-name='copyLog']")) === "yes", await tappable(page, "[data-name='copyLog']"));
  await context.close();
}

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failures ? 1 : 0);

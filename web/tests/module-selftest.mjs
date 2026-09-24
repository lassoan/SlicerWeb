// "Reload and Test" of a scripted module: runs the module's self test in the page.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const extName = process.argv[3] ?? "SlicerVMTK";
const title = process.argv[4] ?? "Extract Centerline";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("dialog", (d) => { console.log(`[dialog] ${d.message().slice(0, 300)}`); d.dismiss(); });
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheels = [];
const add = (n) => {
  const e = index.extensions.find((x) => x.name === n);
  if (!e) return;
  for (const d of e.depends ?? []) add(d);
  const url = new URL("extensions/" + e.wheel, base).href;
  if (!wheels.includes(url)) wheels.push(url);
};
add(extName);
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.evaluate(() => { window.__logs = []; window.slicerWeb.bridge.events.on("log", (e) => window.__logs.push(e)); });

// The modules of an extension are there once it has finished loading.
await page.waitForFunction((t) => (window.slicerWeb?.store?.modules ?? []).some((m) => m.title.includes(t) || m.name === t),
  title, { timeout: 120000 });
await page.locator("[data-name='moduleTitle']").click();
await page.getByPlaceholder("Search modules").fill(title);
await page.waitForTimeout(300);
await page.keyboard.press("Enter");   // the module finder opens the module that is highlighted
await page.waitForTimeout(4000);
const panel = page.locator(".sw-panel-scroll").last();
await panel.getByText("Reload and Test", { exact: true }).first().click();   // open the section
await page.waitForTimeout(500);
const t0 = Date.now();
// A test runs in the page's thread: where Python cannot be suspended (no JSPI, or the setting off)
// it holds the thread until it is done, so it is started from a timer, so that the click returns,
// and the page is waited for however long it takes. Where it can, the page goes on drawing and
// says what the test is doing (slicer.util.delayDisplay), which is listed here.
await panel.locator("button.sw-button", { hasText: "Reload and Test" }).evaluate((b) => setTimeout(() => b.click(), 0));
page.setDefaultTimeout(0);
const statuses = [];
for (let i = 0; i < 900; i++) {
  const text = await panel.innerText();
  if (/Test passed|Error|error:|Failed|failed/.test(text)) break;
  const status = await page.locator("[data-name=testStatus]").first().innerText().catch(() => "");
  if (status && statuses[statuses.length - 1] !== status) statuses.push(status);
  await page.waitForTimeout(1000);
}
console.log(`while it ran, the page showed ${statuses.length} statuses${statuses.length ? ": " + statuses.slice(0, 8).join(" | ") : ""}`);
console.log(`after ${((Date.now() - t0) / 1000).toFixed(0)} s: ${(await panel.innerText()).split("\n").filter((l) => /passed|Error|error|Failed|failed|s\)$/.test(l)).slice(0, 6).join(" | ")}`);
// how much of the log to show: LOG_COUNT entries of up to LOG_CHARS characters
const [logCount, logChars] = [Number(process.env.LOG_COUNT ?? 12), Number(process.env.LOG_CHARS ?? 1200)];
const logs = await page.evaluate(([n, c]) => (window.__logs || []).slice(-n).map((l) => `${l.level}: ${String(l.message).slice(0, c)}`), [logCount, logChars]);
console.log(logs.join("\n"));
if (shot) await page.screenshot({ path: shot });
await browser.close();

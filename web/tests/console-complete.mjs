// Python console completion test (phone viewport): type without Tab, wait, tap a suggestion.
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:4173/?sample=";
const shot = process.argv[3];
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 180000 });
await page.getByRole("button", { name: /python/i }).first().tap();
const input = page.locator("textarea").last();
await input.tap();
await input.pressSequentially("slicer.util.getN", { delay: 60 });
const typedAt = Date.now();
let appearedAfter = -1;
while (Date.now() - typedAt < 3000) {
  if (await page.getByRole("listbox", { name: "Completions" }).count()) { appearedAfter = Date.now() - typedAt; break; }
  await page.waitForTimeout(50);
}
const early = appearedAfter;
const options = await page.getByRole("listbox", { name: "Completions" }).getByRole("option").allTextContents();
console.log(`suggestions appeared ${early} ms after the last keystroke; ${options.length}: ${options.slice(0, 8).join(" ")}`);
if (shot) await page.screenshot({ path: shot });
await page.getByRole("option", { name: /^getNode\(\)$/ }).tap();
console.log(`input after tapping: ${JSON.stringify(await input.inputValue())}`);
await input.pressSequentially('"CT-chest").GetImageData().GetDim', { delay: 30 });
await page.waitForTimeout(1500);
console.log(`chained suggestions: ${(await page.getByRole("listbox", { name: "Completions" }).getByRole("option").allTextContents()).join(" ")}`);
await browser.close();

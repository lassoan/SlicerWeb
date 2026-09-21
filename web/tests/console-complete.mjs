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
// the console is opened from the application menu at the end of the toolbar
await page.getByRole("button", { name: /application menu/i }).tap();
await page.waitForTimeout(300);
await page.locator("[data-name='menu:python']").tap();
await page.waitForTimeout(1500);
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
await page.getByRole("listbox", { name: "Completions" }).getByRole("option")
  .filter({ hasText: "slicer.util.getNode" }).first().tap();
console.log(`input after tapping: ${JSON.stringify(await input.inputValue())}`);
await input.pressSequentially('"CT-chest").GetImageData().GetDim', { delay: 30 });
await page.waitForTimeout(1500);
console.log(`chained suggestions: ${(await page.getByRole("listbox", { name: "Completions" }).getByRole("option").allTextContents()).join(" ")}`);
// Typing anywhere in the console types at the prompt: the output takes the focus when it is
// clicked (so that it can be read and copied), and a key pressed there belongs at the prompt.
await input.fill("");
// click in the output, above the prompt, and type
await page.locator("[data-name='consoleOutput']").click();
await page.waitForTimeout(300);
console.log("focus after clicking the output:", await page.evaluate(() => document.activeElement?.dataset?.name ?? document.activeElement?.tagName));
await page.keyboard.type("1 + 1");
await page.waitForTimeout(400);
console.log("what the prompt holds:", await page.locator("[data-name='pythonConsole'] textarea").inputValue());
console.log("focus now:", await page.evaluate(() => document.activeElement?.tagName));
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
console.log("console says:", (await page.locator("[data-name='consoleOutput']").innerText()).split("\n").slice(-2).join(" | "));

// Enter with nothing typed, from the output: the prompt takes the focus
await page.locator("[data-name='consoleOutput']").click();
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
console.log("focus after Enter in the output:", await page.evaluate(() => document.activeElement?.tagName));
await browser.close();

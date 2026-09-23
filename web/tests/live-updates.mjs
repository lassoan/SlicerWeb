// Two things that have to follow what is happening without being asked twice: the data panel shows
// a node's new name as soon as it is renamed, and a search box filters while a word is still being
// composed - which is how a phone keyboard types, a word at a time, with no space yet.
// Usage: node tests/live-updates.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
/** Type the way a phone keyboard does: the word is still being composed, so no space has arrived. */
const typeWhileComposing = (selector, text) => page.evaluate(([sel, value]) => {
  const box = document.querySelector(sel);
  box.focus();
  box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  box.value = value;
  box.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: value }));
}, [selector, text]);

await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(5000);

// The data panel follows a rename, whoever did the renaming
const panel = () => page.locator(".sw-panel-scroll").first().innerText();
await page.evaluate(() => window.slicerWeb.bridge.evalPython('slicer.util.getNode("CT-chest").SetName("Chest of case 42")'));
await page.waitForTimeout(800);
check("the data panel shows the new name", (await panel()).includes("Chest of case 42"), true);
check("and not the old one", (await panel()).includes("CT-chest"), false);

// The sample search filters while the word is being composed
await page.getByRole("button", { name: "Samples" }).click();
await page.waitForTimeout(1500);
await typeWhileComposing("[data-name='sampleSearch']", "brain");
await page.waitForTimeout(600);
const samples = await page.locator("[data-name='sampleSearch']").locator("xpath=ancestor::div[contains(@class,'flex-col')][1]").innerText();
check("the samples are filtered before a space is typed", /Brain/i.test(samples) && !/MRHead/.test(samples), true);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// And so does the module search
await page.locator("[data-name='moduleTitle']").click();
await page.waitForTimeout(600);
await typeWhileComposing("input[aria-label='Search modules']", "markups");
await page.waitForTimeout(600);
const modules = await page.locator("input[aria-label='Search modules']").locator("xpath=ancestor::div[2]").innerText();
check("the modules are filtered before a space is typed", /Markups/.test(modules) && !/Volumes/.test(modules), true);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

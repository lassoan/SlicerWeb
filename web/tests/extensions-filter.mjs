// The Extensions Manager's search follows every keystroke - also on a phone, where a word is
// composed before a space arrives - and a search that matches nothing leaves the dialog standing.
// Usage: node tests/extensions-filter.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(1500);
await page.getByLabel("Application menu").click();
await page.locator("[role=menuitem]", { hasText: /extensions manager/i }).first().click();
const box = page.getByPlaceholder("Search extensions");
await box.waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);
const cards = () => page.locator("div.mb-2").count();
const dialogUp = () => box.isVisible().catch(() => false);
const all = await cards();
check("the extensions are listed", all >= 5, true);

/** Type the way a phone keyboard does: the word is still being composed, no space yet. */
const compose = (text) => page.evaluate((value) => {
  const el = document.querySelector("input[placeholder='Search extensions']");
  el.focus();
  el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  el.value = value;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: value }));
}, text);
await compose("igt");
await page.waitForTimeout(500);
check("a word still being composed already narrows the list", (await cards()) < all && (await cards()) > 0, true);

await compose("nothing-of-that-name");
await page.waitForTimeout(500);
check("a search matching nothing says so", await page.getByText("No extensions found.").isVisible(), true);
check("and the dialog is still there", await dialogUp(), true);

// SimVascular names no category; a search must not fail on what an extension leaves unsaid
await compose("sim");
await page.waitForTimeout(500);
check("an extension that says less still matches", (await cards()) >= 1, true);
check("without taking the dialog down", await dialogUp(), true);

await compose("");
await page.waitForTimeout(500);
check("clearing the search brings everything back", await cards(), all);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

// The Extensions Manager by keyboard alone: the search box has the focus when it opens and keeps
// it; typing filters, the arrow keys choose, Enter installs (or uninstalls) the chosen extension,
// and the next one can be looked for right away; Escape closes the dialog.
// Usage: node tests/extensions-keyboard.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.dismiss());
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}`);
};
const focused = () => page.evaluate(() => document.activeElement?.dataset?.name ?? document.activeElement?.tagName);
const chosen = () => page.evaluate(() => document.querySelector("[data-highlighted=true]")?.dataset.extension ?? null);
const installed = (name) => page.evaluate((n) => window.slicerWeb.store.modules.length && JSON.parse(localStorage.getItem("slicerweb.extensions") ?? "[]")
  .some((u) => u.toLowerCase().includes(`slicer_ext_${n.toLowerCase()}-`)), name);

await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.getByLabel("Application menu").click();
await page.locator("[data-name='menu:extensions']").click();
await page.waitForFunction(() => document.querySelectorAll("[data-extension]").length > 3, null, { timeout: 30000 });
check("the search box has the focus when the dialog opens", await focused(), "extensionSearch");

// type, Enter: installed
await page.keyboard.type("markupstomodel");
await page.waitForTimeout(300);
check("typing filters, and the first one found is chosen", await chosen(), "MarkupsToModel");
await page.keyboard.press("Enter");
await page.waitForFunction(() => /installed/.test(document.body.innerText), null, { timeout: 120000 });
check("Enter installs it", await installed("MarkupsToModel"), true);
check("and the search box still has the focus", await focused(), "extensionSearch");

// the next one, by keyboard only
await page.keyboard.press("Control+A");
await page.keyboard.type("slicer");
await page.waitForTimeout(300);
const found = await page.evaluate(() => [...document.querySelectorAll("[data-extension]")].map((e) => e.dataset.extension));
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
check("the arrow keys choose in the list", await chosen(), found[2]);
await page.keyboard.press("ArrowUp");
check("up and down", await chosen(), found[1]);
await page.keyboard.press("Control+A");
await page.keyboard.type("rawimage");
await page.waitForTimeout(300);
await page.keyboard.press("Enter");
await page.waitForFunction(() => /RawImageGuess installed/.test(document.body.innerText), null, { timeout: 120000 });
check("another is found and installed without the mouse", await installed("RawImageGuess"), true);

// Enter on an installed one uninstalls it
await page.keyboard.press("Control+A");
await page.keyboard.type("markupstomodel");
await page.waitForTimeout(300);
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
check("Enter on an installed one uninstalls it", await installed("MarkupsToModel"), false);
check("the focus stays in the search box", await focused(), "extensionSearch");

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Escape closes the dialog", await page.evaluate(() => window.slicerWeb.store.extensionsManagerOpen), false);

check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

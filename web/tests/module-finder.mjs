// Module finder: typing highlights the first hit, the arrow keys walk the list, Enter opens the
// module, Escape closes. A module's description is its tooltip, and its (i) button shows what is
// known about it below it, for one module at a time.
// Usage: node tests/module-finder.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));

// SlicerVMTK gives the finder some extension modules to tell from the built-in ones
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheels = [new URL("extensions/" + index.extensions.find((e) => e.name === "SlicerVMTK").wheel, base).href];
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const open = async () => { await page.locator("[data-name='moduleTitle']").click(); await page.waitForTimeout(400); };
const highlighted = () => page.locator("[data-highlighted='true']").first().innerText();
const items = () => page.locator("[data-highlighted]").allInnerTexts();
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};

await open();
console.log("focused search box:", await page.evaluate(() => document.activeElement?.getAttribute("placeholder")));
await page.keyboard.type("centerline");
await page.waitForTimeout(400);
console.log("hits for 'centerline':", (await items()).join(" | "));
console.log("highlighted:", await highlighted());
check("no module information below the list", await page.locator("[data-name='moduleInformation']").count(), 0);
const tooltip = await page.locator("[data-highlighted='true']").first().getAttribute("title");
console.log("tooltip:", tooltip.slice(0, 120));
check("the description is the tooltip", tooltip.length > 20 && !/</.test(tooltip), true);
// (i): the properties of that module just below it; another one's (i) shows its own instead
const infoButtons = page.locator("[data-name='moduleInformationButton']");
await infoButtons.nth(0).click();
await page.waitForTimeout(300);
check("(i) shows the module's properties", await page.locator("[data-name='moduleInformation']").count(), 1);
const firstInfo = await page.locator("[data-name='moduleInformation']").innerText();
console.log("information:", firstInfo.replace(/\n+/g, " | ").slice(0, 200));
check("just below its item", await page.evaluate(() => {
  const info = document.querySelector("[data-name='moduleInformation']").getBoundingClientRect();
  const row = document.querySelectorAll("[data-name='moduleInformationButton']")[0].getBoundingClientRect();
  return info.top >= row.bottom - 1 && info.top - row.bottom < 12;
}), true);
check("with the search box keeping the keyboard", await page.evaluate(() => document.activeElement?.getAttribute("placeholder")), "Search modules");
if ((await infoButtons.count()) > 1) {
  await infoButtons.nth(1).click();
  await page.waitForTimeout(300);
  check("another module's (i): only that one shown", await page.locator("[data-name='moduleInformation']").count(), 1);
  check("and it is the other module's", (await page.locator("[data-name='moduleInformation']").innerText()) !== firstInfo, true);
  await infoButtons.nth(1).click();
  await page.waitForTimeout(300);
  check("(i) again hides it", await page.locator("[data-name='moduleInformation']").count(), 0);
}

await page.keyboard.press("ArrowDown");
await page.waitForTimeout(200);
console.log("after ArrowDown:", await highlighted());
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(200);
console.log("after ArrowUp:  ", await highlighted());
await page.keyboard.press("PageDown");
await page.waitForTimeout(200);
console.log("after PageDown: ", await highlighted());
if (shot) await page.screenshot({ path: shot });

// Ctrl+F opens the finder; a module chosen elsewhere - the toolbar, a script - closes it
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.keyboard.press("Control+f");
await page.waitForTimeout(400);
console.log("finder open after Ctrl+F:", (await page.getByPlaceholder("Search modules").count()) > 0);
await page.getByRole("button", { name: "Segment Editor" }).first().click();
await page.waitForTimeout(500);
console.log("finder open after a toolbar module:", (await page.getByPlaceholder("Search modules").count()) > 0, "(false expected)");
await page.keyboard.press("Control+f");
await page.waitForTimeout(400);
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Volumes"; });
await page.waitForTimeout(500);
console.log("finder open after a module set from a script:", (await page.getByPlaceholder("Search modules").count()) > 0, "(false expected)");
await open();
await page.keyboard.type("centerline");
await page.waitForTimeout(400);
// a single click opens a module (a phone has no keyboard, and no second tap should be needed)
await page.locator("[data-highlighted]").last().click();
await page.waitForTimeout(600);
console.log("after a click on the last hit, the module open is:", await page.evaluate(() => window.slicerWeb.store.activeModule), "and the finder is", (await page.getByPlaceholder("Search modules").count()) ? "still open" : "closed");
await open();
await page.keyboard.type("centerline");
await page.waitForTimeout(400);
// Escape closes, Enter opens the highlighted module
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
console.log("finder open after Escape:", (await page.getByPlaceholder("Search modules").count()) > 0);
await open();
await page.keyboard.type("extract centerline");
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);
console.log("module after Enter:", await page.evaluate(() => window.slicerWeb.store?.activeModule ?? document.querySelector("[data-name='moduleTitle']")?.textContent));

// the search options
await open();
await page.keyboard.type("vessel");
await page.waitForTimeout(300);
console.log("'vessel' by name:      ", (await items()).join(" | "));
await page.getByTitle(/Full text/).click();
await page.waitForTimeout(400);
console.log("'vessel' with full text:", (await items()).join(" | "));
await page.locator("input[placeholder='Search modules']").fill("model");
await page.waitForTimeout(300);
const withBuiltIn = await items();
console.log(`'model' with built-in: ${withBuiltIn.length} hits, built-in "Models" listed: ${withBuiltIn.includes("Models")}`);
await page.getByTitle(/Built-in/).click();
await page.waitForTimeout(400);
const extensionsOnly = await items();
console.log(`'model' extensions only: ${extensionsOnly.length} hits, built-in "Models" listed: ${extensionsOnly.includes("Models")}`);
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

// The Application settings dialog: Developer mode is on to begin with and shows a scripted
// module's Reload and Test section; turned off, the section goes, Python sees the Slicer setting
// (Developer/DeveloperMode) change, and the choice survives a reload, as the installed
// extensions do. A change made from Python shows in the dialog.
// Usage: node tests/application-settings.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code);
const developerModeInPython = async () => String(await py('slicer.util.settingsValue("Developer/DeveloperMode", False, converter=slicer.util.toBool)'));
const start = async () => {
  await page.goto(base + "?sample=");
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { window.slicerWeb.store.activeModule = "SampleData"; });
  await page.waitForTimeout(3000);
};
const reloadAndTest = () => page.getByText("Reload and Test", { exact: true }).first();
const openDialog = async () => {
  await page.getByLabel("Application menu").click();
  await page.locator("[role=menuitem]", { hasText: /application settings/i }).first().click();
  await page.locator("[data-name=settings-dialog]").waitFor({ timeout: 10000 });
};
const developerMode = () => page.locator("[data-name=settings-dialog] input[type=checkbox]").first();

await context.clearCookies();
await start();
check("Developer mode is on to begin with (Python)", await developerModeInPython(), "True");
check("and a scripted module shows its Reload and Test section", await reloadAndTest().isVisible(), true);

await openDialog();
check("the dialog has a Developer section", await page.locator("[data-name=settings-dialog]").getByText("Developer", { exact: true }).isVisible(), true);
check("with Developer mode checked", await developerMode().isChecked(), true);
await developerMode().click();
await page.waitForTimeout(500);
check("unchecked, Python sees the setting change", await developerModeInPython(), "False");
await page.getByLabel("Close").click();
check("and the Reload and Test section is gone", await reloadAndTest().count(), 0);

await page.reload();
await start();
check("after a reload the setting is still off (Python)", await developerModeInPython(), "False");
check("and the section still gone", await reloadAndTest().count(), 0);
await openDialog();
check("and the dialog shows it off", await developerMode().isChecked(), false);

// Turned back on from Python, as a script would
await page.evaluate(() => window.slicerWeb.bridge.evalPython('slicer.app.userSettings().setValue("Developer/DeveloperMode", True)', "exec"));
await page.waitForTimeout(500);
check("a change from Python shows in the dialog", await developerMode().isChecked(), true);
check("and is kept in the browser", await page.evaluate(() => JSON.parse(localStorage.getItem("slicerweb.settings") ?? "{}")["Developer/DeveloperMode"]), true);
await page.getByLabel("Close").click();
check("and the section is back", await reloadAndTest().isVisible(), true);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

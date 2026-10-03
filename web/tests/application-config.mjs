// The configuration of the application (application.json of a deployment, which the build writes to
// wheels/application.json): the features it has. The page is given each configuration here, as a
// deployment's build would serve it.
// - none: the Python console and the Extensions Manager are in the menu and open with Ctrl+3 and
//   Ctrl+4; Developer mode is offered in the settings, on
// - pythonConsole and extensionsManager false: not in the menu, and the shortcuts do nothing
// - developerMode disabledByDefault: offered, off (also in Python); turned on, it stays on
// - developerMode unavailable: not offered, off - also for a user who had turned it on, and when
//   Python turns it on
// - a value it cannot have: reported, and the default is used
// Usage: node tests/application-config.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === undefined ? "" : ": " + detail}`);
};

/** A page of the application with this application.json (null: none), and settings kept from before. */
async function start(config, keptSettings = null) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
  await page.route("**/wheels/application.json", (route) => config === null
    ? route.fulfill({ status: 404, body: "" })
    : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) }));
  if (keptSettings) await page.addInitScript((s) => localStorage.setItem("slicerweb.settings", JSON.stringify(s)), keptSettings);
  await page.goto(base + "?sample=");
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
  await page.waitForTimeout(1000);
  return { page, context, errors };
}
const py = (page, code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code);
const developerModeInPython = async (page) => { const v = await py(page, 'str(slicer.util.settingsValue("Developer/DeveloperMode", False, converter=slicer.util.toBool))'); return String(v).replace(/^'|'$/g, ""); };
const menuItems = async (page) => {
  await page.getByLabel("Application menu").click();
  await page.waitForTimeout(300);
  const names = await page.locator("[role=menuitem]").evaluateAll((items) => items.map((i) => i.dataset.name).filter(Boolean));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  return names;
};
const shortcut = async (page, digit) => {
  await page.locator("body").click({ position: { x: 5, y: 400 } }).catch(() => {});
  await page.keyboard.press(`Control+${digit}`);
  await page.waitForTimeout(500);
  return page.evaluate(() => ({ python: window.slicerWeb.store.pythonConsoleOpen, extensions: window.slicerWeb.store.extensionsManagerOpen }));
};
const developerOption = async (page) => {
  await page.getByLabel("Application menu").click();
  await page.locator("[data-name='menu:settings']").click();
  const dialog = page.locator("[data-name=settings-dialog]");
  await dialog.waitFor({ timeout: 10000 });
  await dialog.locator("nav").getByText("Developer", { exact: true }).click();
  const box = dialog.locator("label", { hasText: "Developer mode" }).locator("input[type=checkbox]");
  return { dialog, box, offered: (await box.count()) > 0 };
};

// ------------------------------------------------------------------ no configuration: the defaults
{
  const { page, context } = await start(null);
  const items = await menuItems(page);
  check("without a configuration, the menu has the Python console", items.includes("menu:python"), items.join(", "));
  check("  and the Extensions Manager", items.includes("menu:extensions"));
  const python = await shortcut(page, 3);
  check("  Ctrl+3 opens the Python console", python.python === true);
  await page.keyboard.press("Control+3");
  const extensions = await shortcut(page, 4);
  check("  Ctrl+4 opens the Extensions Manager", extensions.extensions === true);
  await page.evaluate(() => { window.slicerWeb.store.extensionsManagerOpen = false; });
  const { box, offered, dialog } = await developerOption(page);
  check("  Developer mode is offered in the settings", offered);
  check("  and on", offered && await box.isChecked());
  check("  Python sees it on", (await developerModeInPython(page)) === "True");
  await dialog.getByLabel("Close").click();
  await context.close();
}

// ------------------------------------------------------------------ no Python console, no Extensions Manager
{
  const { page, context, errors } = await start({ features: { pythonConsole: false, extensionsManager: false, developerMode: "disabledByDefault" } });
  const items = await menuItems(page);
  check("with pythonConsole false, the menu has no Python console", !items.includes("menu:python"), items.join(", "));
  check("  with extensionsManager false, no Extensions Manager", !items.includes("menu:extensions"));
  const state = await shortcut(page, 3);
  await shortcut(page, 4);
  const after = await page.evaluate(() => ({ console: !!document.querySelector("[data-name=pythonConsole], [aria-label='Python console']"),
    manager: window.slicerWeb.store.extensionsManagerOpen }));
  check("  Ctrl+3 opens no Python console", !after.console, JSON.stringify(state));
  check("  Ctrl+4 opens no Extensions Manager", !after.manager);
  const { box, offered, dialog } = await developerOption(page);
  check("with developerMode disabledByDefault, Developer mode is offered", offered);
  check("  and off", offered && !(await box.isChecked()));
  check("  Python sees it off", (await developerModeInPython(page)) === "False");
  await box.click();
  await page.waitForTimeout(500);
  check("  turned on, it is on (Python)", (await developerModeInPython(page)) === "True");
  await dialog.getByLabel("Close").click();
  check("  no errors about the configuration", !errors.some((e) => /application\.json/.test(e)), errors.join(" | ").slice(0, 200));
  await context.close();
}

// ------------------------------------------------------------------ Developer mode unavailable
{
  // a user who had turned it on before
  const { page, context } = await start({ features: { developerMode: "unavailable" } }, { "Developer/DeveloperMode": true });
  const { offered, dialog } = await developerOption(page);
  check("with developerMode unavailable, Developer mode is not offered", !offered);
  check("  the rest of the Developer section is", await dialog.locator("[data-name=showRenderingFPS]").count() > 0);
  await dialog.getByLabel("Close").click();
  check("  it is off, also for a user who had turned it on (page)", (await page.evaluate(() => window.slicerWeb.store.settings["Developer/DeveloperMode"])) === false);
  check("  and in Python", (await developerModeInPython(page)) === "False");
  await page.evaluate(() => window.slicerWeb.bridge.evalPython('slicer.app.userSettings().setValue("Developer/DeveloperMode", True)', "exec"));
  await page.waitForTimeout(800);
  check("  turned on from Python, it goes back off", (await developerModeInPython(page)) === "False"
    && (await page.evaluate(() => window.slicerWeb.store.settings["Developer/DeveloperMode"])) === false);
  const items = await menuItems(page);
  check("  the Python console and Extensions Manager are there by default", items.includes("menu:python") && items.includes("menu:extensions"));
  await context.close();
}

// ------------------------------------------------------------------ a value it cannot have
{
  const { page, context, errors } = await start({ features: { developerMode: "sometimes", pythonConsole: "no", colors: true } });
  check("values it cannot have are reported", errors.filter((e) => /application\.json/.test(e)).length === 3, errors.filter((e) => /application\.json/.test(e)).join(" | "));
  const items = await menuItems(page);
  check("  and the defaults are used", items.includes("menu:python"));
  const { box, offered } = await developerOption(page);
  check("  Developer mode offered and on", offered && await box.isChecked());
  await context.close();
}

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failures ? 1 : 0);

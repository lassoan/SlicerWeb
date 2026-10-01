// Lights (Sandbox extension) driven like a user: its list of managed views is a
// qMRMLCheckableNodeComboBox. "Select all" checks every 3D view, and unchecking one in the list
// takes it out of the views the module lights.
// Usage: node tests/lights-gui.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error" && !/GL Driver|shader|vtkOpenGL/i.test(m.text())) errors.push(m.text() + (m.location()?.url ? ` (${m.location().url})` : ""));
});
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);

// two 3D views, so that there is something to choose between
await page.goto(base + "?sample=&layout=Dual3D&extensions=Sandbox");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "Lights"), null, { timeout: 120000 });
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Lights"; });
await page.waitForTimeout(3000);
await exec(`w = slicer.util.getModuleWidget("Lights"); combo = w.ui.managedViewsCheckableNodeComboBox`);
const views = Number(await py(`len(combo.nodes())`));
check("3D views listed", views, (n) => n === 2);

const panel = page.locator(".sw-panel-scroll").last();
const listButton = panel.locator(".sw-node-selector button").first();
check("nothing checked at first", (await listButton.textContent()).trim().replace(/▾$/, "").trim(), "None");

await panel.getByRole("button", { name: "Select all" }).click();
await page.waitForTimeout(1500);
check("Select all: checked", await py(`len(combo.checkedNodes())`), String(views));
check("Select all: unchecked", await py(`len(combo.uncheckedNodes())`), "0");
check("Select all: views the module lights", await py(`len(w.logic.managedViewNodes)`), String(views));
check("the list shows the checked views", (await listButton.textContent()).trim(), (t) => t.includes(","));

// unchecked by the user, in the drop-down list
await listButton.click();
const boxes = panel.locator('.sw-node-selector [role="listbox"] input[type="checkbox"]');
check("check boxes in the list", await boxes.count(), views);
await boxes.nth(1).uncheck();
await page.waitForTimeout(1500);
check("unchecked in the list: checked", await py(`len(combo.checkedNodes())`), String(views - 1));
check("unchecked in the list: views the module lights", await py(`len(w.logic.managedViewNodes)`), String(views - 1));
check("unchecked in the list: check state", await py(`combo.checkState(combo.uncheckedNodes()[0])`), "0");
await page.keyboard.press("Escape");
await page.mouse.click(5, 990);   // a click elsewhere closes the list
await page.waitForTimeout(500);
check("the list is closed", await panel.locator('.sw-node-selector [role="listbox"]').count(), 0);

check("errors", errors.length ? errors.join("\n") : "none", "none");
await browser.close();
process.exit(failures ? 1 : 0);

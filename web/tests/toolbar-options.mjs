// Three things of the toolbar:
// - a phone held upright opens the side panels from buttons at the ends of the toolbar, and has no
//   strips beside the views; held sideways, the strips are back;
// - the Crosshair button says whether the crosshair is on (pressed; in the compact toolbar, a mark on
//   the Layout button and "Crosshair: on" in its menu), and the crosshair jumps centered;
// - Maximize / Restore shows the current view alone and brings the layout back;
// - the favorite modules of the toolbar are set in Application settings > Modules, and an embedding
//   page can name its own with ?favoriteModules=, which is not kept as a setting.
// Usage: node tests/toolbar-options.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}`);
};
const errors = [];
const open = async (options, url = base + "?sample=") => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.dismiss());
  await page.goto(url);
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
  await page.waitForTimeout(1500);
  return page;
};
const toolbarModules = (page) => page.evaluate(() => {
  const nav = document.querySelector("nav[aria-label=Toolbar]");
  const names = ["Layout", "Reset views", "Maximize view", "Restore layout", "Crosshair", "Rotate / Pan / Zoom", "Window / Level", "Scroll slices", "Place points", "New markup", "Mouse mode", "Modules"];
  return [...nav.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")).filter((l) => !names.includes(l));
});

// ---- a phone held upright, then sideways
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
let page = await open(phone);
check("upright: no strips beside the views", await page.locator("[title='Expand panel']").count(), 0);
const ends = await page.evaluate(() => {
  const x = (name) => document.querySelector(`[data-name=${name}]`)?.getBoundingClientRect();
  const buttons = [...document.querySelectorAll("header button")].map((b) => b.getBoundingClientRect()).filter((r) => r.width);
  const left = x("leftPanelButton"), right = x("rightPanelButton");
  return left && right && left.left <= Math.min(...buttons.map((r) => r.left)) && right.right >= Math.max(...buttons.map((r) => r.right));
});
check("the panel buttons are at the two ends of the toolbar", ends, true);
check("the views have the width of the screen", await page.evaluate(() => Math.round(document.querySelector("main").getBoundingClientRect().width)), (w) => w >= 385);
await page.locator("[data-name=leftPanelButton]").tap();
await page.waitForTimeout(500);
check("the left button opens the Data panel", [await page.evaluate(() => window.slicerWeb.store.leftPanelOpen),
  await page.locator("[data-name=leftPanelButton]").getAttribute("aria-pressed")], [true, "true"]);
await page.locator("[data-name=leftPanelButton]").tap();
await page.waitForTimeout(300);
await page.locator("[data-name=rightPanelButton]").tap();
await page.waitForTimeout(500);
check("the right button opens the module panel", await page.evaluate(() => window.slicerWeb.store.rightPanelOpen), true);
await page.context().close();
page = await open({ ...phone, viewport: { width: 844, height: 390 } });
check("sideways: no panel buttons in the toolbar", await page.locator("[data-name=leftPanelButton], [data-name=rightPanelButton]").count(), 0);
await page.evaluate(() => { window.slicerWeb.store.leftPanelOpen = false; });
await page.waitForTimeout(300);
check("and a closed panel has its strip again", await page.locator("[title='Expand panel']").count(), 1);
await page.context().close();

// ---- crosshair
page = await open({ viewport: { width: 1600, height: 900 } });
const crosshair = () => page.evaluate(() => window.slicerWeb.bridge.evalPython(
  `(lambda n: "%d %d" % (n.GetCrosshairMode(), n.GetCrosshairBehavior()))(slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLCrosshairNode"))`, "eval"));
await page.locator("[data-name=crosshairButton]").click();
await page.waitForTimeout(500);
check("Crosshair on: the button is pressed", await page.locator("[data-name=crosshairButton]").getAttribute("aria-pressed"), "true");
check("the crosshair is shown, and jumps centered", String(await crosshair()).replace(/'/g, ""),
  await page.evaluate(() => window.slicerWeb.bridge.evalPython(`"2 %d" % slicer.vtkMRMLCrosshairNode.CenteredJumpSlice`, "eval")).then((s) => String(s).replace(/'/g, "")));
await page.locator("[data-name=crosshairButton]").click();
await page.waitForTimeout(500);
check("off again: the button is not pressed", await page.locator("[data-name=crosshairButton]").getAttribute("aria-pressed"), "false");

// ---- Maximize / Restore: the current view (the one last clicked) alone, and the layout back
const maximized = () => page.evaluate(() => window.slicerWeb.store.layout.maximized);
const view3d = await page.locator("#slicer-view-1").boundingBox();
await page.mouse.click(view3d.x + view3d.width / 2, view3d.y + view3d.height / 2);
await page.waitForTimeout(300);
await page.locator("[data-name=maximizeButton]").click();
await page.waitForTimeout(1500);
check("Maximize shows the view last clicked alone", await maximized(), "1");
check("the button then restores, and is pressed", [await page.locator("[data-name=maximizeButton]").getAttribute("aria-label"),
  await page.locator("[data-name=maximizeButton]").getAttribute("aria-pressed")], ["Restore layout", "true"]);
await page.locator("[data-name=maximizeButton]").click();
await page.waitForTimeout(1500);
check("Restore brings the layout back", await maximized(), null);

// ---- favorite modules, set in the settings
check("the toolbar offers the default favorite modules", await toolbarModules(page), ["Segment Editor", "Volume Rendering", "Transforms", "Scene Views"]);
await page.getByLabel("Application menu").click();
await page.locator("[data-name='menu:settings']").click();
await page.locator("[data-name=settings-dialog] nav").getByText("Modules", { exact: true }).click();
await page.locator("[data-name=addFavoriteModule]").selectOption("Markups");
await page.locator("[data-name=favoriteModules] [data-module=SceneViews] button[title^='Remove']").click();
await page.locator("[data-name=favoriteModules] [data-module=Markups] button[title^='Move'][title$='up']").click();
await page.getByLabel("Close").click();
await page.waitForTimeout(500);
check("added, removed and moved in the settings, so in the toolbar", await toolbarModules(page), ["Segment Editor", "Volume Rendering", "Markups", "Transforms"]);
check("with the module's own icon where the toolbar has none", await page.locator("nav[aria-label=Toolbar] button[aria-label=Markups] img").count(), 1);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(1500);
check("and kept after a reload", await toolbarModules(page), ["Segment Editor", "Volume Rendering", "Markups", "Transforms"]);

// ---- an embedding page names its own
await page.goto(base + "?sample=&favoriteModules=Models,Data");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(1500);
check("?favoriteModules= names those of this page", await toolbarModules(page), ["Models", "Data"]);
check("without changing the setting", await page.evaluate(() => window.slicerWeb.store.settings["Modules/FavoriteModules"]),
  ["SegmentEditor", "VolumeRendering", "Markups", "Transforms"]);
await page.context().close();

// ---- the compact toolbar: the crosshair in the layout menu
page = await open({ viewport: { width: 520, height: 900 } });
await page.getByLabel("Layout").first().click();
await page.locator("[data-name=crosshairMenuItem]").click();
await page.waitForTimeout(500);
check("compact: a mark on the Layout button says the crosshair is on", await page.locator("[data-name=crosshairBadge]").count(), 1);
await page.getByLabel("Layout").first().click();
check("and its menu says so", (await page.locator("[data-name=crosshairMenuItem]").innerText()).trim(), "Crosshair: on");
await page.locator("[data-name=maximizeMenuItem]").click();
await page.waitForTimeout(1500);
check("compact: Maximize view is in the layout menu", await page.evaluate(() => !!window.slicerWeb.store.layout.maximized), true);
await page.getByLabel("Layout").first().click();
check("which then says Restore layout", (await page.locator("[data-name=maximizeMenuItem]").innerText()).trim(), "Restore layout");
await page.locator("[data-name=maximizeMenuItem]").click();
await page.waitForTimeout(1500);
check("and restores it", await page.evaluate(() => window.slicerWeb.store.layout.maximized), null);
await page.context().close();

check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

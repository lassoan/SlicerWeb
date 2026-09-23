// The toolbar folds into menus when it does not fit: the mouse modes into one button, the modules
// into another, and what is done to the views into the layout menu.
// Usage: node tests/toolbar-compact.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let failures = 0;
const check = (what, got, expected) => {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(1500);

const buttons = () => page.locator("nav[aria-label=Toolbar] [aria-label], nav[aria-label=Toolbar] [title]")
  .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") || e.getAttribute("title")).filter(Boolean));
const fits = () => page.evaluate(() => {
  const nav = document.querySelector("nav[aria-label=Toolbar]");
  return nav.scrollWidth <= nav.clientWidth + 1;
});
const py = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code);
const resize = async (width) => { await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(900); };

check("every button is its own where there is room", await buttons(), [
  "Layout", "Reset views", "Crosshair", "Rotate / Pan / Zoom", "Window / Level", "Place points",
  "New markup", "Segment Editor", "Volume Rendering", "Transforms", "Scene Views"]);

// Making a markup is something done, not a state: the button holds nothing to switch off, and that
// a click in a view now places points is said by the mouse mode instead.
await page.getByLabel("New markup").click();
await page.waitForTimeout(400);
await page.locator("[role=menuitem]", { hasText: "Line" }).first().click();
await page.waitForTimeout(900);
check("placing is what the mouse mode says", await page.getByLabel("Place points").getAttribute("aria-pressed"), "true");
check("and the New markup button stays unpressed", await page.getByLabel("New markup").getAttribute("aria-pressed"), "false");
await page.getByLabel("Rotate / Pan / Zoom").click();
await page.waitForTimeout(600);
check("leaving the mode releases it", await page.getByLabel("Place points").getAttribute("aria-pressed"), "false");

await resize(390);
check("a narrow toolbar holds four buttons", await buttons(), ["Layout", "Mouse mode", "New markup", "Modules"]);
check("and nothing of it is out of reach", await fits(), true);

// The mouse modes, in one menu
await page.getByLabel("Mouse mode").click();
await page.waitForTimeout(400);
const modeItems = await page.locator("[role=menuitem]").allInnerTexts();
check("what a click can do is in it, placing included", modeItems,
      ["Rotate / Pan / Zoom", "Window / Level", "Place points"]);
await page.locator("[role=menuitem]", { hasText: "Window / Level" }).first().click();
await page.waitForTimeout(600);
check("choosing one sets the mode", await page.evaluate(() => window.slicerWeb.store.interactionMode), "AdjustWindowLevel");

// The markup kinds, in a button of their own
await page.getByLabel("New markup").click();
await page.waitForTimeout(400);
check("the markup kinds are in the button beside it", await page.locator("[role=menuitem]").allInnerTexts(),
      ["Line", "Point list", "Angle", "Open curve", "Closed curve", "Plane", "ROI"]);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// The modules, in another
await page.getByLabel("Modules").click();
await page.waitForTimeout(400);
check("the modules of the toolbar are in it", await page.locator("[role=menuitem]").allInnerTexts(),
      ["Segment Editor", "Volume Rendering", "Transforms", "Scene Views"]);
await page.locator("[role=menuitem]", { hasText: "Transforms" }).first().click();
await page.waitForTimeout(1200);
check("choosing one opens the module", await page.evaluate(() => window.slicerWeb.store.activeModule), "Transforms");

// What is done to the views, under the layouts
await page.getByLabel("Layout").click();
await page.waitForTimeout(400);
const crosshairBefore = await py('slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLCrosshairNode").GetCrosshairMode()');
await page.locator("[role=menuitem]", { hasText: "Crosshair" }).first().click();
await page.waitForTimeout(800);
check("the layout menu carries the crosshair", (await py('slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLCrosshairNode").GetCrosshairMode()')) !== crosshairBefore, true);

await page.getByLabel("Layout").click();
await page.waitForTimeout(400);
check("and framing the views again", await page.locator("[role=menuitem]", { hasText: "Reset views" }).count() > 0, true);
await page.keyboard.press("Escape");

await resize(1500);
check("room again brings every button back", (await buttons()).length, 11);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

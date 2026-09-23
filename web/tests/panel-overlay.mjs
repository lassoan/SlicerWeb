// Side panels on a narrow screen lie over the views instead of narrowing them, so that what is
// loaded is fitted to the width the views are actually read at.
// Usage: node tests/panel-overlay.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const viewWidth = (page) => page.evaluate(() => Math.round(document.querySelector("#slicer-view-Red")?.getBoundingClientRect().width ?? 0));
const overlaying = (page) => page.evaluate(() => document.querySelectorAll("div.z-30").length > 0);
const ready = async (page) => {
  await page.waitForFunction(() => document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
  await page.waitForTimeout(2000);
};

// A phone held upright: the panel covers the views, which keep their width.
const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
phone.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await phone.goto(base + "?sample=");
await ready(phone);
const closedWidth = await viewWidth(phone);
await phone.locator("[title='Expand panel']").first().click();
await phone.waitForTimeout(1000);
check("the views keep their width when the Data panel opens", await viewWidth(phone), closedWidth);
check("the panel lies over the views", await overlaying(phone), true);

// Loading with the panel open fits the volume to the width the views really have.
await phone.getByRole("button", { name: "Samples" }).click();
await phone.waitForTimeout(1500);
await phone.locator("button", { hasText: /^CTChest/ }).first().click();
const py = (code) => phone.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code);
for (let i = 0; i < 40 && Number(await py('len(slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode"))')) === 0; i++) {
  await phone.waitForTimeout(5000);
}
await phone.waitForTimeout(4000);
const fieldOfView = () => py('repr([round(v) for v in slicer.app.layoutManager().sliceWidget("Red").sliceLogic().GetSliceNode().GetFieldOfView()])');
const loadedWith = await fieldOfView();

// A finger cannot hover, so what a row of the data tree offers has to be there to be tapped.
check("the row of a node offers saving without hovering", await phone.locator("[title='Save to file']").first().isVisible(), true);
check("and deleting", await phone.locator("[title='Delete']").first().isVisible(), true);
const target = await phone.locator("[title='Save to file']").first().boundingBox();
check("with something a finger can hit", target.width >= 24 && target.height >= 24, true);

await phone.mouse.click(380, 500); // tapping the views puts the panel away
await phone.waitForTimeout(1500);
check("tapping the views closes the panel", await phone.evaluate(() => window.slicerWeb.store.leftPanelOpen), false);
check("what was loaded keeps its size when the panel goes away", await fieldOfView(), loadedWith);

// A screen with room for both: the panel sits beside the views, as it always did.
const desktop = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
await desktop.goto(base + "?sample=");
await ready(desktop);
const beside = await viewWidth(desktop);
check("the panel takes width from the views where there is room", await overlaying(desktop), false);
await desktop.evaluate(() => { window.slicerWeb.store.leftPanelOpen = false; });
await desktop.waitForTimeout(800);
check("closing it there gives the views more width", (await viewWidth(desktop)) > beside, true);

// The whole strip opens the panel again, not only the arrow at its top.
for (const side of ["left", "right"]) {
  await desktop.evaluate((s) => { window.slicerWeb.store[s + "PanelOpen"] = false; }, side);
  await desktop.waitForTimeout(600);
  const strip = desktop.locator("[title='Expand panel']").nth(side === "left" ? 0 : -1);
  const box = await strip.boundingBox();
  await desktop.mouse.click(box.x + box.width / 2, box.y + box.height - 40);   // far below the arrow
  await desktop.waitForTimeout(700);
  check(`clicking the bottom of the ${side} strip opens the panel`,
        await desktop.evaluate((s) => window.slicerWeb.store[s + "PanelOpen"], side), true);
}

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

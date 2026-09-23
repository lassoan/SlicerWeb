// Virtual Cath Lab (SlicerHeart): choosing a device brings its C-arm layout, with the C-arm views
// rendered off-screen (a collapsed pane, as on the desktop) into the X-ray volumes shown in the
// slice views beside the 3D view; the X-ray image follows the C-arm angles; the biplane device
// adds the lateral image. What the module leans on: view nodes marked as mapped in the layout, a
// camera node for a 3D view as soon as the layout is set, layoutChanged once the views exist.
// Usage: node tests/virtual-cath-lab.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("dialog", (d) => { console.log("[dialog]", d.message().slice(0, 120)); d.accept(); });
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};

const index = await (await fetch(base + "extensions/index.json")).json();
const wheels = [];
const add = (name) => {
  const e = index.extensions.find((x) => x.name === name);
  if (!e) return;
  for (const d of e.depends ?? []) add(d);
  const url = base + "extensions/" + e.wheel;
  if (!wheels.includes(url)) wheels.push(url);
};
add("SlicerHeart");
await page.goto(base + "?sample=CTChest");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge, null, { timeout: 300000 });
await page.evaluate(() => { window.__errors = []; window.slicerWeb.bridge.events.on("log", (e) => { if (/error/i.test(e.level)) window.__errors.push(String(e.message).slice(-400)); }); });
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(6000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const xray = (name) => py(`(lambda n: n.GetImageData().GetDimensions()[0] > 100 and n.GetImageData().GetDimensions()[1] > 100 if n and n.GetImageData() else False)(slicer.mrmlScene.GetFirstNodeByName("${name}"))`);
const imageStats = () => py('(lambda a: (round(float(a.mean()), 3), round(float(a.std()), 3)))(slicer.util.arrayFromVolume(slicer.mrmlScene.GetFirstNodeByName("CArmFrontalXRay")))');

await page.evaluate(() => { window.slicerWeb.store.activeModule = "VirtualCathLab"; });
await page.waitForTimeout(10000);
const panel = page.locator(".sw-panel-scroll").last();
await panel.getByRole("button", { name: "GenericFluoro" }).click({ timeout: 120000 });
await page.waitForTimeout(6000);
check("the generic C-arm brings its layout", await py("slicer.app.layoutManager().layout()"), "1020");
check("with the C-arm 3D view in it, mapped in the layout", await py('sorted(v.GetLayoutName() for v in slicer.util.getNodesByClass("vtkMRMLViewNode") if v.IsViewVisibleInLayout())'), "['1', 'CArmFrontal']");
check("and a camera for it", await py('slicer.vtkMRMLViewLogic.GetCameraNode(slicer.mrmlScene, "CArmFrontal") is not None'), "True");

await panel.locator("select").filter({ hasText: "CT-chest" }).first().selectOption({ label: "CT-chest" });
await page.waitForTimeout(12000);
check("the CT is rendered into the frontal X-ray image", await xray("CArmFrontalXRay"), "True");
check("which the C-arm slice view shows", await py('slicer.app.layoutManager().sliceWidget("CArmFrontalSlice").mrmlSliceCompositeNode().GetBackgroundVolumeID() == slicer.mrmlScene.GetFirstNodeByName("CArmFrontalXRay").GetID()'), "True");
const before = await imageStats();
const larm = panel.locator("input[type=number]").first();
await larm.fill("30");
await larm.press("Enter");
await page.waitForTimeout(6000);
check("turning the L-arm changes the X-ray image", (await imageStats()) !== before, true);

await panel.getByRole("button", { name: "GenericBiplaneFluoro" }).click({ timeout: 180000 });
await page.waitForTimeout(15000);
check("the biplane C-arm brings its layout", await py("slicer.app.layoutManager().layout()"), "1021");
check("with both C-arm views", await py('sorted(v.GetLayoutName() for v in slicer.util.getNodesByClass("vtkMRMLViewNode") if v.IsViewVisibleInLayout())'), "['1', 'CArmFrontal', 'CArmLateral']");
check("and the lateral X-ray image rendered", await xray("CArmLateralXRay"), "True");
check("shown in the lateral slice view", await py('slicer.app.layoutManager().sliceWidget("CArmLateralSlice").mrmlSliceCompositeNode().GetBackgroundVolumeID() == slicer.mrmlScene.GetFirstNodeByName("CArmLateralXRay").GetID()'), "True");
const errors = await page.evaluate(() => window.__errors);
check("all without an error", errors.length, 0);
for (const e of errors.slice(0, 3)) console.log("---\n" + e);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

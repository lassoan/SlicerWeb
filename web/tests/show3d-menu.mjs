// The "Show 3D" button of the Segment Editor and Segmentations modules: its menu chooses the representation shown in
// 3D views (binary labelmap or closed surface) and the smoothing of the surfaces, as desktop Slicer's does.
// Usage: node tests/show3d-menu.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
page.on("console", (m) => { if (/error|Error/.test(m.text()) && !/GL Driver/.test(m.text())) console.log("[console] " + m.text().slice(0, 300)); });
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

// The Segment Editor makes a segmentation on entry; a segment with a ball in it
await page.getByRole("button", { name: "Segment Editor" }).first().click();
await page.waitForTimeout(2500);
let panel = page.locator(".sw-panel-scroll").last();
await panel.locator("button", { hasText: /^Add$/ }).first().click();
await page.waitForTimeout(1500);
await run(`
import numpy as np, slicer
seg = slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0]
volume = slicer.util.getNode("CT-chest")
shape = slicer.util.arrayFromVolume(volume).shape
k, j, i = np.indices(shape)
c = np.array(shape) // 2
segmentId = seg.GetSegmentation().GetNthSegmentID(0)
slicer.util.updateSegmentBinaryLabelmapFromArray((((k - c[0]) ** 2 + (j - c[1]) ** 2 + (i - c[2]) ** 2) < 30 ** 2).astype(np.uint8), seg, segmentId, volume)
seg.GetDisplayNode().SetPreferredDisplayRepresentationName3D(None)
`);
await page.waitForTimeout(1000);
const seg = `slicer.util.getNodesByClass("vtkMRMLSegmentationNode")[0]`;
const shown = async () => py(`(lambda s: f"{s.GetDisplayNode().GetPreferredDisplayRepresentationName3D()} visible3D={bool(s.GetDisplayNode().GetVisibility3D())} surface={s.GetSegmentation().ContainsRepresentation('Closed surface')}")(${seg})`);
const pressed = async () => (await panel.locator("[data-name=show3DButton]").getAttribute("class")).includes("bg-primary ");

// Show 3D with no representation chosen: closed surface, as on desktop
await panel.locator("[data-name=show3DButton]").click();
await page.waitForTimeout(1500);
check("Show 3D shows closed surface by default", (await shown()) === "Closed surface visible3D=True surface=True", await shown());
check("and the button is pressed", await pressed());

// The menu: representation choices, with the one in use checked
const openMenu = async () => { await panel.locator("[data-name=show3DMenu]").click(); await page.waitForTimeout(300); };
await openMenu();
const labelmapItem = page.locator("[data-name=show3DRepresentation-Binarylabelmap]");
const surfaceItem = page.locator("[data-name=show3DRepresentation-Closedsurface]");
check("the menu offers binary labelmap and closed surface", (await labelmapItem.count()) === 1 && (await surfaceItem.count()) === 1);
check("and closed surface is checked", (await surfaceItem.getAttribute("aria-checked")) === "true" && (await labelmapItem.getAttribute("aria-checked")) === "false");
await labelmapItem.click();
await page.waitForTimeout(1500);
check("choosing binary labelmap shows it in 3D and removes the closed surface that nothing uses then",
  (await shown()) === "Binary labelmap visible3D=True surface=False", await shown());
check("the button stays pressed", await pressed());
const actors = `len([a for a in slicer.app.layoutManager().threeDWidget(0).threeDView().renderWindow().GetRenderers().GetFirstRenderer().GetActors() if a.GetMapper() and a.GetMapper().IsA("vtkSegmentationLabelmapSurfaceMapper") and a.GetVisibility()])`;
check("drawn as surfaces computed on the GPU", Number(await py(actors)) === 1, await py(actors));

// Show 3D off and on again: only the chosen representation
await panel.locator("[data-name=show3DButton]").click();
await page.waitForTimeout(1000);
check("Show 3D off hides it and removes the closed surface", (await shown()) === "Binary labelmap visible3D=False surface=False", await shown());
check("the button is not pressed", !(await pressed()));
await panel.locator("[data-name=show3DButton]").click();
await page.waitForTimeout(1000);
check("Show 3D on shows binary labelmap without making a closed surface", (await shown()) === "Binary labelmap visible3D=True surface=False", await shown());

// Smoothing factor: the slider sets the conversion parameter, when it is released
await openMenu();
const smoothing = page.locator("[data-name=show3DSmoothing] input[type=range]");
check("the smoothing slider shows the factor", Number(await smoothing.inputValue()) === 0.5, await smoothing.inputValue());
await smoothing.fill("0.8");
await page.waitForTimeout(1000);
const factor = await py(`${seg}.GetSegmentation().GetConversionParameter("Smoothing factor")`);
check("moving it sets the smoothing factor", Number(factor) === 0.8, factor);
check("and the menu stays open while it is used", (await smoothing.count()) === 1);
await page.keyboard.press("Escape");

// The Segmentations module shows the same choice
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Segmentations"; });
await page.waitForTimeout(2500);
panel = page.locator(".sw-panel-scroll").last();
check("the Segmentations module's button is pressed too", await pressed());
await openMenu();
check("and its menu has binary labelmap checked", (await labelmapItem.getAttribute("aria-checked")) === "true");
await surfaceItem.click();
await page.waitForTimeout(2000);
check("choosing closed surface there makes it", (await shown()) === "Closed surface visible3D=True surface=True", await shown());
await openMenu();
check("its smoothing slider shows the factor set in the Segment Editor", Number(await smoothing.inputValue()) === 0.8, await smoothing.inputValue());

await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

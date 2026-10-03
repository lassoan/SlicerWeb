// Markups module: the interaction handles settings of the display (as desktop Slicer's "Interaction Handles"):
// visibility of the handles, of translation, rotation and scaling handles and their axes, their size and opacity.
// Usage: node tests/markups-handles.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(2000);

const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

await run(`
import slicer
slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutOneUp3DView)
p = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsPlaneNode", "P")
p.SetCenter(0, 0, 0); p.SetNormal(0.2, -1, 0.5); p.SetSize(60, 60)
d = p.GetDisplayNode(); d.SetSelectedColor(0.5, 0.5, 0.5); d.SetColor(0.5, 0.5, 0.5); d.SetActiveColor(0.5, 0.5, 0.5)
d.SetHandlesInteractive(False)
v = slicer.app.layoutManager().threeDWidget(0).threeDView(); v.resetFocalPoint(); v.resetCamera()
`);
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Markups"; });
await page.waitForTimeout(2000);
const panel = page.locator(".sw-panel-scroll").last();
await panel.getByText("Display", { exact: true }).first().click();
await page.waitForTimeout(400);
const section = panel.locator("[data-name=interactionHandles]");
check("the display settings have an Interaction handles section", (await section.count()) === 1);
await section.getByText("Interaction handles", { exact: true }).first().click();
await page.waitForTimeout(400);

/** Pixels of the 3D view that are none of the gray-blue background and the plane's colors: handles are red, green, blue. */
const handlePixels = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const c = document.querySelector("#slicer-view-1"); const canvas = c.matches("canvas") ? c : c.querySelector("canvas");
  const gl = canvas.getContext("webgl2"); const px = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    if ((r > 150 && g < 90 && b < 90) || (g > 150 && r < 100 && b < 100) || (b > 150 && r < 90 && g < 90)) n++;
  }
  return n;
});
const display = `slicer.util.getNode("P").GetDisplayNode()`;
const before = await handlePixels();
await section.locator("[data-name=handlesVisible]").click();
await page.waitForTimeout(1500);
check("Visibility shows the interaction handles", (await py(`${display}.GetHandlesInteractive()`)) === "True");
const shown = await handlePixels();
check("and they are drawn in the 3D view", shown > before + 50, `${before} -> ${shown} red and green pixels`);

const row = (kind) => section.locator(`tr[data-kind=${kind}]`);
const rotationBefore = await py(`${display}.GetRotationHandleVisibility()`);
await row("rotation").locator("[data-name=handleKindVisible]").click();
await page.waitForTimeout(800);
const rotationAfter = await py(`${display}.GetRotationHandleVisibility()`);
check("the rotation handles can be shown or hidden", rotationAfter !== rotationBefore, `${rotationBefore} -> ${rotationAfter}`);
check("the axes are hidden until More options", (await row("translation").locator("[data-name=handleComponent0]").count()) === 0);
await section.locator("[data-name=handlesMoreOptions]").click();
await page.waitForTimeout(400);
check("More options shows the X, Y, Z and view plane of each", (await row("translation").locator("input[type=checkbox]").count()) === 5);
await row("translation").locator("[data-name=handleComponent2]").click();
await page.waitForTimeout(800);
const components = await py(`str(list(${display}.GetTranslationHandleComponentVisibility()))`);
check("a translation axis can be hidden", components.startsWith("[True, True, False"), components);

const setSlider = async (name, value) => {
  await section.locator(`[data-name=${name}] input[type=number]`).fill(String(value));
  await section.locator(`[data-name=${name}] input[type=number]`).dispatchEvent("change");
  await page.waitForTimeout(600);
};
await setSlider("handlesSize", 5);
check("Size sets the handle scale", Number(await py(`${display}.GetInteractionHandleScale()`)) === 5);
await setSlider("handlesOpacity", 0.4);
check("Opacity sets the handle opacity", Math.abs(Number(await py(`${display}.GetInteractionHandleOpacity()`)) - 0.4) < 1e-6);
if (shot) await page.screenshot({ path: shot });

// A point list cannot show scaling handles
await run(`slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "F").AddControlPoint(5, 5, 5)`);
await page.waitForTimeout(500);
await panel.locator("select").first().selectOption({ label: "F" });
await page.waitForTimeout(1500);
const scaleRowClass = await section.locator("tr[data-kind=scale]").getAttribute("class");
check("scaling is disabled for markups that cannot be scaled", /pointer-events-none/.test(scaleRowClass ?? ""), scaleRowClass);

await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

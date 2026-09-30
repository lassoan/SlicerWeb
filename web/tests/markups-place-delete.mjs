// The Delete button of a markups place widget removes the last control point of the node its node
// selector shows, as on the desktop (qSlicerMarkupsPlaceWidget::deleteLastPoint). For each pair of a
// place widget and the node selector it follows in a module: the node the widget holds, three
// points added to the selector's node, a click on Delete, and the points left.
// Usage: node tests/markups-place-delete.mjs [url] ExtensionName Module placeWidget:selector ...
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const base = args[0] && /^https?:/.test(args[0]) ? args.shift() : "http://localhost:5173/";
const [extension, module, ...pairs] = args;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (m.type() === "error") console.log(`[error] ${m.text().slice(0, 400)}`); });
await page.goto(`${base}?sample=&extensions=${encodeURIComponent(extension)}`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForFunction(async (m) => String(await window.slicerWeb.bridge.evalPython(
  `str(hasattr(slicer.modules, ${JSON.stringify(m.toLowerCase())}))`, "eval")).includes("True"), module, { timeout: 600000, polling: 2000 });
await page.evaluate((m) => window.slicerWeb.bridge.evalPython(`slicer.util.selectModule(${JSON.stringify(m)})`), module);
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");

let failed = false;
for (const pair of pairs) {
  const [placeWidget, selector] = pair.split(":");
  const w = `slicer.util.getModuleWidget(${JSON.stringify(module)}).ui`;
  // make the widgets shown (the module shows some only in some modes), and give the selector a node with points
  const setup = await py(`(lambda ui: (ui.${placeWidget}.setVisible(True), ui.${selector}.setVisible(True),
    ui.${selector}.currentNode() or ui.${selector}.setCurrentNode(slicer.mrmlScene.AddNewNodeByClass(ui.${selector}.nodeTypes[0])),
    [ui.${selector}.currentNode().AddControlPoint(i, 0, 0) for i in range(3)],
    f"selector: {ui.${selector}.currentNode().GetName()}, place widget: {ui.${placeWidget}.currentNode().GetName() if ui.${placeWidget}.currentNode() else None}, points: {ui.${selector}.currentNode().GetNumberOfControlPoints()}")[-1])(${w})`);
  await page.locator(`[data-name="${placeWidget}"] [data-name="DeleteButton"] button`).click();
  await page.waitForTimeout(500);
  const after = Number(await py(`${w}.${selector}.currentNode().GetNumberOfControlPoints()`));
  const before = Number(setup.match(/points: (\d+)/)[1]);
  const ok = after === before - 1;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${placeWidget}: ${setup}; after Delete: ${after}`);
}
await browser.close();
console.log(failed ? "FAIL" : "ok");
process.exit(failed ? 1 : 0);

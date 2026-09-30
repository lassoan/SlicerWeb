// The Place button of a markups place widget is pressed exactly while points are placed into the
// node of that widget, as on the desktop: whatever starts or ends placing (its own button, another
// place widget, the mouse mode set elsewhere), and not for another widget's node.
// Usage: node tests/markups-place-button.mjs [url] ExtensionNames Module placeWidgetA:selectorA placeWidgetB:selectorB
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const base = args[0] && /^https?:/.test(args[0]) ? args.shift() : "http://localhost:5173/";
const [extensions, module, pairA, pairB] = args;
const [a, selectorA] = pairA.split(":");
const [b, selectorB] = pairB.split(":");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (m.type() === "error") console.log(`[error] ${m.text().slice(0, 400)}`); });
await page.goto(`${base}?sample=&extensions=${encodeURIComponent(extensions)}`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForFunction(async (m) => String(await window.slicerWeb.bridge.evalPython(
  `str(hasattr(slicer.modules, ${JSON.stringify(m.toLowerCase())}))`, "eval")).includes("True"), module, { timeout: 600000, polling: 2000 });
await page.evaluate((m) => window.slicerWeb.bridge.evalPython(`slicer.util.selectModule(${JSON.stringify(m)})`), module);
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const ui = `slicer.util.getModuleWidget(${JSON.stringify(module)}).ui`;
// both place widgets shown, each with a node of its own
await py(`[(getattr(${ui}, w).setVisible(True), getattr(${ui}, s).setVisible(True),
  getattr(${ui}, s).currentNode() or getattr(${ui}, s).setCurrentNode(slicer.mrmlScene.AddNewNodeByClass(getattr(${ui}, s).nodeTypes[0])))
  for w, s in ((${JSON.stringify(a)}, ${JSON.stringify(selectorA)}), (${JSON.stringify(b)}, ${JSON.stringify(selectorB)}))] and 1`);

const pressed = (w) => page.evaluate((name) => !!document.querySelector(`[data-name="${name}"] [data-name="PlaceButton"]`)?.checked, w);
const placing = () => py(`(lambda i, s: ('place' if i.GetCurrentInteractionMode() == i.Place else 'view') + ':' + str(s.GetActivePlaceNodeID()))(slicer.app.applicationLogic().GetInteractionNode(), slicer.app.applicationLogic().GetSelectionNode())`);
const nodeOf = (s) => py(`${ui}.${s}.currentNode().GetID()`);
const [nodeA, nodeB] = [await nodeOf(selectorA), await nodeOf(selectorB)];
let failed = false;
const check = async (step, wantA, wantB) => {
  await page.waitForTimeout(600);
  const [pa, pb, state] = [await pressed(a), await pressed(b), await placing()];
  const ok = pa === wantA && pb === wantB;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${step}: ${a} ${pa ? "pressed" : "up"}, ${b} ${pb ? "pressed" : "up"} (${state}; A=${nodeA}, B=${nodeB})`);
};
const click = (w) => page.locator(`[data-name="${w}"] [data-name="PlaceButton"] button`).click();

// the module may start placing by itself (ConduitPlanner does, for a new conduit's end points)
await check("at the start", (await placing()) === `place:${nodeA}`, (await placing()) === `place:${nodeB}`);
await py("slicer.app.applicationLogic().GetInteractionNode().SetCurrentInteractionMode(slicer.vtkMRMLInteractionNode.ViewTransform) or 1");
await check("mouse mode View", false, false);
await click(a);
await check(`Place of ${a}`, true, false);
await click(b);
await check(`Place of ${b} (placing into its node instead)`, false, true);
await py("slicer.app.applicationLogic().GetInteractionNode().SetCurrentInteractionMode(slicer.vtkMRMLInteractionNode.ViewTransform) or 1");
await check("mouse mode set to View elsewhere (the toolbar)", false, false);
await py(`(slicer.app.applicationLogic().GetSelectionNode().SetActivePlaceNodeID(${JSON.stringify(nodeA)}), slicer.app.applicationLogic().GetInteractionNode().SetCurrentInteractionMode(slicer.vtkMRMLInteractionNode.Place)) and 1`);
await check(`placing into ${a}'s node started elsewhere`, true, false);
await click(a);
await check(`Place of ${a} again (placing ended)`, false, false);
const mode = await placing();
if (!mode.startsWith("view")) { failed = true; console.log(`FAIL the mouse mode after ending placement: ${mode}`); }
await browser.close();
console.log(failed ? "FAIL" : "ok");
process.exit(failed ? 1 : 0);

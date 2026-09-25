// Baffle Planner: the Place button of a markups place widget places points in the markup the widget
// is showing. The widget is given that markup by the node selector beside it, through a connection
// made in Qt Designer (the module's .ui file), which the page makes as Qt's loader does; Place then
// makes it the active place node, so that a click in a view adds to it.
// Usage: node tests/baffle-planner-place.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);

const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheels = [];
const add = (n) => { const e = index.extensions.find((x) => x.name === n); if (!e) return; for (const d of e.depends ?? []) add(d); const u = new URL("extensions/" + e.wheel, base).href; if (!wheels.includes(u)) wheels.push(u); };
add("SlicerHeart");
await page.goto(base + "?sample=MRHead");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "BafflePlanner"), null, { timeout: 120000 });
await page.evaluate(() => { window.slicerWeb.store.activeModule = "BafflePlanner"; });
await page.waitForTimeout(5000);

// an input curve chosen in the module, and another point list made meanwhile (the active place node)
await exec([
  "curve = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLMarkupsClosedCurveNode', 'Contour')",
  "curve.CreateDefaultDisplayNodes()",
  "other = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLMarkupsFiducialNode', 'Other')",
  "other.CreateDefaultDisplayNodes()",
  "slicer.modules.BafflePlannerWidget.ui.inputCurveSelector.setCurrentNode(curve)",
].join("\n"));
await page.waitForTimeout(800);
check("the place widget shows the curve chosen in the selector (a .ui connection)",
  await py("slicer.modules.BafflePlannerWidget.ui.contourPointsPlaceWidget.currentNode().GetName()"), "Contour");

// the Place button of that widget, pressed (its toggled signal, as a click on the page sends it)
await exec("slicer._placeButton = slicer.modules.BafflePlannerWidget.ui.contourPointsPlaceWidget.placeButton()");
const buttonId = await py("slicer._placeButton._el.id or ''");
if (buttonId) await page.locator(`#${buttonId}`).click();
else await exec("slicer._placeButton.click()");
await page.waitForTimeout(600);
check("Place makes the curve the active place node", await py("slicer.mrmlScene.GetNodeByID(slicer.app.applicationLogic().GetSelectionNode().GetActivePlaceNodeID()).GetName()"), "Contour");
check("and enters place mode", await py("slicer.app.applicationLogic().GetInteractionNode().GetCurrentInteractionMode() == slicer.vtkMRMLInteractionNode.Place"), "True");

const box = await page.locator("#slicer-view-Red").boundingBox();
const [x, y] = [box.x + box.width * 0.45, box.y + box.height * 0.5];
await page.mouse.move(x - 3, y - 3);
await page.mouse.move(x, y);
await page.mouse.click(x, y);
await page.waitForTimeout(800);
check("a click in a view adds the point to the curve", await py("slicer.util.getNode('Contour').GetNumberOfControlPoints()"), "1");
check("not to the other point list", await py("slicer.util.getNode('Other').GetNumberOfControlPoints()"), "0");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

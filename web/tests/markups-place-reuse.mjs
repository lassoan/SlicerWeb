// Place mode adds points to the markup the selection node holds while it can take more, and makes
// a new one only when it cannot, as desktop Slicer does: placing points one after another fills one
// point list, a line gets its two points and the next one is a new line, and the markup chosen in
// the Markups module is the one points are added to.
// Usage: node tests/markups-place-reuse.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(2000);
const box = await page.locator("#slicer-view-Red").boundingBox();
let clicks = 0;
/** Enter place mode as the toolbar does, and click once in the Red view. */
async function placeOne(className) {
  await page.evaluate((c) => window.slicerWeb.bridge.call("placeMarkup", [c]), className);
  await page.waitForTimeout(300);
  const at = [box.x + box.width * (0.3 + 0.05 * (clicks % 8)), box.y + box.height * (0.4 + 0.03 * (clicks % 5))];
  clicks++;
  await page.mouse.move(at[0] - 3, at[1] - 3);
  await page.mouse.move(...at);
  await page.mouse.click(...at);
  await page.waitForTimeout(600);
}
/** Each markups node of the class and its number of points. */
const nodes = (className) => py(`",".join("%s:%d" % (n.GetName(), n.GetNumberOfControlPoints()) for n in slicer.util.getNodesByClass("${className}"))`);

// ---- point lists: one list, filled one point at a time
await placeOne("vtkMRMLMarkupsFiducialNode");
await placeOne("vtkMRMLMarkupsFiducialNode");
await placeOne("vtkMRMLMarkupsFiducialNode");
check("placing points one after another fills one point list", await nodes("vtkMRMLMarkupsFiducialNode"), "F:3");

// ---- lines: two points each, then a new one
await placeOne("vtkMRMLMarkupsLineNode");
await placeOne("vtkMRMLMarkupsLineNode");
check("a line takes its two points", await nodes("vtkMRMLMarkupsLineNode"), "L:2");
await placeOne("vtkMRMLMarkupsLineNode");
check("and the next point starts a new line", (await nodes("vtkMRMLMarkupsLineNode")).split(",").length, 2);

// ---- the point list chosen in the Markups module is the one added to
await exec("n = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLMarkupsFiducialNode', 'Other'); n.CreateDefaultDisplayNodes()");
await page.evaluate(() => {
  const s = window.slicerWeb.store;
  s.activeModule = "Markups";
});
await page.waitForTimeout(1000);
await page.evaluate(async () => {
  const id = await window.slicerWeb.bridge.evalPython("slicer.util.getNode('Other').GetID()", "eval");
  const s = window.slicerWeb.store;
  s.selectedNodeClass = "vtkMRMLMarkupsFiducialNode";
  s.selectedNodeID = String(id).replace(/^'|'$/g, "");
});
await page.waitForTimeout(1000);
await placeOne("vtkMRMLMarkupsFiducialNode");
check("the point list chosen in the Markups module gets the point", await nodes("vtkMRMLMarkupsFiducialNode"), "F:3,Other:1");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

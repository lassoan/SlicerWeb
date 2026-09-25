// Segments in the Data tree: listed under their segmentation, with their colour and an eye that
// shows or hides the segment. Clicking a segment opens its segmentation in the Segmentations module
// with the segment selected (slicer.app.openNodeModule(segmentation, "SegmentID", segmentID), as
// on the desktop) - or selects it in the Segment Editor, when that is the module on screen.
// Usage: node tests/subject-hierarchy-segments.mjs [url]
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
const store = (expr) => page.evaluate((e) => new Function("s", "return " + e)(window.slicerWeb.store), expr);

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(2000);
await exec([
  "seg = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLSegmentationNode', 'Seg')",
  "seg.CreateDefaultDisplayNodes()",
  "seg.GetSegmentation().AddEmptySegment('tumor', 'Tumor', [1.0, 0.0, 0.0])",
  "seg.GetSegmentation().AddEmptySegment('bone', 'Bone', [0.9, 0.9, 0.7])",
].join("\n"));
await page.waitForTimeout(1200);

const segmentRows = () => page.locator("[data-name=shItem][data-segment]").allInnerTexts();
check("the segments are listed under the segmentation", (await segmentRows()).map((t) => t.trim()).join(","), "Tumor,Bone");

// ---- a click on a segment: Segmentations, with the segment selected
await page.locator("[data-name=shItem][data-segment=bone]").click();
await page.waitForTimeout(1500);
check("clicking a segment opens Segmentations", await store("s.activeModule"), "Segmentations");
check("with its segmentation", await store("s.selectedNodeID"), await py("slicer.util.getNode('Seg').GetID()"));
check("and the segment selected in the module", await page.locator("[data-name=segmentRow][data-segment=bone]").first().evaluate((e) => e.className.includes("bg-accent")), true);
check("and in the tree", await page.locator("[data-name=shItem][data-segment=bone]").getAttribute("data-selected"), "true");
await page.locator("[data-name=shItem][data-segment=tumor]").click();
await page.waitForTimeout(800);
check("another segment of it: selected in the module in its turn", await page.locator("[data-name=segmentRow][data-segment=tumor]").first().evaluate((e) => e.className.includes("bg-accent")), true);

// ---- the same from Python, as desktop Slicer's segments plugin and Segment Editor do it
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Volumes"; });
await page.waitForTimeout(800);
await exec("slicer.app.openNodeModule(slicer.util.getNode('Seg'), 'SegmentID', 'bone')");
await page.waitForTimeout(1500);
check("slicer.app.openNodeModule(segmentation, 'SegmentID', id) opens Segmentations", await store("s.activeModule"), "Segmentations");
check("with that segment selected", await page.locator("[data-name=segmentRow][data-segment=bone]").first().evaluate((e) => e.className.includes("bg-accent")), true);

// ---- the eye of a segment
await page.locator("[data-name=shItem][data-segment=tumor] button[title]").last().click();
await page.waitForTimeout(800);
check("the eye of a segment hides it", await py("slicer.util.getNode('Seg').GetDisplayNode().GetSegmentVisibility('tumor')"), "False");
check("and shows it hidden", await store("s.subjectHierarchy.find((i) => i.name === 'Seg').children.find((c) => c.segmentID === 'tumor').visible"), false);
await page.locator("[data-name=shItem][data-segment=tumor] button[title]").last().click();
await page.waitForTimeout(800);
check("and again shows it", await py("slicer.util.getNode('Seg').GetDisplayNode().GetSegmentVisibility('tumor')"), "True");
await exec("slicer.util.getNode('Seg').GetDisplayNode().SetSegmentVisibility('bone', False)");
await page.waitForTimeout(800);
check("hidden from elsewhere: the eye follows", await store("s.subjectHierarchy.find((i) => i.name === 'Seg').children.find((c) => c.segmentID === 'bone').visible"), false);

// ---- the tree follows the segments
await exec("slicer.util.getNode('Seg').GetSegmentation().AddEmptySegment('liver', 'Liver')");
await exec("slicer.util.getNode('Seg').GetSegmentation().GetSegment('bone').SetName('Skull')");
await page.waitForTimeout(1200);
check("added and renamed segments show", (await segmentRows()).map((t) => t.trim()).join(","), "Tumor,Skull,Liver");

// ---- with the Segment Editor on screen, a segment picked in the tree is the one edited
await page.evaluate(() => { window.slicerWeb.store.activeModule = "SegmentEditor"; });
await page.waitForTimeout(2500);
await page.locator("[data-name=shItem][data-segment=liver]").click();
await page.waitForTimeout(1500);
check("the Segment Editor stays on screen", await store("s.activeModule"), "SegmentEditor");
check("and edits the segment picked", await page.locator("[data-name=segmentRow][data-segment=liver]").first().evaluate((e) => e.className.includes("bg-accent")), true);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

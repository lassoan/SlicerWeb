// What a segment is: double-clicking it opens the terminology selector, and choosing a category,
// a type and a modifier names the segment after it and colours it as the terminology recommends.
// Usage: node tests/segment-editor-terminology.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 200)));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);
const text = async (expr) => String(await value(expr)).replace(/^['"]|['"]$/g, "");
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

// the module opens on a segmentation of its own, and a segment to name
await page.getByRole("button", { name: "Segment Editor" }).first().click();
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
await panel.locator("button", { hasText: /^Add$/ }).first().click();
await page.waitForTimeout(1200);

const segmentRow = page.locator("[data-name='segmentRow']").first();
const nameBefore = (await segmentRow.innerText()).trim();
await segmentRow.dblclick();
await page.waitForTimeout(1500);
const dialog = page.locator("[data-name='terminologySelector']");
check("double-clicking a segment asks what it is", await dialog.count() > 0);
const categories = await page.locator("[data-name='terminologyCategories'] button").allInnerTexts();
check("it offers the categories of the terminology", categories.length > 1, categories.slice(0, 4).join(", "));

// a type of the first category
const types = page.locator("[data-name='terminologyTypes'] button");
const typeNames = await types.allInnerTexts();
check("and the types in the category", typeNames.length > 1, typeNames.slice(0, 4).join(", "));
const wanted = typeNames.findIndex((t) => /liver|tissue|muscle/i.test(t));
await types.nth(Math.max(0, wanted)).click();
await page.waitForTimeout(600);
const chosen = (await types.nth(Math.max(0, wanted)).innerText()).trim();

await page.locator("[data-name='terminologyApply']").click();
await page.waitForTimeout(1500);
check("choosing one closes the selector", (await page.locator("[data-name='terminologySelector']").count()) === 0);

const nameAfter = await text(`
(lambda n: n.GetSegmentation().GetNthSegment(0).GetName())(__import__("slicer").util.getNodesByClass("vtkMRMLSegmentationNode")[0])`);
check("the segment is named after what it is", nameAfter === chosen && nameAfter !== nameBefore,
  `"${nameBefore}" -> "${nameAfter}" (chose "${chosen}")`);

const tag = await text(`
(lambda s, v: (s.GetTag(__import__("slicer").vtkSegment.GetTerminologyEntryTagName(), v), str(v))[1])(
    __import__("slicer").util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNthSegment(0),
    __import__("vtk").reference(""))`);
check("and carries the terminology entry", tag.includes("~SCT^") && tag.includes(chosen), tag.slice(0, 110));

const colour = await text(`
(lambda s: "#%02x%02x%02x" % tuple(int(c * 255 + 0.5) for c in s.GetColor()))(
    __import__("slicer").util.getNodesByClass("vtkMRMLSegmentationNode")[0].GetSegmentation().GetNthSegment(0))`);
check("and the colour the terminology recommends", /^#[0-9a-f]{6}$/.test(colour) && colour !== "#000000", colour);

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

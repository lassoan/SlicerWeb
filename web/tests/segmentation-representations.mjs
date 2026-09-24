// The Segmentations module's Representations section: what a segmentation holds (its source,
// the representations made from it, the ones that could be), creating one with the default
// conversion, updating one with a chosen path and parameters, removing one and making one the
// source - as qMRMLSegmentationRepresentationsListView and the advanced conversion dialog do.
// Usage: node tests/segmentation-representations.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(2000);
// A segmentation with one sphere, whose source is a binary labelmap (as painted segments are)
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import vtk, slicer
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Segmentation")
seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(slicer.util.getNode("MR-head"))
sphere = vtk.vtkSphereSource(); sphere.SetRadius(20.0); sphere.SetPhiResolution(30); sphere.SetThetaResolution(30); sphere.Update()
seg.AddSegmentFromClosedSurfaceRepresentation(sphere.GetOutput(), "Sphere", [1.0, 0.5, 0.0])
seg.GetSegmentation().RemoveRepresentation("Closed surface")
`, "exec"));
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Segmentations"; });
await page.waitForTimeout(3000);
const panel = page.locator(".sw-panel-scroll").last();
const row = (name) => panel.locator(`[data-name=representation][data-representation="${name}"]`);
// what can be done with a representation is in its ... menu
const choose = async (name, item) => {
  await row(name).locator("[data-name=representationMore]").click();
  await page.waitForTimeout(300);
  await page.locator("[role=menu]").getByRole("menuitem", { name: item, exact: true }).click();
};
const offers = async (name) => {
  await row(name).locator("[data-name=representationMore]").click();
  await page.waitForTimeout(300);
  const items = (await page.locator("[role=menu] [role=menuitem]").allInnerTexts()).map((t) => t.trim()).join(", ");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  return items;
};
const status = async (name) => (await row(name).innerText()).replace(/\s+/g, " ").trim();
const contained = () => py('(lambda names: (slicer.util.getNode("Segmentation").GetSegmentation().GetContainedRepresentationNames(names), sorted(names))[1])([])');

// the section starts collapsed: open it
await panel.getByText("Representations", { exact: true }).click();
await page.waitForTimeout(400);
check("the representations are listed", await panel.locator("[data-name=representation]").count() >= 4, true);
check("Binary labelmap is the source", /Binary labelmap Source/.test(await status("Binary labelmap")), true);
check("Closed surface is not present", /Closed surface not present/.test(await status("Closed surface")), true);
check("and its menu offers to create it", await offers("Closed surface"), "Create, Advanced create…");

// Create with the default conversion
await choose("Closed surface", "Create");
await page.waitForFunction(() => /Closed surface\s+Present/.test(document.body.innerText.replace(/\s+/g, " ")), null, { timeout: 60000 });
check("created: it is present", /Closed surface Present/.test(await status("Closed surface")), true);
check("and its menu offers to update, remove or make it the source", await offers("Closed surface"), "Update…, Remove, Make source");
check("and the segmentation holds it", await contained(), "['Binary labelmap', 'Closed surface']");
const pointsBefore = Number(await py('slicer.util.getNode("Segmentation").GetSegmentation().GetNthSegment(0).GetRepresentation("Closed surface").GetNumberOfPoints()'));

// Update with a chosen parameter: decimation, so the surface has fewer points
await choose("Closed surface", "Update…");
await page.waitForTimeout(500);
const dialog = panel.locator("[data-name=advancedConversion]");
check("the advanced conversion offers the path", /Binary labelmap -> Closed surface/.test(await dialog.innerText()), true);
const decimation = dialog.locator("input[data-parameter='Decimation factor']");
check("with its parameters", await decimation.count(), 1);
console.log("     decimation factor was", await decimation.inputValue(), "with", pointsBefore, "points");
await decimation.fill("0.5");
await dialog.getByRole("button", { name: "Convert" }).click();
await page.waitForTimeout(3000);
const pointsAfter = Number(await py('slicer.util.getNode("Segmentation").GetSegmentation().GetNthSegment(0).GetRepresentation("Closed surface").GetNumberOfPoints()'));
console.log("     points after:", pointsAfter);
check("the parameter is kept by the segmentation", await py('slicer.util.getNode("Segmentation").GetSegmentation().GetConversionParameter("Decimation factor")'), "0.5");
check("and the surface was made again with it", pointsAfter < pointsBefore * 0.8, true);

// Remove
await choose("Closed surface", "Remove");
await page.waitForTimeout(1000);
check("removed: not present again", /Closed surface not present/.test(await status("Closed surface")), true);
check("and gone from the segmentation", await contained(), "['Binary labelmap']");

// Make source (after creating it again): asked first, as on the desktop
await choose("Closed surface", "Create");
await page.waitForFunction(() => /Closed surface\s+Present/.test(document.body.innerText.replace(/\s+/g, " ")), null, { timeout: 60000 });
await choose("Closed surface", "Make source");
await page.waitForTimeout(1500);
check("making it the source asks first", dialogs.some((m) => /source representation/i.test(m)), true);
check("Closed surface is the source", /Closed surface Source/.test(await status("Closed surface")), true);
check("as the segmentation says", await py('slicer.util.getNode("Segmentation").GetSegmentation().GetSourceRepresentationName()'), "Closed surface");
check("Binary labelmap can now be made from it", /Create|Update/.test(await offers("Binary labelmap")), true);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

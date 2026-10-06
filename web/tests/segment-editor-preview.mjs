// Grow from seeds and Fill between slices show a preview before they change anything, as in desktop
// Slicer: Initialize computes the result into a preview segmentation shown over the inputs; editing
// the inputs updates it a moment later (auto-update); the opacity slider moves between inputs and
// results; Cancel removes it and Apply replaces the segments by it (which can be undone).
// Usage: node tests/segment-editor-preview.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 200)));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);
const text = async (expr) => String(await value(expr)).replace(/^['"]|['"]$/g, "");
const number = async (expr) => Number(await value(expr));
const json = async (expr) => JSON.parse(await text(expr));
const call = (method, args = []) => page.evaluate(([m, a]) => window.slicerWeb.bridge.call(m, a), [method, args]);
const editorState = () => call("segmentEditorState");
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

await run(`
import json, numpy as np, slicer
from vtk.util import numpy_support

volume = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]
shape = slicer.util.arrayFromVolume(volume).shape
mid = [s // 2 for s in shape]

def segmentation(name):
    node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", name)
    node.CreateDefaultDisplayNodes()
    node.SetReferenceImageGeometryParameterFromVolumeNode(volume)
    return node

def count(node, segmentID):
    return int((slicer.util.arrayFromSegmentBinaryLabelmap(node, segmentID, volume) > 0).sum())

def square(y0, y1, x0, x1, slice=0):
    a = np.zeros(shape, np.uint8)
    a[mid[0] + slice, mid[1] + y0:mid[1] + y1, mid[2] + x0:mid[2] + x1] = 1
    return a

def preview():
    from slicerweb import segment_editor
    return segment_editor.editor().editorNode.GetNodeReference("SegmentationResultPreview")

def previewCounts():
    node = preview()
    if node is None:
        return None
    return {node.GetSegmentation().GetNthSegmentID(i): count(node, node.GetSegmentation().GetNthSegmentID(i))
            for i in range(node.GetSegmentation().GetNumberOfSegments())}

seeded = segmentation("Seeds")
inside = seeded.GetSegmentation().AddEmptySegment("", "inside")
outside = seeded.GetSegmentation().AddEmptySegment("", "outside")
slicer.util.updateSegmentBinaryLabelmapFromArray(square(-2, 2, -2, 2), seeded, inside, volume)
slicer.util.updateSegmentBinaryLabelmapFromArray(square(20, 24, 20, 24), seeded, outside, volume)
`);

await page.getByRole("button", { name: "Segment Editor" }).first().click();
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
await call("segmentEditorSetup", [await text("seeded.GetID()"), null]);
await call("segmentEditorSelectSegment", [await text("inside")]);
await page.waitForTimeout(500);

// --- Grow from seeds
await panel.getByRole("button", { name: "Grow from seeds", exact: true }).first().click();
await page.waitForTimeout(800);
const button = (name) => panel.getByRole("button", { name, exact: true }).first();
check("grow: before Initialize, Apply and Cancel are disabled",
  (await button("Apply").isDisabled()) && (await button("Cancel").isDisabled()));
const inputsBefore = [await number("count(seeded, inside)"), await number("count(seeded, outside)")];
await button("Initialize").click();
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Update"), null, { timeout: 60000 });
await page.waitForTimeout(500);
let counts = await json("json.dumps(previewCounts())");
const insideID = await text("inside"), outsideID = await text("outside");
check("grow: Initialize computes a preview segmentation", counts && counts[insideID] > 100 && counts[outsideID] > 100, JSON.stringify(counts));
check("grow: and leaves the segments as they are",
  (await number("count(seeded, inside)")) === inputsBefore[0] && (await number("count(seeded, outside)")) === inputsBefore[1]);
const display = await json(`json.dumps([seeded.GetDisplayNode().GetOpacity(), preview().GetDisplayNode().GetOpacity(), preview().GetName()])`);
check("grow: the preview is shown over the inputs, as on the desktop", Math.abs(display[0] - 0.4) < 1e-6 && Math.abs(display[1] - 0.6) < 1e-6
  && display[2] === "Seeds preview", JSON.stringify(display));
check("grow: Apply and Cancel are enabled", !(await button("Apply").isDisabled()) && !(await button("Cancel").isDisabled()));

// the opacity slider moves between inputs and results
await call("segmentEditorSetPreviewDisplay", [0.2, null]);
const moved = await json(`json.dumps([seeded.GetDisplayNode().GetOpacity(), preview().GetDisplayNode().GetOpacity()])`);
check("grow: the display slider moves between inputs and results", Math.abs(moved[0] - 0.8) < 1e-6 && Math.abs(moved[1] - 0.2) < 1e-6, JSON.stringify(moved));
await call("segmentEditorSetPreviewDisplay", [0.6, null]);

// editing the inputs (painting, here from Python) updates the preview a moment later
const insideBeforeEdit = counts[insideID];
await run(`slicer.util.updateSegmentBinaryLabelmapFromArray(square(-2, 2, -2, 2) | square(-15, 15, -15, -12), seeded, inside, volume)`);
await page.waitForTimeout(400);
const tooSoon = (await json("json.dumps(previewCounts())"))[insideID];
await page.waitForTimeout(4000);
const updated = (await json("json.dumps(previewCounts())"))[insideID];
check("grow: auto-update waits for the edits to end", tooSoon === insideBeforeEdit, `${tooSoon} right after the edit`);
check("grow: and then updates the preview", updated !== insideBeforeEdit, `${insideBeforeEdit} -> ${updated}`);

// with auto-update off, editing does not change the preview
await panel.getByText("Auto-update", { exact: true }).click();
await page.waitForTimeout(500);
check("grow: auto-update can be switched off", (await editorState()).effectParameters.GrowFromSeeds.AutoUpdate === 0);
// (grow-cut updates incrementally, as on the desktop: added seeds change the result, removed ones need Initialize)
await run(`slicer.util.updateSegmentBinaryLabelmapFromArray(square(20, 24, 20, 24) | square(-15, 15, -10, -8), seeded, outside, volume)`);
await page.waitForTimeout(2500);
check("grow: then editing does not update the preview", (await json("json.dumps(previewCounts())"))[insideID] === updated);
await button("Update").click();
await page.waitForTimeout(3000);
const afterUpdate = (await json("json.dumps(previewCounts())"))[insideID];
check("grow: Update computes it again", afterUpdate !== updated, `${updated} -> ${afterUpdate}`);
await panel.getByText("Auto-update", { exact: true }).click();
await page.waitForTimeout(500);

// the preview stays while another effect is used, as on the desktop
await panel.getByRole("button", { name: "Paint", exact: true }).first().click();
await page.waitForTimeout(500);
check("grow: the preview stays while painting", (await text("str(preview() is not None)")) === "True");
const note = panel.locator("[data-name=backgroundPreview]");
check("grow: while painting, a note says the preview is kept up to date", (await note.count()) === 1
  && /Grow from seeds preview is shown, and updated as the segments are edited/.test(await note.innerText()), await note.innerText().catch(() => ""));
await note.getByRole("button").click();
await page.waitForTimeout(800);
check("grow: and its button switches to Grow from seeds", (await editorState()).effect === "GrowFromSeeds" && (await note.count()) === 0);
await panel.getByRole("button", { name: "Paint", exact: true }).first().click();
await page.waitForTimeout(500);
await panel.getByRole("button", { name: "Grow from seeds", exact: true }).first().click();
await page.waitForTimeout(800);
check("grow: and is offered for update when the effect is chosen again", await button("Update").isVisible());

// Cancel
await button("Cancel").click();
await page.waitForTimeout(1000);
check("grow: Cancel removes the preview", (await text("str(preview() is None)")) === "True"
  && (await number("seeded.GetDisplayNode().GetOpacity()")) === 1, await text("str(seeded.GetDisplayNode().GetOpacity())"));
check("grow: and leaves no preview segmentation in the scene",
  (await text(`str([n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLSegmentationNode")])`)).indexOf("preview") < 0);

// Initialize and Apply
await button("Initialize").click();
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Update"), null, { timeout: 60000 });
counts = await json("json.dumps(previewCounts())");
const insideBeforeApply = await number("count(seeded, inside)");
await button("Apply").click();
await page.waitForTimeout(1500);
const applied = [await number("count(seeded, inside)"), await number("count(seeded, outside)")];
check("grow: Apply replaces the segments by the preview", applied[0] === counts[insideID] && applied[1] === counts[outsideID],
  `${JSON.stringify(applied)} against ${JSON.stringify(counts)}`);
check("grow: and removes the preview", (await text("str(preview() is None)")) === "True" && (await number("seeded.GetDisplayNode().GetOpacity()")) === 1);
await call("segmentEditorUndo");
check("grow: Apply can be undone", (await number("count(seeded, inside)")) === insideBeforeApply,
  `${await text("str(count(seeded, inside))")} (${insideBeforeApply} before Apply)`);

// fewer visible segments than needed: the reason is shown
await run(`seeded.GetDisplayNode().SetSegmentVisibility(outside, False)`);
await button("Initialize").click();
await page.waitForTimeout(1500);
const errorText = await panel.locator("[class*=bg-destructive]").first().innerText().catch(() => "");
check("grow: with one visible segment Initialize says two are needed", /Minimum 2 visible segments/.test(errorText), errorText);
await run(`seeded.GetDisplayNode().SetSegmentVisibility(outside, True)`);

// --- Fill between slices
await run(`
gaps = segmentation("Gaps")
gap = gaps.GetSegmentation().AddEmptySegment("", "gap")
slicer.util.updateSegmentBinaryLabelmapFromArray(square(-10, 10, -10, 10) | square(-6, 6, -6, 6, slice=6), gaps, gap, volume)
`);
await call("segmentEditorSetup", [await text("gaps.GetID()"), null]);
await panel.getByRole("button", { name: "Fill between slices", exact: true }).first().click();
await page.waitForTimeout(800);
const twoSlices = await number("count(gaps, gap)");
await button("Initialize").click();
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Update"), null, { timeout: 60000 });
const gapID = await text("gap");
const filledPreview = (await json("json.dumps(previewCounts())"))[gapID];
check("fill: Initialize fills the slices between in the preview", filledPreview > twoSlices * 2 && (await number("count(gaps, gap)")) === twoSlices,
  `${twoSlices} -> ${filledPreview} in the preview`);
await button("Apply").click();
await page.waitForTimeout(1500);
check("fill: Apply puts it in the segment", (await number("count(gaps, gap)")) === filledPreview);

// --- a scene saved with a preview in it, loaded again (as after starting again): auto-update follows
// the inputs without Grow from seeds being chosen first
await run(`
seeded2 = segmentation("Reloaded")
inside2 = seeded2.GetSegmentation().AddEmptySegment("", "inside")
outside2 = seeded2.GetSegmentation().AddEmptySegment("", "outside")
slicer.util.updateSegmentBinaryLabelmapFromArray(square(-2, 2, -2, 2), seeded2, inside2, volume)
slicer.util.updateSegmentBinaryLabelmapFromArray(square(20, 24, 20, 24), seeded2, outside2, volume)
`);
await call("segmentEditorSetup", [await text("seeded2.GetID()"), null]);
await call("segmentEditorSelectSegment", [await text("inside2")]);
await panel.getByRole("button", { name: "Grow from seeds", exact: true }).first().click();
await page.waitForTimeout(800);
await button("Initialize").click();
await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Update"), null, { timeout: 60000 });
await call("segmentEditorSetPreviewDisplay", [0.3, null]);
await panel.getByRole("button", { name: "Paint", exact: true }).first().click();
await page.waitForTimeout(500);
await run(`
import os, shutil
from slicerweb import segment_editor, segment_editor_effects
folder = "/tmp/preview-scene"
shutil.rmtree(folder, ignore_errors=True)
os.makedirs(folder)
slicer.app.applicationLogic().SaveSceneToSlicerDataBundleDirectory(folder, None)
sceneFile = [os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".mrml")][0]
slicer.mrmlScene.Clear(0)
# as when the page is started again: nothing of the preview is known but what the scene says
segment_editor.editor().autoComplete = segment_editor_effects.AutoCompletePreview(segment_editor.editor())
slicer.util.loadScene(sceneFile)
reloaded = slicer.util.getNode("Reloaded")
volume = slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode")[0]
`);
await page.waitForTimeout(1500);
const reloadedInside = await text("reloaded.GetSegmentation().GetSegmentIdBySegmentName('inside')");
const previewOf = () => json(`json.dumps((lambda n: None if n is None else count(n, "${reloadedInside}"))(preview()))`);
const beforeEdit = await previewOf();
check("reload: the preview is in the loaded scene", typeof beforeEdit === "number" && beforeEdit > 0, String(beforeEdit));
check("reload: and so is its display (inputs/results)", Math.abs((await number("preview().GetDisplayNode().GetOpacity()")) - 0.3) < 1e-6);
await run(`slicer.util.updateSegmentBinaryLabelmapFromArray(square(-2, 2, -2, 2) | square(-15, 15, -15, -12), reloaded, "${reloadedInside}", volume)`);
await page.waitForTimeout(5000);
const afterEdit = await previewOf();
check("reload: editing the inputs updates the preview, without choosing Grow from seeds", afterEdit !== beforeEdit,
  `${beforeEdit} -> ${afterEdit}, effect ${(await editorState()).effect}`);
check("reload: and keeps how it is shown", Math.abs((await number("preview().GetDisplayNode().GetOpacity()")) - 0.3) < 1e-6,
  await text("str(preview().GetDisplayNode().GetOpacity())"));

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

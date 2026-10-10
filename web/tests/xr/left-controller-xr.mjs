// The left controller does what the panel's category is for, against the stand-in for WebXR
// (xr-mock.js, with layers, its controller made a left one): in Data its thumbstick chooses an item
// of the data tree (up, down) and pages it, the item in the same row of the page chosen (left,
// right); its trigger shows or hides the item, X makes it half transparent and Y clips it - segments
// too, which are listed from their segmentation (not the items desktop Slicer keeps for them); in
// Markups X takes back the last
// point and Y shows or hides the handles; in Clipping X turns clipping on and off, Y turns the plane
// square to the line of sight, the thumbstick moves it along its normal, the trigger holds it (the
// grip holds the scene); in View it does what the right one does (Y: the panel). A button with no
// standard name (the Menu button) shows and hides the panel.
//
// Usage: node tests/xr/left-controller-xr.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=MRHead&layout=OneUp3D&layers";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => {
  if (m.type() === "error") console.log(`[error] ${m.text().slice(0, 300)}`);
});
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const python = (e, mode = "eval") => page.evaluate(([e, mode]) => window.slicerWeb.bridge.evalPython(e, mode), [e, mode]);
const pyJSON = (e) => python(`__import__('json').dumps(${e})`).then((r) => JSON.parse(r.slice(1, -1)));
let time = 0;
const frames = (count) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start: (time += count * 14) });
const panel = () => page.evaluate(() => {
  const p = window.slicerXR.session.panel;
  return { category: p.category, page: p.dataPage, pages: p.dataPages, clip: p.clip, visible: p.visible, handles: p.handlesOn, status: p.status, selected: p.selectedItem, items: p.dataItems };
});
const category = (c) => page.evaluate((c) => {
  window.slicerXR.session.panel.setCategory(c);
}, c);
/** A button of the controller pressed for a frame, then let go. */
const button = async (index) => {
  await page.evaluate((i) => {
    const pad = window.__xrMock.controller.gamepad;
    while (pad.buttons.length <= i) pad.buttons.push({ pressed: false, value: 0 });
    pad.buttons[i].pressed = true;
  }, index);
  await frames(1);
  await page.evaluate((i) => (window.__xrMock.controller.gamepad.buttons[i].pressed = false), index);
  await frames(1);
};
const stick = async (x, y, count) => {
  await page.evaluate(([x, y]) => (window.__xrMock.controller.gamepad.axes = [0, 0, x, y]), [x, y]);
  await frames(count);
  await page.evaluate(() => (window.__xrMock.controller.gamepad.axes = [0, 0, 0, 0]));
  await frames(1);
};
const worldFromRoom = () => page.evaluate(() => [...window.slicerXR.session.worldFromRoom]);

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
for (let i = 0; i < 300 && Number(await python("len(slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode'))")) === 0; i++) await page.waitForTimeout(1000);
// The scene: MRHead, balls enough for two pages of the data tree, a point list, and a segmentation
// with two segments - and the items desktop Slicer keeps for them (virtual branch items, which a
// scene saved there has)
await python([
  "import slicer, vtk",
  "for i in range(9):",
  "    sphere = vtk.vtkSphereSource()",
  "    sphere.SetRadius(10)",
  "    sphere.SetCenter(i * 5 - 20, 0, 0)",
  "    sphere.Update()",
  "    slicer.modules.models.logic().AddModel(sphere.GetOutput()).SetName(f'Ball {i}')",
  "POINTS = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLMarkupsFiducialNode', 'Points')",
  "POINTS.AddControlPoint([0, 0, 0])",
  "POINTS.AddControlPoint([10, 0, 0])",
  "HEART = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLSegmentationNode', 'Heart')",
  "HEART.CreateDefaultDisplayNodes()",
  "for name, radius in (('Atrium', 8), ('Ventricle', 12)):",
  "    sphere = vtk.vtkSphereSource()",
  "    sphere.SetRadius(radius)",
  "    sphere.Update()",
  "    HEART.AddSegmentFromClosedSurfaceRepresentation(sphere.GetOutput(), name, [1, 0, 0])",
  "sh = slicer.mrmlScene.GetSubjectHierarchyNode()",
  "for segmentID in HEART.GetSegmentation().GetSegmentIDs():",
  "    kept = sh.CreateHierarchyItem(sh.GetItemByDataNode(HEART), HEART.GetSegmentation().GetSegment(segmentID).GetName(), 'VirtualBranch')",
  "    sh.SetItemAttribute(kept, slicer.vtkMRMLSegmentationNode.GetSegmentIDAttributeName(), segmentID)",
  "ATRIUM = HEART.GetSegmentation().GetSegmentIdBySegmentName('Atrium')",
].join("\n"), "exec");
// The first segmentation of a page keeps it busy for a while (in this browser, up to a minute) before
// it draws again: waited for
const drawing = () => page.evaluate(() => new Promise((resolve) => {
  let n = 0;
  const t0 = performance.now();
  const frame = () => (++n, performance.now() - t0 < 500 ? requestAnimationFrame(frame) : resolve(n));
  requestAnimationFrame(frame);
}));
for (let i = 0; i < 60 && (await Promise.race([drawing(), new Promise((r) => setTimeout(() => r(0), 3000))])) < 5; i++);
await page.evaluate(() => (window.__xrMock.controller.handedness = "left"));
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(4);

// Data: the thumbstick pages (left, right) and chooses an item (up, down); the trigger, X and Y
// change it
await category("data");
await page.evaluate(() => window.slicerXR.session.refreshDataItems(true));
await frames(2);
let p = await panel();
const names = p.items.map((i) => `${i.name}${i.kind ? ` (${i.kind})` : ""}`);
check(p.pages >= 2 && p.page === 0 && p.selected === null, `the data tree has ${p.pages} pages, and nothing is chosen: ${names.join(", ")}`);
const segments = p.items.filter((i) => i.kind === "Segment");
check(segments.map((i) => i.name).join() === "Atrium,Ventricle" && p.items.filter((i) => i.name === "Atrium").length === 1,
  "the segments are listed under their segmentation, once (not the items desktop Slicer keeps for them)");
check(!p.items.some((i) => /virtual/i.test(i.kind)), 'no item says "Virtual branch"');
const at = (index) => p.items[index].id;
let before = await worldFromRoom();
await stick(1, 0, 3);
check((await panel()).page === 1 && (await panel()).selected === at(7), "the left stick pushed right shows the next page, its first item chosen");
check(JSON.stringify(await worldFromRoom()) === JSON.stringify(before), "and does not turn the scene");
await stick(-1, 0, 3);
check((await panel()).page === 0 && (await panel()).selected === at(0), "pushed left, the previous page, its first item chosen");
await stick(0, 1, 3);
check((await panel()).selected === at(1), "pushed down, the next item");
await stick(0, -1, 3);
check((await panel()).selected === at(0), "up, the one above");
await stick(0, 1, 3);
await stick(0, 1, 3);
await stick(1, 0, 3);
check((await panel()).page === 1 && (await panel()).selected === at(9), "from the third item, the next page chooses its third item");
await stick(-1, 0, 3);
check((await panel()).page === 0 && (await panel()).selected === at(2), "and the previous page, the third again");
for (let i = 0; i < 5; i++) await stick(0, 1, 3);
check((await panel()).selected === at(7) && (await panel()).page === 1, "down five more, the eighth item: the page follows it");
check(JSON.stringify(await worldFromRoom()) === JSON.stringify(before), "and the scene does not zoom");
// The chosen item, a ball: the trigger (pointing past the panel) shows and hides it, X makes it
// half transparent
const chosen = p.items[7];
const ballVisible = () => python(`slicer.mrmlScene.GetNodeByID('${chosen.nodeID}').GetDisplayNode().GetVisibility()`);
const ballOpacity = () => python(`slicer.mrmlScene.GetNodeByID('${chosen.nodeID}').GetDisplayNode().GetOpacity()`);
const ballClipped = () => python(`slicer.mrmlScene.GetNodeByID('${chosen.nodeID}').GetDisplayNode().GetClipping()`);
check(chosen.kind === "Model", `the eighth item is a model (${chosen.name})`);
await page.evaluate(() => (window.__xrMock.controllerPosition = [-0.3, 1.1, -0.45]));
await frames(1);
const trigger = async () => {
  await page.evaluate(() => window.__xrMock.session.dispatch("selectstart", { inputSource: window.__xrMock.controller }));
  await frames(1);
  await page.evaluate(() => window.__xrMock.session.dispatch("selectend", { inputSource: window.__xrMock.controller }));
  await frames(2);
};
before = await worldFromRoom();
await trigger();
check(await ballVisible() === "0", "the trigger hides the chosen item");
check(JSON.stringify(await worldFromRoom()) === JSON.stringify(before), "and does not hold the scene");
await trigger();
check(await ballVisible() === "1", "the trigger again shows it");
await button(4);
check(await ballOpacity() === "0.5", "X makes it half transparent");
await button(4);
check(await ballOpacity() === "1.0", "X again, opaque");
// Y: clipping - turned on for it while clipping is off, then off and on for it
await button(5);
await page.evaluate(() => window.slicerXR.session.refreshClipState(true));
check((await panel()).clip.enabled && await ballClipped() === "1", "Y, with clipping off, turns clipping on for the chosen item");
await button(5);
check(await ballClipped() === "0" && (await panel()).clip.enabled, "Y again stops clipping it (clipping stays on)");
await button(5);
check(await ballClipped() === "1" && await ballOpacity() === "1.0", "Y again clips it (and leaves its opacity)");
await page.evaluate(() => window.slicerXR.session.press({ id: "clip-enable" })); // (off, for the Clipping category below)
// A segment: the trigger shows and hides it, X makes it half transparent - in its segmentation
const atriumIndex = p.items.findIndex((i) => i.name === "Atrium");
for (let i = 7; i < atriumIndex; i++) await stick(0, 1, 3);
check((await panel()).selected === at(atriumIndex), "down to the segment Atrium");
const atrium = (what) => python(`HEART.GetDisplayNode().${what}(ATRIUM)`);
await trigger();
check(await atrium("GetSegmentVisibility") === "False" && await python("HEART.GetDisplayNode().GetSegmentVisibility(HEART.GetSegmentation().GetSegmentIdBySegmentName('Ventricle'))") === "True",
  "the trigger hides the segment, and only it");
await page.evaluate(() => window.slicerXR.session.refreshDataItems(true));
check(!(await panel()).items.find((i) => i.name === "Atrium").visible, "and the tree says so");
await trigger();
check(await atrium("GetSegmentVisibility") === "True", "the trigger again shows it");
await button(4);
check(await atrium("GetSegmentOpacity3D") === "0.5", "X makes the segment half transparent");
await page.evaluate(() => window.slicerXR.session.refreshDataItems(true));
check((await panel()).items.find((i) => i.name === "Atrium").transparent, "and the tree says so");
await button(4);
check(await atrium("GetSegmentOpacity3D") === "1.0", "X again, opaque");
// Clipping a segment clips its segmentation, all of it
const heartClipped = () => python("HEART.GetDisplayNode().GetClipping()");
await button(5);
await page.evaluate(() => window.slicerXR.session.refreshClipState(true));
check((await panel()).clip.enabled && await heartClipped() === "1", "Y on a segment, with clipping off, turns clipping on for its segmentation");
await page.evaluate(() => window.slicerXR.session.refreshDataItems(true));
p = await panel();
check(p.items.filter((i) => i.kind === "Segment").every((i) => i.clippable && i.clipped), "both segments say they are clipped");
const segmentClip = await page.evaluate(() => {
  const s = window.slicerXR.session;
  const button = s.panel.buttons.find((b) => b.id?.startsWith("clip:") && b.treeItem?.name === "Atrium");
  if (button) s.press(button);
  return !!button;
});
check(segmentClip && await heartClipped() === "0", "the segment's clipping icon in the panel stops clipping the segmentation");
await page.evaluate(() => window.slicerXR.session.refreshDataItems(true));
await button(5);
check(await heartClipped() === "1", "Y on the segment again clips it");
await page.evaluate(() => window.slicerXR.session.press({ id: "clip-enable" })); // (off, for the Clipping category below)

// Markups: X takes back the last point, Y shows and hides the handles
await category("markups");
await button(4);
check(await python("POINTS.GetNumberOfControlPoints()") === "1", "in Markups, X takes back the last point");
await button(5);
check(await python("slicerXR.handlesShown()") === "True" && (await panel()).handles && (await panel()).visible, "Y shows the handles (and leaves the panel shown)");
await button(5);
check(await python("slicerXR.handlesShown()") === "False", "Y again hides them");

// Clipping: X turns it on, the stick shifts the plane, the grip holds it
await category("clipping");
await button(4);
p = await panel();
check(p.clip.enabled, `in Clipping, X turns clipping on (${p.status})`);
p = await panel();
const offset0 = p.clip.offset;
await stick(0, -1, 20);
await page.evaluate(() => window.slicerXR.session.refreshClipState(true));
p = await panel();
check(p.clip.offset > offset0 + 1, `the stick pushed up moves the plane along its normal (${offset0.toFixed(1)} -> ${p.clip.offset.toFixed(1)} mm)`);
const plane = () => pyJSON("list(slicerXR._clipNodes()[1].GetOriginWorld())");
const normal = () => pyJSON("list(slicerXR._clipNodes()[1].GetNormalWorld())");
const viewDirection = () => page.evaluate(() => window.slicerXR.session.viewDirection());
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
/** The controller moved 10 cm to the right while the trigger or the grip is held. */
const holdAndMove = async (start, end) => {
  await page.evaluate((e) => window.__xrMock.session.dispatch(e, { inputSource: window.__xrMock.controller }), start);
  await frames(1);
  await page.evaluate(() => (window.__xrMock.controllerPosition = [window.__xrMock.controllerPosition[0] + 0.1, 1.1, -0.45]));
  await frames(2);
  await page.evaluate((e) => window.__xrMock.session.dispatch(e, { inputSource: window.__xrMock.controller }), end);
  await frames(1);
};
// The grip: the scene, not the plane
let origin0 = await plane();
before = await worldFromRoom();
await holdAndMove("squeezestart", "squeezeend");
check(JSON.stringify(await worldFromRoom()) !== JSON.stringify(before), "in Clipping, the left grip moves the scene");
check(JSON.stringify(await plane()) === JSON.stringify(origin0), "and not the plane");
// The trigger: the plane, not the scene (the controller pointing past the panel)
await page.evaluate(() => (window.__xrMock.controllerPosition = [-0.3, 1.1, -0.45]));
await frames(1);
origin0 = await plane();
before = await worldFromRoom();
await holdAndMove("selectstart", "selectend");
const origin1 = await plane();
const expected = before.slice(0, 3).map((v) => v * 0.1); // 10 cm along the room's x, in the scene
const moved = origin1.map((v, i) => v - origin0[i]);
check(moved.every((v, i) => Math.abs(v - expected[i]) < 0.5), `the left trigger holds the plane: it moved with the hand (${moved.map((v) => v.toFixed(1))} mm)`);
check(JSON.stringify(await worldFromRoom()) === JSON.stringify(before), "and the scene stayed where it was");
// Y: the plane square to the line of sight
await page.evaluate(() => {
  const s = window.slicerXR.session, a = 0.6;
  const turn = new Float64Array([Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]);
  s.worldFromRoom = window.slicerXR.internals.M.multiply(s.worldFromRoom, turn);
});
await frames(1);
check(dot(await normal(), await viewDirection()) < 0.99, "the scene turned, the plane is no longer square to the line of sight");
await button(5);
check(dot(await normal(), await viewDirection()) > 0.999 && (await panel()).visible, "Y turns it square to the line of sight (and leaves the panel shown)");
await button(4);
check(!(await panel()).clip.enabled, "X again turns clipping off");
before = await worldFromRoom();
await holdAndMove("selectstart", "selectend");
check(JSON.stringify(await worldFromRoom()) !== JSON.stringify(before), "with clipping off, the trigger holds the scene again");

// View: as the right one
await category("view");
await button(5);
check(!(await panel()).visible, "in View, Y hides the panel");
await button(5);
check((await panel()).visible, "and shows it");

// A button with no standard name: the panel
await category("markups");
await button(7);
check(!(await panel()).visible, "a button with no standard name (Menu) hides the panel, in any category");
await button(7);
check((await panel()).visible, "and shows it");
await browser.close();
process.exit(failed ? 1 : 0);

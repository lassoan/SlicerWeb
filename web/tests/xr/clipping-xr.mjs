// The panel's Clipping category, against the stand-in for WebXR (xr-mock.js, with layers): turned
// on, a clip node and its plane - singletons, tagged "WebXR", not listed in the data tree - clip the
// item chosen in the Data category, the plane across the view through its middle, and the half on
// the viewer's side is left out; the slider shifts the plane along its normal, Follow view keeps it
// across the view as the scene turns, Handles shows the plane's handles (moving it along its normal,
// turning it about its two other axes), Show plane hides and shows it; the Data category gets a
// column to clip an item or not; the Markups category's buttons leave the plane alone. A picture of
// the category is saved (tests/panel-category-clipping.png).
//
// Usage: node tests/xr/clipping-xr.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import fs from "node:fs";
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
// (what evalPython gives is the result's repr: a JSON string in single quotes)
const pyJSON = (e) => python(`__import__('json').dumps(${e})`).then((r) => JSON.parse(r.slice(1, -1)));
let time = 0;
const frames = (count) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start: (time += count * 14) });
/** Aims the controller at a button of the panel (at a fraction of its width) and pulls the trigger. */
const press = async (id, fraction = 0.5) => {
  const found = await page.evaluate(([id, fraction]) => {
    const { M } = window.slicerXR.internals;
    const panel = window.slicerXR.session.panel;
    const button = panel.buttons.find((b) => b.id === id);
    if (!button) return false;
    const x = ((button.x + button.width * fraction) / panel.layoutWidth - 0.5) * panel.widthM;
    const y = (0.5 - (button.y + button.height / 2) / panel.height) * panel.heightM;
    const target = M.point(panel.roomFromPanel, [x, y, 0]);
    const origin = [0.1, 1.0, -0.25];
    const z = [0, 1, 2].map((i) => origin[i] - target[i]);
    const zz = z.map((v) => v / Math.hypot(...z));
    let xx = [zz[2], 0, -zz[0]];
    xx = xx.map((v) => v / Math.hypot(...xx));
    const yy = [zz[1] * xx[2] - zz[2] * xx[1], zz[2] * xx[0] - zz[0] * xx[2], zz[0] * xx[1] - zz[1] * xx[0]];
    window.__xrMock.rayMatrix = new Float32Array([...xx, 0, ...yy, 0, ...zz, 0, ...origin, 1]);
    return true;
  }, [id, fraction]);
  if (!found) return false;
  await frames(1);
  const hovered = await page.evaluate(() => window.slicerXR.session.panel.hover);
  await page.evaluate(() => {
    window.__xrMock.session.dispatch("selectstart", { inputSource: window.__xrMock.controller });
    window.__xrMock.session.dispatch("selectend", { inputSource: window.__xrMock.controller });
    window.__xrMock.rayMatrix = null;
  });
  await frames(2);
  return hovered === id;
};
const panel = () => page.evaluate(() => {
  const p = window.slicerXR.session.panel;
  return { category: p.category, ids: p.buttons.map((b) => b.id), disabled: p.buttons.filter((b) => b.disabled).map((b) => b.id), items: p.dataItems, status: p.status, clip: p.clip, selected: p.selectedItem, follow: p.clipFollow };
});
const viewDirection = () => page.evaluate(() => window.slicerXR.session.viewDirection());
const plane = () => pyJSON("(lambda p: {'origin': list(p.GetOriginWorld()), 'normal': list(p.GetNormalWorld())})(slicerXR._clipNodes()[1])");
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const savePanel = async (name) => {
  await frames(2);
  const data = await page.evaluate(() => {
    const q = window.__xrMock.quadPixels();
    const canvas = document.createElement("canvas");
    canvas.width = q.w;
    canvas.height = q.h;
    const image = canvas.getContext("2d").createImageData(q.w, q.h);
    for (let y = 0; y < q.h; y++) image.data.set(q.pixels.subarray((q.h - 1 - y) * q.w * 4, (q.h - y) * q.w * 4), y * q.w * 4);
    canvas.getContext("2d").putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  });
  fs.writeFileSync(`tests/panel-category-${name}.png`, Buffer.from(data.split(",")[1], "base64"));
};

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
for (let i = 0; i < 300 && Number(await python("len(slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode'))")) === 0; i++) await page.waitForTimeout(1000);
// The scene: MRHead, a ball and a markup
await python([
  "import slicer, vtk",
  "sphere = vtk.vtkSphereSource()",
  "sphere.SetRadius(30)",
  "sphere.SetThetaResolution(40)",
  "sphere.SetPhiResolution(40)",
  "sphere.Update()",
  "MODEL = slicer.modules.models.logic().AddModel(sphere.GetOutput())",
  "MODEL.SetName('Ball')",
  "POINTS = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLMarkupsFiducialNode', 'Points')",
  "POINTS.AddControlPoint([0, 0, 0])",
].join("\n"), "exec");
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(4);

// The category, before clipping is on
check(await press("category:clipping"), "the Clipping category's button is there, and pressed");
let p = await panel();
check(["clip-enable", "clip-follow", "clip-plane", "clip-handles", "clip-offset"].every((id) => p.ids.includes(id)), "it shows Clipping, Follow view, Show plane, Handles and the plane's slider");
check(["clip-follow", "clip-plane", "clip-handles", "clip-offset"].every((id) => p.disabled.includes(id)) && !p.clip.enabled, "with clipping off, the rest is disabled");
check(await python("slicer.mrmlScene.GetSingletonNode('WebXR', 'vtkMRMLClipNode') is None"), "no clip node yet");

// The ball chosen in the Data category
await press("category:data");
p = await panel();
const ball = p.items.find((i) => i.name === "Ball");
check(ball && !p.ids.some((id) => id.startsWith("clip:")), "no clipping column while clipping is off");
check(await press(`row:${ball.id}`) && (await panel()).selected === ball.id, "pressing the ball's row chooses it");
await savePanel("data-selected");

// Clipping on: the ball is clipped
await press("category:clipping");
check(await press("clip-enable"), "Clipping is pressed");
p = await panel();
check(p.clip.enabled && !p.disabled.includes("clip-follow") && !p.disabled.includes("clip-offset"), `clipping is on, the rest enabled (${p.status})`);
const singletons = await pyJSON(`(lambda c, pl: [c is not None and c.GetSingletonTag(), pl is not None and pl.GetSingletonTag(), c.GetClippingNodeState(pl.GetID()), c.GetNumberOfClippingNodes()])(slicer.mrmlScene.GetSingletonNode('WebXR', 'vtkMRMLClipNode'), slicer.mrmlScene.GetSingletonNode('WebXR', 'vtkMRMLMarkupsPlaneNode'))`);
check(singletons[0] === "WebXR" && singletons[1] === "WebXR" && singletons[2] !== 0 && singletons[3] === 1, `the clip node and its plane are singletons tagged WebXR, the plane clipping (${JSON.stringify(singletons)})`);
check(await python("MODEL.GetDisplayNode().GetClipping() == 1 and MODEL.GetDisplayNode().GetClipNode() is not None and MODEL.GetDisplayNode().GetClipNode().GetSingletonTag() == 'WebXR'"), "the ball, chosen, is clipped by it");
check(await python("POINTS.GetDisplayNode().GetClipping() == 0"), "the markup, not chosen, is not");
let view = await viewDirection(), pl = await plane();
check(dot(view, pl.normal) > 0.999, `the plane is across the view, its normal where the viewer looks (${pl.normal.map((v) => v.toFixed(2))})`);
check(Math.hypot(...pl.origin) < 1, "through the middle of the ball");
// What is left of the ball: the far half (the mapper's input is clipped, or its clipping planes clip)
await frames(3);
const kept = await pyJSON(`(lambda v: (lambda a: (lambda pts, n: [min(sum(pts.GetPoint(i)[k] * n[k] for k in range(3)) for i in range(pts.GetNumberOfPoints())), max(sum(pts.GetPoint(i)[k] * n[k] for k in range(3)) for i in range(pts.GetNumberOfPoints()))])(a.GetMapper().GetInput().GetPoints(), list(slicerXR._clipNodes()[1].GetNormalWorld())))(v.displayableManagerByClassName('vtkMRMLModelDisplayableManager').GetActorByID(MODEL.GetDisplayNode().GetID())))(slicer.app.layoutManager().threeDWidget(0).threeDView())`);
check(kept[0] > -1 && kept[1] > 29, `the half on the viewer's side is left out (what is drawn is ${kept[0].toFixed(1)} to ${kept[1].toFixed(1)} mm along the normal)`);
p = await panel();
check(!p.items.some((i) => /WebXR/.test(i.name)), "the clip node and the plane are not listed in the data tree");

// The slider: the plane along its normal
const range = p.clip.range;
check(await press("clip-offset", 0.75), "the plane's slider is pressed three quarters along");
p = await panel();
pl = await plane();
check(Math.abs(p.clip.offset - range / 2) < range * 0.05 && Math.abs(dot(pl.origin, pl.normal) - p.clip.offset) < 0.5, `it shifts the plane along its normal (${p.clip.offset.toFixed(1)} mm of ±${range.toFixed(1)})`);
await press("clip-offset", 0.5);
check(Math.abs((await panel()).clip.offset) < range * 0.05, "back in the middle");

// Follow view: as the scene turns, the plane keeps across the view
check(await press("clip-follow") && (await panel()).follow, "Follow view is on");
await page.evaluate(() => {
  const s = window.slicerXR.session, a = 0.5;
  const turn = new Float64Array([Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]);
  s.worldFromRoom = window.slicerXR.internals.M.multiply(s.worldFromRoom, turn);
});
await frames(3);
view = await viewDirection();
pl = await plane();
check(dot(view, pl.normal) > 0.999, "the scene turned, the plane turned with the view");

// Handles: along the normal, and two turns
check(await press("clip-handles"), "Handles is pressed");
p = await panel();
const handles = await pyJSON("(lambda d: [d.GetHandlesInteractive(), list(d.GetTranslationHandleComponentVisibility()), list(d.GetRotationHandleComponentVisibility()), d.GetScaleHandleVisibility()])(slicerXR._clipNodes()[1].GetDisplayNode())");
check(handles[0] && JSON.stringify(handles[1]) === "[false,false,true,false]" && JSON.stringify(handles[2]) === "[true,true,false,false]" && !handles[3],
  `the handles move the plane along its normal and turn it about its two other axes (${JSON.stringify(handles)})`);
check(p.clip.handlesShown && !p.follow, "the panel says so, and the plane no longer follows the view");
await savePanel("clipping");

// Show plane
check(await press("clip-plane") && !(await panel()).clip.planeShown && (await python("slicerXR._clipNodes()[1].GetDisplayNode().GetVisibility()")) === "0", "Show plane hides the plane");
await press("clip-plane");
check((await panel()).clip.planeShown, "and shows it again");

// The Markups category's buttons leave the plane alone
await python("slicerXR.deleteMarkups()");
check(await python("slicerXR._clipNodes()[1] is not None and len(slicer.util.getNodesByClass('vtkMRMLMarkupsFiducialNode')) == 0"), "Delete markups deletes the markups, not the clipping plane");

// The Data category's clipping column
await press("category:data");
p = await panel();
check(p.ids.includes(`clip:${ball.id}`), "the data tree has a clipping column");
await press(`clip:${ball.id}`);
check(await python("MODEL.GetDisplayNode().GetClipping() == 0") && !(await panel()).items.find((i) => i.id === ball.id).clipped, "its icon stops clipping the ball");
await press(`clip:${ball.id}`);
check(await python("MODEL.GetDisplayNode().GetClipping() == 1"), "and clips it again");
// A volume: its volume rendering is clipped
const volume = (await panel()).items.find((i) => i.kind === "Volume");
await press(`eye:${volume.id}`);
const vrShown = () => python("any(d.GetVisibility() for d in slicerXR._volumeRenderingDisplays(slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode')[0]))");
for (let i = 0; i < 50 && (await vrShown()) !== "True"; i++) {
  await frames(1);
  await page.waitForTimeout(50);
}
await frames(2);
check((await panel()).ids.includes(`clip:${volume.id}`), "a volume rendered volume has a clipping icon");
await press(`clip:${volume.id}`);
check(await python("all(d.GetClipping() == 1 and d.GetClipNode().GetSingletonTag() == 'WebXR' for d in slicerXR._volumeRenderingDisplays(slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode')[0]))"), "which clips its volume rendering");
await savePanel("data-clipping");

// Clipping off
await press("category:clipping");
await press("clip-enable");
p = await panel();
check(!p.clip.enabled && (await python("(lambda c, pl: c.GetClippingNodeState(pl.GetID()))(*slicerXR._clipNodes())")) === "0", "Clipping pressed again turns it off");
await press("category:data");
check(!(await panel()).ids.some((id) => id.startsWith("clip:")), "and the clipping column is gone");
await press("exit");
await browser.close();
process.exit(failed ? 1 : 0);

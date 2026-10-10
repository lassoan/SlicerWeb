// The panel's categories (Data, Markups, View) and its Data category, the data tree, against the
// stand-in for WebXR (xr-mock.js, with layers): Exit and close are there in every category; the
// panel keeps its height as the category changes; the data tree lists the subject hierarchy - names
// indented by depth - and its icons show and hide an item (a folder: what is in it; a volume: its
// volume rendering) and make it half transparent and opaque again. A picture of each category is
// saved (tests/panel-category-*.png).
//
// Usage: node tests/xr/panel-categories.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
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
let time = 0;
const frames = (count) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start: (time += count * 14) });
/** Aims the controller at a button of the panel and pulls the trigger. */
const press = async (id) => {
  const found = await page.evaluate((id) => {
    const { M } = window.slicerXR.internals;
    const panel = window.slicerXR.session.panel;
    const button = panel.buttons.find((b) => b.id === id);
    if (!button) return false;
    const x = ((button.x + button.width / 2) / panel.layoutWidth - 0.5) * panel.widthM;
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
  }, id);
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
  return { category: p.category, height: p.height, ids: p.buttons.map((b) => b.id), items: p.dataItems, status: p.status };
});
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
// The scene: MRHead, a folder with a model in it, and a markup
await python([
  "import slicer, vtk",
  "sh = slicer.mrmlScene.GetSubjectHierarchyNode()",
  "folder = sh.CreateFolderItem(sh.GetSceneItemID(), 'Anatomy')",
  "sphere = vtk.vtkSphereSource()",
  "sphere.SetRadius(30)",
  "sphere.Update()",
  "MODEL = slicer.modules.models.logic().AddModel(sphere.GetOutput())",
  "MODEL.SetName('Ball')",
  "sh.SetItemParent(sh.GetItemByDataNode(MODEL), folder)",
  "POINTS = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLMarkupsFiducialNode', 'Points')",
  "POINTS.AddControlPoint([0, 0, 0])",
  "VOLUME = slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode')[0]",
].join("\n"), "exec");
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(4);

// The categories, and what is in every one of them
const heights = [];
for (const category of ["markups", "view", "data"]) {
  check(await press(`category:${category}`), `the ${category} category's button is there, and pressed`);
  const p = await panel();
  heights.push(p.height);
  check(p.category === category && p.ids.includes("exit") && p.ids.includes("hide") && ["data", "markups", "view"].every((c) => p.ids.includes(`category:${c}`)),
    `${category}: Exit, close and the three categories are shown`);
  await savePanel(category);
}
check(new Set(heights).size === 1, `the panel keeps its height as the category changes (${heights[0]} pixels)`);
let p = await panel();
check(p.ids.includes("tool:vtkMRMLMarkupsLineNode") === false && p.ids.some((id) => id.startsWith("eye:")), "the data category shows the data tree, not the markups' buttons");

// The data tree: the subject hierarchy, depth first
const names = p.items.map((i) => `${"  ".repeat(i.depth)}${i.name} (${i.kind})`);
console.log(`  data tree:\n    ${names.join("\n    ")}`);
const ball = p.items.find((i) => i.name === "Ball"), anatomy = p.items.find((i) => i.name === "Anatomy");
const volume = p.items.find((i) => i.kind === "Volume"), points = p.items.find((i) => i.name === "Points");
check(anatomy && ball && ball.depth === anatomy.depth + 1 && p.items.indexOf(ball) === p.items.indexOf(anatomy) + 1, "the model is listed under its folder, one level deeper");
check(volume && points && ball.visible && points.visible, "the volume and the markup are listed; the model and the markup are shown");
check(p.ids.includes(`opacity:${ball.id}`) && !p.ids.includes(`opacity:${anatomy.id}`), "a model has a transparency icon, a folder not");

// The eye of the model: hidden, shown
check(await press(`eye:${ball.id}`), "the model's eye icon is pressed");
check(await python("MODEL.GetDisplayNode().GetVisibility()") === "0" && !(await panel()).items.find((i) => i.name === "Ball").visible, "it hides the model, and the tree says so");
await savePanel("data-hidden");
await press(`eye:${ball.id}`);
check(await python("MODEL.GetDisplayNode().GetVisibility()") === "1", "pressed again, it shows it");

// The eye of the folder: what is in it
await press(`eye:${anatomy.id}`);
check(await python("MODEL.GetDisplayNode().GetVisibility()") === "0", "the folder's eye hides what is in it");
await press(`eye:${anatomy.id}`);
check(await python("MODEL.GetDisplayNode().GetVisibility()") === "1", "and shows it again");

// Transparency: 50%, and opaque again
await press(`opacity:${ball.id}`);
check(await python("MODEL.GetDisplayNode().GetOpacity()") === "0.5" && (await panel()).items.find((i) => i.name === "Ball").transparent, "the transparency icon makes the model half transparent");
await press(`opacity:${ball.id}`);
check(await python("MODEL.GetDisplayNode().GetOpacity()") === "1.0", "and opaque again");

// The volume: its eye is its volume rendering, its transparency the opacity of the volume rendering
const vr = () => python("any(d.GetVisibility() for d in slicerXR._volumeRenderingDisplays(VOLUME))");
// (not volume rendered on entering: the scene shows a model and a markup)
check(await vr() === "False" && !(await panel()).items.find((i) => i.kind === "Volume").visible, "the volume is not volume rendered yet, and the tree says so");
check(!(await panel()).ids.includes(`opacity:${volume.id}`), "without a volume rendering it has no transparency icon");
await press(`eye:${volume.id}`);
for (let i = 0; i < 50 && (await vr()) !== "True"; i++) {
  await frames(1);
  await page.waitForTimeout(50);
}
check(await vr() === "True" && (await panel()).items.find((i) => i.kind === "Volume").visible, "its eye shows it volume rendered, and the tree says so");
const opacityAt = () => python("(lambda f: [f.GetValue(x) for x in (40, 80, 120)])(slicerXR._volumeRenderingDisplays(VOLUME)[0].GetVolumePropertyNode().GetVolumeProperty().GetScalarOpacity())").then(JSON.parse);
const opaque = await opacityAt();
await press(`opacity:${volume.id}`);
const half = await opacityAt();
check(half.every((v, i) => Math.abs(v - opaque[i] * 0.5) < 1e-6) && opaque.some((v) => v > 0), `the volume's transparency icon halves its volume rendering's opacity (${opaque.map((v) => v.toFixed(2))} -> ${half.map((v) => v.toFixed(2))})`);
await press(`opacity:${volume.id}`);
const back = await opacityAt();
check(back.every((v, i) => Math.abs(v - opaque[i]) < 1e-6), "and puts it back");
await press(`eye:${volume.id}`);
check(await vr() === "False", "the volume's eye hides its volume rendering");
await press(`eye:${volume.id}`);
for (let i = 0; i < 50 && (await vr()) !== "True"; i++) {
  await frames(1);
  await page.waitForTimeout(50);
}
check(await vr() === "True", "and shows it again");
await savePanel("data");

// Close, and Exit
check(await press("hide") && !(await page.evaluate(() => window.slicerXR.session.panel.visible)), "the close icon closes the panel");
await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[5].pressed = true));
await frames(1);
await page.evaluate(() => (window.__xrMock.controller.gamepad.buttons[5].pressed = false));
await frames(2);
check(await page.evaluate(() => window.slicerXR.session.panel.visible), "B shows it again");
check(await press("exit") && (await page.evaluate(() => window.__xrMock.ended)), "Exit ends the session");
await browser.close();
process.exit(failed ? 1 : 0);

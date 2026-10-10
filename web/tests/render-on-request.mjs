// The end of a pause of rendering renders only the views that something asked to render meanwhile,
// as Slicer's views do (ctkVTKAbstractView). Slicer pauses and resumes rendering around much of what
// it does - twice for every move of the pointer over a slice view, and over a markup in a 3D view -
// and a view that rendered for every pause redrew the whole layout as the pointer moved.
// Checked: moves of the pointer over a slice view render no other view; a markup is still
// highlighted under the pointer (and its view rendered for it); a pause holds a render back and its
// end lets it go, renders nothing when nothing was asked, and shows what was added within it.
//
// Usage: node tests/render-on-request.mjs [url]
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=MRHead";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
const py = (e, mode = "eval") => page.evaluate(([e, mode]) => window.slicerWeb.bridge.evalPython(e, mode), [e, mode]);
for (let i = 0; i < 300 && Number(await py("len(slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode'))")) === 0; i++) await page.waitForTimeout(1000);
await page.waitForTimeout(3000);
const counts = () => py("{name: v.GetRenderCount() for name, v in slicer.app.layoutManager().views().items()}").then((s) => JSON.parse(s.replace(/'/g, '"')));
const rect = (name) => page.evaluate((name) => {
  const r = document.querySelector(`#slicer-view-${name}`).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, name);
/** The renders of each view while these happen. */
const rendersWhile = async (what) => {
  await page.waitForTimeout(800);
  const before = await counts();
  await what();
  await page.waitForTimeout(800);
  const after = await counts();
  return Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
};

// The pointer over a slice view
const red = await rect("Red");
await page.mouse.move(red.x + red.w * 0.3, red.y + red.h * 0.4);
let renders = await rendersWhile(async () => {
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(red.x + red.w * (0.3 + 0.01 * i), red.y + red.h * 0.4);
    await page.waitForTimeout(20);
  }
});
check(renders.Green === 0 && renders.Yellow === 0 && renders["1"] === 0, `30 moves of the pointer over a slice view render no other view (${JSON.stringify(renders)})`);

// A markup in the middle of the 3D view: highlighted under the pointer
await py([
  "import slicer, vtk",
  "n = slicer.mrmlScene.AddNewNodeByClass('vtkMRMLMarkupsFiducialNode', 'F')",
  "bb = [0.0] * 6",
  "slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode')[0].GetRASBounds(bb)",
  "center = [(bb[0] + bb[1]) / 2, (bb[2] + bb[3]) / 2, (bb[4] + bb[5]) / 2]",
  "n.AddControlPoint(center)",
  "v = slicer.app.layoutManager().views()['1']",
  "v.Render()",
  "c = vtk.vtkCoordinate()",
  "c.SetCoordinateSystemToWorld()",
  "c.SetValue(*center)",
  "DISP = list(c.GetComputedDisplayValue(v.GetRenderer())) + list(v.GetRenderWindow().GetSize())",
].join("\n"), "exec");
const disp = JSON.parse(await py("DISP"));
const view = await rect("1");
const mx = view.x + (disp[0] / disp[2]) * view.w, my = view.y + (1 - disp[1] / disp[3]) * view.h;
await page.mouse.move(view.x + 20, view.y + view.h - 20);
renders = await rendersWhile(async () => {
  await page.mouse.move(mx, my, { steps: 5 });
});
check((await py("n.GetDisplayNode().GetActiveComponentType()")) === "1" && renders["1"] >= 1,
  `the pointer moved onto a markup highlights it, and the 3D view is rendered for it (${JSON.stringify(renders)})`);
renders = await rendersWhile(async () => {
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(mx + (i % 2), my);
    await page.waitForTimeout(20);
  }
});
check(Object.values(renders).every((n) => n === 0), `30 moves of the pointer on the highlighted markup render nothing (${JSON.stringify(renders)})`);
await page.mouse.move(view.x + 20, view.y + view.h - 20, { steps: 5 });
await page.waitForTimeout(500);
check((await py("n.GetDisplayNode().GetActiveComponentType()")) === "0", "moved off it, the highlight goes");

// A pause holds a render back, and its end lets it go - that one only
await page.waitForTimeout(800);
let before = await counts();
await py("slicer.app.pauseRender()\nslicer.app.layoutManager().views()['Green'].ScheduleRender()", "exec");
await page.waitForTimeout(600);
const during = await counts();
check(during.Green === before.Green, "while rendering is paused, a view asked to render does not");
await py("slicer.app.resumeRender()", "exec");
await page.waitForTimeout(600);
let after = await counts();
check(after.Green > before.Green, "when the pause ends, it does");
check(after.Red === before.Red && after.Yellow === before.Yellow && after["1"] === before["1"], "and the views nothing asked to render are not rendered, however long the pause");
// A pause with nothing asked: nothing rendered
before = await counts();
await py("slicer.app.pauseRender()\nslicer.app.resumeRender()", "exec");
await page.waitForTimeout(600);
after = await counts();
check(JSON.stringify(after) === JSON.stringify(before), "a pause in which nothing was asked for renders nothing");
// Nested pauses: rendered when the outer one ends
before = await counts();
await py("slicer.app.pauseRender()\nslicer.app.pauseRender()\nslicer.app.layoutManager().views()['Yellow'].ScheduleRender()\nslicer.app.resumeRender()", "exec");
await page.waitForTimeout(600);
check((await counts()).Yellow === before.Yellow, "within nested pauses, the end of the inner one renders nothing");
await py("slicer.app.resumeRender()", "exec");
await page.waitForTimeout(600);
check((await counts()).Yellow > before.Yellow, "the end of the outer one renders what was asked");
// What is added or changed within a pause is shown when it ends
before = await counts();
await py([
  "s = vtk.vtkSphereSource()",
  "s.SetRadius(30)",
  "s.Update()",
  "slicer.app.pauseRender()",
  "MODEL = slicer.modules.models.logic().AddModel(s.GetOutput())",
  "slicer.app.resumeRender()",
].join("\n"), "exec");
await page.waitForTimeout(800);
after = await counts();
check(after["1"] > before["1"], "a model added within a pause is rendered in the 3D view when the pause ends");
before = await counts();
await py("slicer.app.pauseRender()\nMODEL.GetDisplayNode().SetColor(1, 0, 0)\nslicer.app.resumeRender()", "exec");
await page.waitForTimeout(800);
after = await counts();
check(after["1"] > before["1"], "a model's color changed within a pause is rendered when it ends");
// A scene batch (a scene loaded) still renders everything at its end
before = await counts();
await py("slicer.mrmlScene.StartState(slicer.mrmlScene.BatchProcessState)\nslicer.mrmlScene.EndState(slicer.mrmlScene.BatchProcessState)", "exec");
await page.waitForTimeout(800);
after = await counts();
check(Object.keys(after).every((k) => after[k] > before[k]), `the end of a scene batch renders every view, as before (${JSON.stringify(Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]])))})`);
await browser.close();
process.exit(failed ? 1 : 0);

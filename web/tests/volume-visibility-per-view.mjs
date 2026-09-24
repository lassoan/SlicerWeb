// The eye of a volume in the Data tree shows and sets whether the volume is shown in the selected
// view: the background of a slice view (and of the slice views linked to it), volume rendering in
// a 3D view.
// Usage: node tests/volume-visibility-per-view.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);

await page.goto(base + "?sample=MRHead&layout=FourUp");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const select = async (view) => { await page.evaluate((v) => { window.slicerWeb.store.activeView = v; }, view); await page.waitForTimeout(700); };
const eye = () => page.evaluate(() => window.slicerWeb.store.subjectHierarchy.find((i) => i.name === "MR-head")?.visible);
const clickEye = async () => {
  await page.locator("button[title$='in view " + await page.evaluate(() => window.slicerWeb.store.activeView) + "']").first().click();
  await page.waitForTimeout(900);
};
const backgrounds = () => py(`",".join(str(slicer.app.layoutManager().sliceWidget(n).sliceLogic().GetSliceCompositeNode().GetBackgroundVolumeID() is not None) for n in ("Red", "Yellow", "Green"))`);
const rendered = () => py(`(lambda d: "none" if d is None else f"{bool(d.GetVisibility())}:{list(d.GetViewNodeIDs())}")(slicer.modules.volumerendering.logic().GetFirstVolumeRenderingDisplayNode(slicer.util.getNode("MR-head")))`);

// ---- slice views
await select("Red");
check("Red selected: the eye shows the volume in the Red view", await eye(), true);
check("with the title saying which view", await page.locator("button[title='Hide in view Red']").count(), 1);
await clickEye();
check("hidden in Red: no longer its background", await backgrounds(), "False,True,True");
check("and the eye closed", await eye(), false);
await select("Yellow");
check("Yellow selected: the eye shows it is there", await eye(), true);
await select("Red");
check("Red again: not there", await eye(), false);
await clickEye();
check("shown in Red again", await backgrounds(), "True,True,True");

// linked slice views follow, as they follow the slice controller
await exec(`
for n in ("Red", "Yellow", "Green"):
    slicer.app.layoutManager().sliceWidget(n).sliceLogic().GetSliceCompositeNode().SetLinkedControl(True)
`);
await select("Yellow");
await clickEye();
check("hidden in Yellow with the views linked: gone from all of them", await backgrounds(), "False,False,False");
await clickEye();
check("and shown in all of them again", await backgrounds(), "True,True,True");
await exec(`
for n in ("Red", "Yellow", "Green"):
    slicer.app.layoutManager().sliceWidget(n).sliceLogic().GetSliceCompositeNode().SetLinkedControl(False)
`);

// changed elsewhere (a slice controller, Python): the eye follows
await select("Green");
await exec('slicer.app.layoutManager().sliceWidget("Green").sliceLogic().GetSliceCompositeNode().SetBackgroundVolumeID(None)');
await page.waitForTimeout(900);
check("taken out of Green from Python: the eye closes", await eye(), false);
await exec('slicer.app.layoutManager().sliceWidget("Green").sliceLogic().GetSliceCompositeNode().SetBackgroundVolumeID(slicer.util.getNode("MR-head").GetID())');
await page.waitForTimeout(900);
check("and opens when it is put back", await eye(), true);

// ---- the 3D view
await select("1");
check("3D view selected: not volume rendered yet", await eye(), false);
await clickEye();
check("shown in the 3D view: volume rendered", await rendered(), "True:[]");
check("and the eye open", await eye(), true);
await page.waitForTimeout(1500);
if (shot) await page.screenshot({ path: shot });
await clickEye();
check("hidden in the 3D view: the volume rendering hidden", (await rendered()).startsWith("False"), true);
check("and the eye closed", await eye(), false);
check("the slice views keep it", await backgrounds(), "True,True,True");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

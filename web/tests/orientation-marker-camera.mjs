// Changing the orientation marker of a 3D view leaves the view's camera where it is. The marker is
// drawn by a renderer of its own whose camera its displayable manager places around the marker; if
// that renderer looked through the view's camera, the view would jump to a few millimetres from
// the origin and show nothing (as it did when Valve Annulus Analysis set its heart marker).
// Usage: node tests/orientation-marker-camera.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
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
const camera = async () => JSON.parse(await py('__import__("json").dumps([round(v, 1) for v in slicer.util.getNodesByClass("vtkMRMLCameraNode")[0].GetPosition()])'));

// a scene read in a batch: the layers are pointed at the camera the view ended up with then
await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(3000);

const before = await camera();
for (const [name, type] of [["human", "OrientationMarkerTypeHuman"], ["axes", "OrientationMarkerTypeAxes"], ["cube", "OrientationMarkerTypeCube"]]) {
  await exec(`slicer.mrmlScene.GetNodeByID("vtkMRMLViewNode1").SetOrientationMarkerType(slicer.vtkMRMLAbstractViewNode.${type})`);
  await page.waitForTimeout(800);
  const after = await camera();
  check(`the ${name} marker shown: the camera stays where it was`, JSON.stringify(after), JSON.stringify(before));
}
check("and the view still looks from a distance", Math.hypot(...before) > 100, true);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

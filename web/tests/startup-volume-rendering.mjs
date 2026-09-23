// ?sample=CTChest&volumeRendering=1 opens on the CT volume rendered: the link is enough, no
// module to open. A preset can be named; 0 leaves the rendering off.
// Usage: node tests/startup-volume-rendering.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const rendering = () => py('[(d.GetVisibility(), d.GetVolumePropertyNode().GetName()) for d in slicer.util.getNodesByClass("vtkMRMLVolumeRenderingDisplayNode")]');
const open = async (query) => {
  await page.goto(base + query);
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && /CT-chest/.test(document.body.innerText), null, { timeout: 300000 });
  await page.waitForTimeout(4000);
};

await open("?sample=CTChest&volumeRendering=1&layout=OneUp3D");
check("the CT is volume rendered, with the preset that suits a CT", await rendering(), "[(1, 'CT-Chest-Contrast-Enhanced')]");
if (shot) await page.screenshot({ path: shot });

await open("?sample=CTChest&volumeRendering=CT-Bone");
check("a named preset is used", await rendering(), "[(1, 'CT-Bone')]");

await open("?sample=CTChest&volumeRendering=0");
check("0 leaves the rendering off", await rendering(), "[]");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

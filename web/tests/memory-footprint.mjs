// What the tab holds after a start: the files of the loaded libraries are gone from the virtual
// file system (they were a third of the JS heap), and what remains is reported.
// Usage: node tests/memory-footprint.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--js-flags=--expose-gc"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const mb = (n) => (n / 1048576).toFixed(0);
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForTimeout(2000);
await page.evaluate(() => { for (let i = 0; i < 3; i++) globalThis.gc?.(); });
await page.waitForTimeout(1500);

const state = await page.evaluate(() => {
  const m = window.slicerWeb.pyodide._module;
  const loaded = Object.keys(m.LDSO.loadedLibsByName).filter((p) => p.startsWith("/") && p.endsWith(".so"));
  const present = loaded.filter((p) => { try { m.FS.stat(p); return true; } catch { return false; } });
  const ours = (p) => /\/(vtk_libs|slicer_home|itk|itk_libs)\//.test(p);
  return {
    loaded: loaded.length,
    presentKits: present.filter((p) => !/\.cpython-/.test(p) && ours(p)).length,
    otherPresent: present.filter((p) => !/\.cpython-/.test(p) && !ours(p)).map((p) => p.split("/").pop()),
    presentModules: present.filter((p) => /\.cpython-/.test(p)).length,
    js: performance.memory?.usedJSHeapSize ?? 0,
    wasm: m.HEAPU8.length,
  };
});
console.log(`${state.loaded} libraries loaded; JS heap ${mb(state.js)} MB, wasm heap ${mb(state.wasm)} MB`);
check("no loaded library of VTK, ITK or Slicer still has its file in the file system", state.presentKits, 0);
if (state.otherPresent.length) console.log(`(files kept by libraries of other packages: ${state.otherPresent.join(", ")})`);
console.log(`(${state.presentModules} Python extension modules keep their files: nothing has imported them yet)`);
check("the JS heap is well under what it was with the files kept (365 MB)", state.js < 250 * 1048576, true);

// and everything still works: a volume loads and is shown
const path = await page.evaluate(() => window.slicerWeb.downloadFile("sample-data/MR-head.nrrd", "MR-head.nrrd"));
const ids = await page.evaluate((p) => window.slicerWeb.bridge.call("loadFiles", [[p]]), path);
await page.waitForTimeout(2000);
check("a volume still loads without them", ids.length > 0, true);
check("and is shown", await page.evaluate(() => window.slicerWeb.bridge.evalPython(
  'slicer.app.layoutManager().sliceWidget("Red").sliceLogic().GetBackgroundLayer().GetVolumeNode() is not None', "eval")), "True");

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

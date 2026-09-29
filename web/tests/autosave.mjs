// Auto-save (Application settings > General, on by default): what changed in the scene is saved
// after 5 seconds without input, with a dot in the lower left corner - unsaved changes, saving, all
// saved - so that a reload brings back the latest state. Input meanwhile puts it off, and so does a
// sequence being played; off in the settings, nothing is saved while the page is in use.
// Usage: node tests/autosave.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let restore = false;
page.on("dialog", (d) => (restore ? d.accept() : d.dismiss()));
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^['"]|['"]$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
// every state the dot goes through, however briefly
const watchDot = () => page.evaluate(() => {
  window.__dot = [];
  const note = () => {
    const dot = document.querySelector("[data-name=autosave-indicator]");
    const state = dot ? dot.dataset.state : "none";
    if (window.__dot[window.__dot.length - 1] !== state) window.__dot.push(state);
  };
  note();
  new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
});
const dot = () => page.evaluate(() => window.__dot);
const ready = () => page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });

await page.goto(base + "?sample=CTChest");
await ready();
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText), null, { timeout: 300000 });
check("auto-save is on by default", await page.evaluate(() => window.slicerWeb.store.settings["General/AutoSave"]), true);
await watchDot();
await exec(`line = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode", "Measurement"); line.AddControlPoint(0, 0, 0); line.AddControlPoint(10, 0, 0)`);
await page.waitForTimeout(9000);
check("a change shows as unsaved, and after 5 s without input it is saved", await dot(), ["none", "unsaved", "saving", "saved"]);
check("the dot is in the lower left corner", await page.locator("[data-name=autosave-indicator]").boundingBox()
  .then((b) => b && b.x < 20 && b.y > 850), true);

// input puts it off
await watchDot();
await exec(`line.SetNthControlPointPosition(1, 20, 0, 0)`);
for (let i = 0; i < 8; i++) {
  await page.mouse.move(700 + (i % 2) * 10, 450);
  await page.waitForTimeout(1000);
}
check("while the mouse moves, it stays unsaved", await dot(), ["saved", "unsaved"]);
await page.waitForTimeout(8000);
check("5 s after it stops, it is saved", await dot(), ["saved", "unsaved", "saving", "saved"]);

// a sequence being played changes its nodes at every frame: not saved until it stops
await exec(`
sequence = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSequenceNode", "Positions")
for i in range(5):
    p = slicer.vtkMRMLMarkupsFiducialNode()
    p.AddControlPoint(i * 10, 0, 0)
    sequence.SetDataNodeAtValue(p, str(i))
browser = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSequenceBrowserNode", "Replay")
browser.SetAndObserveMasterSequenceNodeID(sequence.GetID())
browser.SetPlaybackLooped(True)
browser.SetPlaybackRateFps(5)
browser.SetPlaybackActive(True)
`);
await watchDot();
await page.waitForTimeout(10000);
check("while the sequence plays, nothing is saved", await dot(), (d) => !d.includes("saving") && d.includes("unsaved"));
await exec(`browser.SetPlaybackActive(False)`);
await page.waitForTimeout(8000);
check("once it stops, it is saved", await dot(), (d) => d.includes("saving") && d[d.length - 1] === "saved");

// a reload right away brings it back, as saved
restore = true;
await page.reload();
await ready();
await page.waitForTimeout(5000);
check("a reload brings back the latest state", await py(`slicer.util.getNode("Measurement").GetNthControlPointPosition(1)[0] if slicer.mrmlScene.GetFirstNodeByName("Measurement") else None`), "20.0");

// off in the settings: nothing is saved while the page is in use
await page.evaluate(() => { window.slicerWeb.store.settings = { ...window.slicerWeb.store.settings, "General/AutoSave": false }; });
await watchDot();
await exec(`slicer.util.getNode("Measurement").SetNthControlPointPosition(1, 30, 0, 0)`);
await page.waitForTimeout(9000);
check("off: nothing is saved, and there is no dot", await dot(), ["none"]);
check("the change is still to be saved", await page.evaluate(() => window.slicerWeb.bridge.call("sessionNeedsSaving")), true);

check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

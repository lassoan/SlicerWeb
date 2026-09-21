// A sequence read from a file: the browser that plays it shows up in the Data panel, clicking it
// opens the Sequences module, and the module has the controls the desktop browser toolbar has.
// Usage: node tests/sequences-playback.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(1500);
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);

// a short sequence of volumes, written to a file and read back the way a downloaded sample is
await run(`
import slicer, vtk, numpy as np, os
sequence = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSequenceNode", "Beating")
sequence.SetIndexName("time")
sequence.SetIndexUnit("s")
for frame in range(5):
    volume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "frame")
    array = np.zeros((6, 8, 10), dtype=np.int16)
    array[:, :, frame:frame + 3] = 100 * (frame + 1)
    slicer.util.updateVolumeFromArray(volume, array)
    sequence.SetDataNodeAtValue(volume, "%.2f" % (frame * 0.1))
    slicer.mrmlScene.RemoveNode(volume)
path = os.path.join(slicer.app.temporaryPath, "beating.seq.nrrd")
slicer.util.saveNode(sequence, path)
slicer.mrmlScene.Clear(0)
_out = "wrote a sequence of %d frames to %s" % (5, path)
`);
console.log(await value("_out"));

await run(`
loaded = slicer.util.loadNodeFromFile(path, "SequenceFile")
browserNode = slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLSequenceBrowserNode")
sequenceNode = slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLSequenceNode")
`);
console.log(await value(`__import__("json").dumps(sorted(
    (n.GetClassName(), n.GetName()) for n in slicer.util.getNodes("*").values()
    if "Sequence" in n.GetClassName() or n.GetClassName() == "vtkMRMLScalarVolumeNode"))`));

await page.waitForTimeout(1500);
const items = await page.evaluate(() => (window.slicerWeb.store?.subjectHierarchy ?? []).map((i) => `${i.name} [${i.className}]`));
console.log("the Data panel shows:", JSON.stringify(items));

// clicking the browser in the Data panel opens the Sequences module
const browserItem = page.locator("aside", { hasText: "SUBJECT HIERARCHY" }).locator("text=beating browser").first();
await browserItem.click();
await page.waitForTimeout(1500);
console.log("module opened by clicking the browser:", await page.locator("[data-name='moduleTitle']").innerText());

const controls = page.locator("[data-name='playControls']");
const names = await controls.locator("button").evaluateAll((els) => els.map((e) => e.dataset.name));
console.log("controls:", JSON.stringify(names));

const positionText = () => page.locator("[data-name='position']").innerText();
const index = () => value("str(browserNode.GetSelectedItemNumber())");
console.log("at the start:", await positionText(), "| index value:", await page.locator("[data-name='indexValue']").innerText());

await controls.locator("[data-name='lastItem']").click();
await page.waitForTimeout(800);
console.log("after jumping to the end:", await positionText(), "item", await index());
await controls.locator("[data-name='previousItem']").click();
await page.waitForTimeout(800);
console.log("a frame back:", await positionText());
await controls.locator("[data-name='firstItem']").click();
await page.waitForTimeout(800);
console.log("after jumping to the start:", await positionText());

// playing advances the browser on its own, and pausing stops it
await run(`browserNode.SetPlaybackRateFps(10.0)`);
await controls.locator("[data-name='playButton']").click();
await page.waitForTimeout(2500);
const whilePlaying = await value("str(browserNode.GetPlaybackActive())");
await controls.locator("[data-name='playButton']").click();
await page.waitForTimeout(600);
const stopped = await index();
await page.waitForTimeout(1200);
console.log(`playing: ${whilePlaying}, and after pausing the item stays put: ${stopped === (await index())}`);

// repeat toggles
const looped = await value("str(browserNode.GetPlaybackLooped())");
await controls.locator("[data-name='loopButton']").click();
await page.waitForTimeout(600);
console.log(`repeat toggles: ${looped} -> ${await value("str(browserNode.GetPlaybackLooped())")}`);

// recording, as in desktop Slicer, is offered once a sequence is set to record into
console.log("record button before a sequence is set to record:",
  (await controls.locator("[data-name='recordButton']").isDisabled()) ? "disabled" : "enabled");
await page.locator("[data-name='recordingEnabled']").first().check();
await page.waitForTimeout(1200);
console.log("record button after:", (await controls.locator("[data-name='recordButton']").isDisabled()) ? "disabled" : "enabled");

const framesBefore = await value("str(sequenceNode.GetNumberOfDataNodes())");
await controls.locator("[data-name='snapshotButton']").click();
await page.waitForTimeout(1000);
console.log(`frames after one snapshot: ${framesBefore} -> ${await value("str(sequenceNode.GetNumberOfDataNodes())")}`);

await controls.locator("[data-name='recordButton']").click();
await page.waitForTimeout(600);
console.log("recording:", await value("str(browserNode.GetRecordingActive())"));
await controls.locator("[data-name='recordButton']").click();
await page.waitForTimeout(600);
console.log("recording stopped:", await value("str(not browserNode.GetRecordingActive())"));

if (shot) await page.screenshot({ path: shot });
await browser.close();

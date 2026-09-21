// CFD mesh generator: pressing Apply starts the run away from the page (in a worker), so the page
// keeps answering while it meshes, and the mesh arrives when it is done.
// Usage: node tests/cfd-mesher-worker.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheels = [new URL("extensions/" + index.extensions.find((e) => e.name === "SlicerVMTK").wheel, base).href];
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
await page.evaluate(() => window.slicerWeb.bridge.evalPython("import slicer, json"));

// the open tube the module's own test meshes
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import CfdMeshGenerator
tube = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLModelNode", "tube")
tube.SetAndObserveMesh(CfdMeshGenerator.CfdMeshGeneratorTest.openTube())
tube.CreateDefaultDisplayNodes()
`));

// open the module and set it up as a user would
await page.locator("[data-name='moduleTitle']").click();
await page.getByPlaceholder("Search modules").fill("CFD mesh generator");
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(5000);
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
widget = slicer.modules.CfdMeshGeneratorWidget
node = widget.logic.getParameterNode()
node.inputSurface = slicer.util.getNode("tube")
node.targetEdgeLength = 0.4
node.boundaryLayer = False
widget.setParameterNode(node)
_runner = None
`));
console.log("TetGen available:", await py("json.dumps(bool(widget.logic.isTetGenAvailable()))"));

// press Apply: it must return at once, with the run going on elsewhere
const before = Date.now();
await page.evaluate(() => window.slicerWeb.bridge.evalPython("widget.onApplyButton()"));
console.log(`Apply returned after ${Date.now() - before} ms`);
console.log("running right after Apply:", await py("json.dumps(bool(widget.logic.isRunning))"));
console.log("runner:", await py("type(widget.logic._runner).__name__ if widget.logic._runner else 'none'"));

let answered = 0;
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  await page.waitForTimeout(400);
  await page.evaluate(() => window.slicerWeb.bridge.call("getNodes", ["vtkMRMLModelNode", false])).then(() => answered++).catch(() => {});
  if ((await py("json.dumps(bool(widget.logic.isRunning))")) === "false") break;
}
await page.waitForTimeout(1500);
console.log(`the page answered ${answered} calls while the mesh was being made`);
console.log("mesh:", await py(`json.dumps({"cells": node.outputMesh.GetMesh().GetNumberOfCells() if node.outputMesh and node.outputMesh.GetMesh() else None})`));
console.log("log window said:", (await py("json.dumps(widget.ui.logTextEdit.plainText[-1500:])")).replace(/\n/g, " | ").replace(/<[^>]+>/g, ""));
await browser.close();

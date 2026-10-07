// An extension installed from the Extensions Manager while the page runs reaches the job worker too:
// the CFD mesh generator of SlicerVMTK, installed with the worker already up, meshes in that worker
// without the page being reloaded.
// Usage: node tests/job-worker-new-extension.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (m.type() === "error" && !/GL Driver/.test(m.text())) console.log(`[error] ${m.text().slice(0, 300)}`); });
await page.goto(base + "?sample=");
await page.evaluate(() => localStorage.removeItem("slicerweb.extensions"));
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
await run("import slicer, json\nfrom slicerweb import jobs");

// A job before the extension: the worker is up, with the wheels the page started with
await run(`
_first = {}
jobs.run("result = 6 * 7", onDone=lambda result, files: _first.update(result=result), onFailed=lambda message: _first.update(error=message))
`);
for (let waited = 0; waited < 120000 && (await py("json.dumps(bool(_first))")) !== "true"; waited += 500) await page.waitForTimeout(500);
console.log("job before the installation:", await py("json.dumps(_first)"));

// SlicerVMTK installed as a user installs it, with the page running
await page.getByLabel("Application menu").click();
await page.locator("[role=menuitem]", { hasText: /extensions manager/i }).first().click();
const card = page.locator("div.mb-2").filter({ has: page.locator("*", { hasText: /^SlicerVMTK$/ }) }).first();
await card.getByRole("button", { name: /install/i }).click();
await page.waitForFunction(() => /SlicerVMTK installed|failed/.test(document.body.innerText), null, { timeout: 600000 });
console.log((await page.locator(".bg-accent").first().innerText()).slice(0, 200));
await page.keyboard.press("Escape");

// The CFD mesh generator meshes in the worker, which must have the extension now
await run(`
import CfdMeshGenerator
tube = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLModelNode", "tube")
tube.SetAndObserveMesh(CfdMeshGenerator.CfdMeshGeneratorTest.openTube())
tube.CreateDefaultDisplayNodes()
`);
await page.locator("[data-name='moduleTitle']").click();
await page.getByPlaceholder("Search modules").fill("CFD mesh generator");
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
await run(`
widget = slicer.modules.CfdMeshGeneratorWidget
node = widget.logic.getParameterNode()
node.inputSurface = slicer.util.getNode("tube")
node.targetEdgeLength = 0.4
widget.setParameterNode(node)
widget.onApplyButton()
`);
console.log("runner:", await py("type(widget.logic._runner).__name__ if widget.logic._runner else 'none'"));
const deadline = Date.now() + 300000;
while (Date.now() < deadline && (await py("json.dumps(bool(widget.logic.isRunning))")) === "true") await page.waitForTimeout(500);
await page.waitForTimeout(1000);
console.log("mesh:", await py(`json.dumps({"cells": node.outputMesh.GetMesh().GetNumberOfCells() if node.outputMesh and node.outputMesh.GetMesh() else None})`));
console.log("log window said:", (await py("json.dumps(widget.ui.logTextEdit.plainText[-400:])")).replace(/\n/g, " | ").replace(/<[^>]+>/g, ""));
await browser.close();

// Resetting a 3D view must fit the box around the scene to what is visible now, as in desktop
// Slicer (qMRMLThreeDView::resetFocalPoint), not leave it at the bounds of data that is gone.
// Usage: node tests/reset-3d-view.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");

// the box of the view displayable manager: a non-pickable outline (8 points, 12 lines)
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import slicer, json

def boxBounds(layoutName="1"):
    view = slicer.app.layoutManager().view(layoutName)
    props = view.GetRenderer().GetViewProps()
    for i in range(props.GetNumberOfItems()):
        prop = props.GetItemAsObject(i)
        if not prop.IsA("vtkActor") or prop.GetPickable():
            continue
        mesh = prop.GetMapper().GetInput() if prop.GetMapper() else None
        if mesh is not None and mesh.GetNumberOfPoints() == 8 and mesh.GetNumberOfLines() == 12:
            return [round(v, 1) for v in prop.GetBounds()]
    return None

def boxSize():
    b = boxBounds()
    return None if b is None else [round(b[1] - b[0], 1), round(b[3] - b[2], 1), round(b[5] - b[4], 1)]
`));
await page.evaluate(() => window.slicerWeb.bridge.call("resetThreeDViews"));
await page.waitForTimeout(1500);
console.log("box around the CT chest:", await py("json.dumps(boxSize())"));

// replace the volume with a small model, and reset as the toolbar button does
await page.evaluate(() => window.slicerWeb.bridge.evalPython(`
import vtk
for node in slicer.util.getNodesByClass("vtkMRMLScalarVolumeNode"):
    slicer.mrmlScene.RemoveNode(node)
sphere = vtk.vtkSphereSource(); sphere.SetRadius(10); sphere.Update()
model = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLModelNode", "Small sphere")
model.SetAndObserveMesh(sphere.GetOutput()); model.CreateDefaultDisplayNodes()
`));
await page.waitForTimeout(1500);
console.log("box before the reset:     ", await py("json.dumps(boxSize())"));
await page.evaluate(() => window.slicerWeb.bridge.call("resetThreeDViews"));
await page.waitForTimeout(1500);
const after = JSON.parse(await py("json.dumps(boxSize())"));
console.log("box after the reset:      ", JSON.stringify(after), "(the sphere is 20 mm across)");
console.log(after && after.every((s) => s > 15 && s < 30) ? "PASS: the box was fitted to the sphere" : "FAIL: the box does not follow the scene");
if (shot) await page.screenshot({ path: shot, clip: await page.locator("#slicer-view-1").boundingBox() });
await browser.close();

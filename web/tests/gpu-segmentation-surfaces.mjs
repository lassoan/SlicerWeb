// Segmentations shown as "Binary labelmap" in 3D views: the labelmap is drawn as smooth surfaces
// that the GPU computes (a signed distance field made by jump flooding in WebGL2 fragment shader
// passes, then ray cast; vtkSegmentationLabelmapSurfaceMapper in Slicer's segmentations
// displayable manager). The same segments are drawn at the same place, in the same colors, as the
// closed surface representation - also translucent, clipped, and under a non-linear transform;
// editing the labelmap recomputes the surface; the picker and Shift + mouse move (crosshair) find
// the surface; "Show 3D" shows and hides it without switching to closed surfaces; no GL errors.
// Usage: node tests/gpu-segmentation-surfaces.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] && !process.argv[2].endsWith(".png") ? process.argv[2] : "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 200)));
const glErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/INVALID_OPERATION|INVALID_ENUM|INVALID_VALUE|INVALID_FRAMEBUFFER|Shader failed|shader|vtkSegmentationLabelmapSurfaceMapper|ERROR|Error/.test(t)) {
    glErrors.push(t.slice(0, 300));
    console.log("[console] " + t.slice(0, 300));
  }
});
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);
const value = async (expr) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr)).replace(/^['"]|['"]$/g, "");

await page.goto(base);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && document.querySelector("#slicer-view-1"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
const defaultRepresentation3D = await page.evaluate(() => window.slicerWeb.store.settings["Segmentations/DefaultRepresentation3D"]);

// Two touching spheres and a box in a rotated, anisotropic reference geometry
await exec(`
import numpy as np, slicer, vtk
volume = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLScalarVolumeNode", "ref")
volume.SetSpacing(1.0, 1.0, 2.0)
volume.SetOrigin(-40, -35, -60)
transform = vtk.vtkTransform(); transform.RotateZ(20); transform.RotateX(10)
directions = vtk.vtkMatrix4x4()
for r in range(3):
    for c in range(3):
        directions.SetElement(r, c, transform.GetMatrix().GetElement(r, c))
volume.SetIJKToRASDirectionMatrix(directions)
slicer.util.updateVolumeFromArray(volume, np.zeros((60, 70, 80), dtype=np.int16))
seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "seg")
seg.CreateDefaultDisplayNodes()
seg.SetReferenceImageGeometryParameterFromVolumeNode(volume)
k, j, i = np.mgrid[0:60, 0:70, 0:80]
x, y, z = i * 1.0, j * 1.0, k * 2.0
sphere1 = (x - 30) ** 2 + (y - 35) ** 2 + (z - 60) ** 2 < 15 ** 2
sphere2 = ((x - 52) ** 2 + (y - 35) ** 2 + (z - 60) ** 2 < 12 ** 2) & ~sphere1
box = (x > 10) & (x < 70) & (y > 5) & (y < 15) & (z > 20) & (z < 100)
for name, mask, color in (("sphere1", sphere1, (0.9, 0.2, 0.1)), ("sphere2", sphere2, (0.1, 0.8, 0.2)), ("box", box, (0.9, 0.8, 0.1))):
    segmentId = seg.GetSegmentation().AddEmptySegment(name, name, color)
    slicer.util.updateSegmentBinaryLabelmapFromArray(mask.astype(np.uint8), seg, segmentId, volume)
slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutOneUp3DView)
`);
await page.waitForTimeout(3000);

/** Pixels of the 3D view in each segment color (red, green, yellow). */
const rendered = () => page.evaluate(async () => {
  await window.slicerWeb.bridge.call("renderView", ["1"]);
  const host = document.querySelector("#slicer-view-1");
  const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
  const gl = canvas?.getContext("webgl2");
  if (!gl) return null;
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const counts = { red: 0, green: 0, yellow: 0, blue: 0, shades: 0 };
  const shades = new Set();
  let sumX = 0, sumY = 0, n = 0;
  for (let p = 0; p < pixels.length; p += 4) {
    const [r, g, b] = [pixels[p], pixels[p + 1], pixels[p + 2]];
    let hit = true;
    if (b > 2 * r && b > 2 * g && b > 40) { counts.blue++; continue; }
    if (r > 2 * g && r > 2 * b && r > 40) counts.red++;
    else if (g > 2 * r && g > 2 * b && g > 40) counts.green++;
    else if (r > 2 * b && g > 2 * b && r > 40 && g > 40) counts.yellow++;
    else hit = false;
    if (hit) {
      shades.add((r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3));
      const index = p / 4;
      sumX += index % canvas.width; sumY += Math.floor(index / canvas.width); n++;
    }
  }
  counts.shades = shades.size;
  counts.center = n ? [Math.round(sumX / n), Math.round(sumY / n)] : null;
  return counts;
});

await exec(`
seg = slicer.util.getNode("seg")
seg.CreateClosedSurfaceRepresentation()
seg.GetDisplayNode().SetPreferredDisplayRepresentationName3D("Closed surface")
view = slicer.app.layoutManager().threeDWidget(0).threeDView()
view.resetFocalPoint()
view.resetCamera()
`);
await page.waitForTimeout(2000);
const closed = await rendered();
console.log("     closed surface:", JSON.stringify(closed));

await exec(`slicer.util.getNode("seg").GetDisplayNode().SetPreferredDisplayRepresentationName3D("Binary labelmap")`);
await page.waitForTimeout(3000);
const labelmap = await rendered();
console.log("     binary labelmap:", JSON.stringify(labelmap));
if (shot) {
  await page.locator("#slicer-view-1").screenshot({ path: shot });
}

const mapperCount = `len([a for a in slicer.app.layoutManager().threeDWidget(0).threeDView().renderWindow().GetRenderers().GetFirstRenderer().GetActors() if a.GetMapper() and a.GetMapper().IsA("vtkSegmentationLabelmapSurfaceMapper") and a.GetVisibility()])`;
const computations = `sum(a.GetMapper().GetNumberOfDistanceFieldComputations() for a in slicer.app.layoutManager().threeDWidget(0).threeDView().renderWindow().GetRenderers().GetFirstRenderer().GetActors() if a.GetMapper() and a.GetMapper().IsA("vtkSegmentationLabelmapSurfaceMapper"))`;
check("the display node shows the binary labelmap in 3D", (await value(`slicer.util.getNode("seg").GetDisplayNode().GetDisplayRepresentationName3D()`)) === "Binary labelmap");
check("one GPU surface actor per labelmap layer", Number(await value(mapperCount)) === Number(await value(`slicer.util.getNode("seg").GetSegmentation().GetNumberOfLayers()`)), await value(mapperCount));
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance * Math.max(a, b);
for (const color of ["red", "green", "yellow"]) {
  check(`the ${color} segment covers about the same area as its closed surface`, labelmap && near(labelmap[color], closed[color], 0.15), `${labelmap?.[color]} vs ${closed[color]} pixels`);
}
check("at the same place", labelmap?.center && closed.center && Math.abs(labelmap.center[0] - closed.center[0]) < 6 && Math.abs(labelmap.center[1] - closed.center[1]) < 6,
  `${labelmap?.center} vs ${closed.center}`);
check("the surfaces are shaded, not flat", labelmap?.shades > 30, `${labelmap?.shades} shades`);

// Hiding a segment: only the other segments are drawn
await exec(`(lambda s: s.GetDisplayNode().SetSegmentVisibility(s.GetSegmentation().GetSegmentIdBySegmentName("sphere2"), False))(slicer.util.getNode("seg"))`);
await page.waitForTimeout(1500);
const hidden = await rendered();
check("a hidden segment is not drawn", hidden && hidden.green < 20 && hidden.red > 0.5 * labelmap.red, JSON.stringify(hidden));

// Editing the labelmap in place (as the Segment Editor does) recomputes the surface
const before = Number(await value(computations));
await exec(`
import vtk.util.numpy_support
seg = slicer.util.getNode("seg")
segment = seg.GetSegmentation().GetSegment(seg.GetSegmentation().GetSegmentIdBySegmentName("sphere1"))
labelmap = segment.GetRepresentation("Binary labelmap")
dims = labelmap.GetDimensions()
voxels = vtk.util.numpy_support.vtk_to_numpy(labelmap.GetPointData().GetScalars()).reshape(dims[2], dims[1], dims[0])
extent = labelmap.GetExtent()
# remove the half of sphere1 that has smaller i than its center (i = 30)
cut = voxels[:, :, : max(0, 30 - extent[0])]
cut[cut == segment.GetLabelValue()] = 0
labelmap.Modified()
segment.Modified()
`);
await page.waitForTimeout(1500);
const edited = await rendered();
check("editing the labelmap computes the distance field again", Number(await value(computations)) > before, `${before} -> ${await value(computations)}`);
check("and the edited segment is drawn smaller", edited && edited.red < 0.85 * hidden.red, `${edited?.red} vs ${hidden.red} pixels`);
// The distance field was updated only around the edit: the same as computing it everywhere (forced by a change of smoothing)
await exec(`
seg = slicer.util.getNode("seg")
seg.GetSegmentation().SetConversionParameter("Smoothing factor", "0.51")
seg.Modified()
`);
await page.waitForTimeout(1500);
const recomputed = await rendered();
check("updating the surface only where the labels changed gives the same surface as computing it everywhere",
  near(edited.red, recomputed.red, 0.03) && near(edited.yellow, recomputed.yellow, 0.03), `${JSON.stringify(edited)} vs ${JSON.stringify(recomputed)}`);
await exec(`
seg = slicer.util.getNode("seg")
seg.GetSegmentation().SetConversionParameter("Smoothing factor", "0.5")
seg.Modified()
`);

// A small disk painted in a single (2 mm thick) slice is shown, although it is thinner than the smoothing
await exec(`
import vtk.util.numpy_support
seg = slicer.util.getNode("seg")
segmentation = seg.GetSegmentation()
dotId = segmentation.AddEmptySegment("dot", "dot", (0.1, 0.2, 0.9))
dot = segmentation.GetSegment(dotId)
labelmap = dot.GetRepresentation("Binary labelmap")
extent = labelmap.GetExtent()
dims = labelmap.GetDimensions()
voxels = vtk.util.numpy_support.vtk_to_numpy(labelmap.GetPointData().GetScalars()).reshape(dims[2], dims[1], dims[0])
import numpy as np
k, j, i = np.mgrid[0:dims[2], 0:dims[1], 0:dims[0]]
i = i + extent[0]; j = j + extent[2]; k = k + extent[4]
disk = (k == 40) & ((i - 65) ** 2 + (j - 55) ** 2 <= 16)
voxels[disk & (voxels == 0)] = dot.GetLabelValue()
labelmap.Modified()
dot.Modified()
`);
await page.waitForTimeout(2000);
const withDot = await rendered();
check("a disk painted in a single thick slice is shown", withDot.blue > 30, `${withDot.blue} blue pixels`);

// The following are compared with the closed surface rendering of the same segmentation
await exec(`
seg = slicer.util.getNode("seg")
seg.GetDisplayNode().SetSegmentVisibility(seg.GetSegmentation().GetSegmentIdBySegmentName("sphere2"), True)
`);
// (the closed surface is made again: editing the labelmap removed it)
const showAs = (representation) => exec(`
seg = slicer.util.getNode("seg")
if "${representation}" == "Closed surface":
    seg.CreateClosedSurfaceRepresentation()
seg.GetDisplayNode().SetPreferredDisplayRepresentationName3D("${representation}")`);
/** Average color around the screen position of a world point (in the canvas, which has its origin at the bottom left). */
const colorAtWorld = async (ras) => {
  const [x, y] = JSON.parse((await value(`
(lambda r: (r.SetWorldPoint(${ras.join(",")}, 1.0), r.WorldToDisplay(), str([round(v) for v in r.GetDisplayPoint()[:2]]))[2])(
    slicer.app.layoutManager().threeDWidget(0).threeDView().renderWindow().GetRenderers().GetFirstRenderer())`)));
  return page.evaluate(async ([x, y]) => {
    await window.slicerWeb.bridge.call("renderView", ["1"]);
    const host = document.querySelector("#slicer-view-1");
    const canvas = host?.matches("canvas") ? host : host?.querySelector("canvas");
    const gl = canvas.getContext("webgl2");
    const pixels = new Uint8Array(5 * 5 * 4);
    gl.readPixels(x - 2, y - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const sum = [0, 0, 0];
    for (let p = 0; p < pixels.length; p += 4) for (let c = 0; c < 3; c++) sum[c] += pixels[p + c];
    return sum.map((v) => Math.round(v / 25));
  }, [x, y]);
};
const sphere1Center = JSON.parse(await value(`
(lambda m: str([round(v, 2) for v in m.MultiplyPoint([30, 35, 30, 1])[:3]]))(
    (lambda v, m: (v.GetIJKToRASMatrix(m), m)[1])(slicer.util.getNode("ref"), __import__("vtk").vtkMatrix4x4()))`));
const near3 = (a, b, tolerance) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

// Per-segment 3D opacity: the box is seen through the translucent sphere, as with closed surfaces
await exec(`(lambda s: s.GetDisplayNode().SetSegmentOpacity3D(s.GetSegmentation().GetSegmentIdBySegmentName("sphere1"), 0.4))(slicer.util.getNode("seg"))`);
await showAs("Closed surface");
await page.waitForTimeout(1500);
const translucentClosed = await colorAtWorld(sphere1Center);
await showAs("Binary labelmap");
await page.waitForTimeout(2000);
const translucentLabelmap = await colorAtWorld(sphere1Center);
check("a translucent segment blends with what is behind it, as its closed surface does", near3(translucentLabelmap, translucentClosed, 40),
  `${translucentLabelmap} vs ${translucentClosed}`);
check("one GPU surface actor for the opaque segments and one for the translucent one", Number(await value(mapperCount)) === 2, await value(mapperCount));
await exec(`(lambda s: s.GetDisplayNode().SetSegmentOpacity3D(s.GetSegmentation().GetSegmentIdBySegmentName("sphere1"), 1.0))(slicer.util.getNode("seg"))`);

// Clipping by the red slice plane, with caps
await exec(`
seg = slicer.util.getNode("seg")
clipNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLClipNode")
clipNode.SetRedSliceClipState(clipNode.ClipPositiveSpace)
red = slicer.util.getNode("vtkMRMLSliceNodeRed")
red.SetSliceOffset(${sphere1Center[2]})
seg.GetDisplayNode().SetAndObserveClipNodeID(clipNode.GetID())
seg.GetDisplayNode().SetClipping(True)
seg.GetDisplayNode().SetClippingCapSurface(True)
`);
await showAs("Closed surface");
await page.waitForTimeout(2000);
const clippedClosed = await rendered();
await showAs("Binary labelmap");
await page.waitForTimeout(2000);
const clippedLabelmap = await rendered();
console.log("     clipped closed surface:", JSON.stringify(clippedClosed), "binary labelmap:", JSON.stringify(clippedLabelmap));
for (const color of ["red", "green", "yellow"]) {
  check(`clipped: the ${color} segment covers about the same area as its clipped closed surface`,
    near(clippedLabelmap[color], clippedClosed[color], 0.2), `${clippedLabelmap[color]} vs ${clippedClosed[color]} pixels`);
}
check("clipping removes part of the segments", clippedLabelmap.yellow < 0.8 * labelmap.yellow, `${clippedLabelmap.yellow} vs ${labelmap.yellow} pixels`);
await exec(`slicer.util.getNode("seg").GetDisplayNode().SetClipping(False)`);

// Picking: the accurate picker of the 3D view finds the surface (the mapper intersects the pick ray with the labelmap)
const sphere2Center = JSON.parse(await value(`
(lambda m: str([round(v, 2) for v in m.MultiplyPoint([52, 35, 30, 1])[:3]]))(
    (lambda v, m: (v.GetIJKToRASMatrix(m), m)[1])(slicer.util.getNode("ref"), __import__("vtk").vtkMatrix4x4()))`));
const [sphereX, sphereY] = JSON.parse((await value(`
(lambda r: (r.SetWorldPoint(${sphere2Center.join(",")}, 1.0), r.WorldToDisplay(), str([round(v) for v in r.GetDisplayPoint()[:2]]))[2])(
    slicer.app.layoutManager().threeDWidget(0).threeDView().renderWindow().GetRenderers().GetFirstRenderer())`)));
const accuratePick = JSON.parse(await value(`
(lambda picker, r: (picker.Pick(${sphereX}, ${sphereY}, 0, r), str([round(v, 1) for v in picker.GetPickPosition()]))[1])(
    slicer.vtkMRMLAccuratePicker(), slicer.app.layoutManager().threeDWidget(0).threeDView().renderWindow().GetRenderers().GetFirstRenderer())`));
const distanceToCenter = (p) => Math.hypot(p[0] - sphere2Center[0], p[1] - sphere2Center[1], p[2] - sphere2Center[2]);
check("the accurate picker finds the surface of the segment", distanceToCenter(accuratePick) > 9 && distanceToCenter(accuratePick) < 14,
  `${accuratePick}, ${distanceToCenter(accuratePick).toFixed(1)} mm from the center of the sphere of radius 12 mm`);
// Shift + mouse move puts the crosshair there
const canvasBox = await page.locator("#slicer-view-1").boundingBox();
const canvasHeight = Number(await page.evaluate(() => {
  const host = document.querySelector("#slicer-view-1");
  return (host?.matches("canvas") ? host : host?.querySelector("canvas")).height;
}));
const cssScale = canvasBox.height / canvasHeight;
await page.mouse.move(canvasBox.x + sphereX * cssScale - 3, canvasBox.y + (canvasHeight - sphereY) * cssScale);
await page.keyboard.down("Shift");
await page.mouse.move(canvasBox.x + sphereX * cssScale, canvasBox.y + (canvasHeight - sphereY) * cssScale, { steps: 3 });
await page.keyboard.up("Shift");
await page.waitForTimeout(1000);
const crosshair = JSON.parse(await value(`str([round(v, 1) for v in slicer.util.getNode("vtkMRMLCrosshairNodedefault").GetCrosshairRAS()])`));
check("shift + mouse move puts the crosshair on the surface", distanceToCenter(crosshair) > 9 && distanceToCenter(crosshair) < 14,
  `${crosshair}, ${distanceToCenter(crosshair).toFixed(1)} mm from the center`);

// Pick3D of the displayable manager finds the segment
const picked = await value(`
(lambda dm: (dm.Pick3D(${JSON.stringify(sphere1Center)}), slicer.util.getNode("seg").GetSegmentation().GetSegment(dm.GetPickedSegmentID()).GetName() if dm.GetPickedSegmentID() else "")[1])(
    slicer.app.layoutManager().threeDWidget(0).threeDView().displayableManagerByClassName("vtkMRMLSegmentationsDisplayableManager3D"))`);
check("picking at a segment finds it", picked === "sphere1", picked);

// Non-linear transform: a grid transform that moves everything 15 mm to the right (R)
await exec(`
import vtk, vtk.util.numpy_support
grid = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLGridTransformNode")
displacement = vtk.vtkImageData()
displacement.SetOrigin(-150, -150, -150)
displacement.SetSpacing(50, 50, 50)
displacement.SetDimensions(7, 7, 7)
displacement.AllocateScalars(vtk.VTK_DOUBLE, 3)
vtk.util.numpy_support.vtk_to_numpy(displacement.GetPointData().GetScalars())[:] = [15.0, 0.0, 0.0]
grid.GetTransformFromParent().SetDisplacementGridData(displacement)
slicer.util.getNode("seg").SetAndObserveTransformNodeID(grid.GetID())
`);
await showAs("Closed surface");
await page.waitForTimeout(2000);
const warpedClosed = await rendered();
await showAs("Binary labelmap");
await page.waitForTimeout(3000);
const warpedLabelmap = await rendered();
console.log("     warped closed surface:", JSON.stringify(warpedClosed), "binary labelmap:", JSON.stringify(warpedLabelmap));
check("under a non-linear transform the segments are shown", warpedLabelmap.yellow > 0.5 * labelmap.yellow, `${warpedLabelmap.yellow} pixels`);
check("at the same place as the transformed closed surfaces", warpedLabelmap.center && warpedClosed.center
  && Math.abs(warpedLabelmap.center[0] - warpedClosed.center[0]) < 6 && Math.abs(warpedLabelmap.center[1] - warpedClosed.center[1]) < 6,
  `${warpedLabelmap.center} vs ${warpedClosed.center}`);
check("which moved", warpedClosed.center && Math.abs(warpedClosed.center[0] - closed.center[0]) > 10, `${warpedClosed.center} vs ${closed.center}`);

// "Show 3D" does not change the representation the user chose for 3D: it shows or hides the segmentation
const segNodeId = await value(`slicer.util.getNode("seg").GetID()`);
await exec(`
seg = slicer.util.getNode("seg")
seg.SetAndObserveTransformNodeID(None)
seg.RemoveClosedSurfaceRepresentation()
seg.GetDisplayNode().SetPreferredDisplayRepresentationName3D("Binary labelmap")
`);
await page.evaluate((id) => window.slicerWeb.bridge.call("setSegmentationDisplay", [id, { showSurfaces: false }]), segNodeId);
const afterHide = await value(`(lambda s: f"{s.GetDisplayNode().GetPreferredDisplayRepresentationName3D()} {bool(s.GetDisplayNode().GetVisibility3D())} {s.GetSegmentation().ContainsRepresentation('Closed surface')}")(slicer.util.getNode("seg"))`);
check("Show 3D off hides the segmentation in 3D and keeps binary labelmap", afterHide === "Binary labelmap False False", afterHide);
await page.evaluate((id) => window.slicerWeb.bridge.call("setSegmentationDisplay", [id, { showSurfaces: true }]), segNodeId);
const afterShow = await value(`(lambda s: f"{s.GetDisplayNode().GetPreferredDisplayRepresentationName3D()} {bool(s.GetDisplayNode().GetVisibility3D())} {s.GetSegmentation().ContainsRepresentation('Closed surface')}")(slicer.util.getNode("seg"))`);
check("Show 3D on shows it again, without creating closed surfaces", afterShow === "Binary labelmap True False", afterShow);
await page.waitForTimeout(1500);
check("and the GPU surfaces are drawn again", Number(await value(mapperCount)) > 0, await value(mapperCount));

// A display node change while the segmentation node's modified events are blocked (as the desktop "Show 3D" button does)
// updates the 3D view, too: the segmentation node then reports the change without saying which display node changed
await exec(`slicer.util.getNode("seg").GetDisplayNode().SetVisibility3D(False)`);
await page.waitForTimeout(1500);
check("hidden in 3D: no GPU surfaces", Number(await value(mapperCount)) === 0, await value(mapperCount));
await exec(`
seg = slicer.util.getNode("seg")
wasModifying = seg.StartModify()
seg.GetDisplayNode().SetVisibility3D(True)
seg.EndModify(wasModifying)
`);
await page.waitForTimeout(1500);
check("shown while the segmentation node's events are blocked: the GPU surfaces are drawn", Number(await value(mapperCount)) > 0, await value(mapperCount));

// Application setting: the representation that new segmentations show in 3D views
const newSegmentation3D = () => value(`(lambda s: (s.CreateDefaultDisplayNodes(), str(s.GetDisplayNode().GetPreferredDisplayRepresentationName3D()))[1])(
    slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode"))`);
check("the setting is Default at first", defaultRepresentation3D === "", JSON.stringify(defaultRepresentation3D));
check("which on the web means new segmentations show binary labelmap in 3D", (await newSegmentation3D()) === "Binary labelmap");
await page.evaluate(() => window.slicerWeb.bridge.call("setApplicationSettings", [{ "Segmentations/DefaultRepresentation3D": "Closed surface" }]));
check("with Closed surface, new segmentations show closed surface in 3D", (await newSegmentation3D()) === "Closed surface");
await page.evaluate(() => window.slicerWeb.bridge.call("setApplicationSettings", [{ "Segmentations/DefaultRepresentation3D": "" }]));
check("and with Default again, binary labelmap", (await newSegmentation3D()) === "Binary labelmap");

check("no GL or shader errors", glErrors.length === 0, glErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(fail.length ? `${fail.length} check(s) failed` : "all checks passed");
process.exit(fail.length ? 1 : 0);

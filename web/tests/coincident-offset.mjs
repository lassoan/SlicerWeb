// The depth a model is drawn at, against what it is drawn against. Models go through VTK's GLES
// "low memory" polydata mapper in the browser, markups control points through the glyph mapper;
// the same sphere has to come out at the same depth from both (it did not: the low memory mapper
// kept the -4 unit line offset of an earlier draw in the shared shader program and drew every
// surface closer to the camera, so control points placed on a surface sank into it when zoomed
// in - patches/VTK/0009). Then the case the user sees: a control point on a sphere model, looked
// at along the surface and zoomed in until the point is a few hundredths of a millimetre across,
// still shows.
// Usage: node tests/coincident-offset.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(`${base}?sample=&layout=OneUp3D`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
let failed = false;
const check = (what, ok, detail) => { if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${detail}`); };

await run(`
import json, math, slicer, vtk
slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutOneUp3DView)
_view = slicer.app.layoutManager().threeDWidget(0).threeDView()
_rw = _view.renderWindow()
_renderer = _rw.GetRenderers().GetFirstRenderer()
def _render():
    _view.forceRender()
    slicer.app.processEvents()
    _view.forceRender()

# 1. The same sphere through the two mappers: depth at its centre and over all its pixels
_sphere = vtk.vtkSphereSource()
_sphere.SetRadius(5.0); _sphere.SetThetaResolution(96); _sphere.SetPhiResolution(96); _sphere.SetCenter(0, 0, 0)
_sphere.Update()
_poly = vtk.vtkActor(); _pm = vtk.vtkPolyDataMapper(); _pm.SetInputData(_sphere.GetOutput()); _poly.SetMapper(_pm)
_one = vtk.vtkPolyData(); _pts = vtk.vtkPoints(); _pts.InsertNextPoint(0, 0, 0); _one.SetPoints(_pts)
_gm = vtk.vtkGlyph3DMapper(); _gm.SetInputData(_one); _gm.SetSourceData(_sphere.GetOutput()); _gm.ScalingOff(); _gm.OrientOff()
_glyph = vtk.vtkActor(); _glyph.SetMapper(_gm)
_cam = _renderer.GetActiveCamera()
_cam.SetFocalPoint(0, 0, 0); _cam.SetPosition(0, -40, 0); _cam.SetViewUp(0, 0, 1); _cam.SetViewAngle(30)
_renderer.ResetCameraClippingRange()
_size = _rw.GetSize()
_images = {}
for _name, _actor in (("model mapper", _poly), ("glyph mapper", _glyph)):
    _renderer.AddActor(_actor)
    _render()
    _z = vtk.vtkFloatArray()
    _rw.GetZbufferData(0, 0, _size[0] - 1, _size[1] - 1, _z)
    _images[_name] = [_z.GetValue(i) for i in range(_z.GetNumberOfTuples())]
    _renderer.RemoveActor(_actor)
_diffs = sorted(a - b for a, b in zip(_images["model mapper"], _images["glyph mapper"]) if a < 1.0 and b < 1.0)
_depthResult = {"pixels": len(_diffs), "min": _diffs[0], "max": _diffs[-1], "mapper": _pm.GetClassName()}
`);
const depth = JSON.parse(await py("json.dumps(_depthResult)"));
const oneUnit = 1 / 65000;
check("the two mappers draw the sphere at the same depth", depth.pixels > 1000 && Math.abs(depth.min) < oneUnit / 4 && Math.abs(depth.max) < oneUnit / 4,
  `${depth.pixels} pixels, difference ${depth.min.toExponential(2)} .. ${depth.max.toExponential(2)} (one offset unit is ${oneUnit.toExponential(2)}; ${depth.mapper})`);

await run(`
# 2. A control point on a sphere model, seen along the surface, zoomed in: the point still shows
_modelSource = vtk.vtkSphereSource()
_modelSource.SetRadius(30.0); _modelSource.SetThetaResolution(128); _modelSource.SetPhiResolution(128)
_modelSource.Update()
_model = slicer.modules.models.logic().AddModel(_modelSource.GetOutput())
_model.GetDisplayNode().SetColor(0.9, 0.9, 0.2)
_points = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "P")
_points.AddControlPoint(30.0, 0.0, 0.0)   # on the surface
_points.GetDisplayNode().SetPointLabelsVisibility(False)
_points.GetDisplayNode().SetSelectedColor(1.0, 0.0, 0.0)
_points.GetDisplayNode().SetColor(1.0, 0.0, 0.0)
# the point 0.35 mm across, as a point placed on a vessel is once zoomed in on
_points.GetDisplayNode().SetUseGlyphScale(False)
_points.GetDisplayNode().SetGlyphSize(0.35)
# a grazing view: the camera 40 mm from the point, looking at the surface at 20 degrees; the depth
# buffer spans the whole model from there, so 4 offset units are a few tenths of a millimetre
_d = 40.0
_ang = math.radians(20.0)
_cam.SetFocalPoint(30.0, 0.0, 0.0)
_cam.SetPosition(30.0 + _d * math.sin(_ang), -_d * math.cos(_ang), 0.0)
_cam.SetViewUp(1.0, 0.0, 0.0)
_renderer.ResetCameraClippingRange()
_render()
_renderer.SetWorldPoint(30.0, 0.0, 0.0, 1.0)
_renderer.WorldToDisplay()
_dx, _dy, _ = _renderer.GetDisplayPoint()
_x, _y = int(round(_dx)), int(round(_dy))
def _redPixelsNearPoint():
    w2i = vtk.vtkWindowToImageFilter()
    w2i.SetInput(_rw)
    w2i.SetInputBufferTypeToRGB()
    w2i.ReadFrontBufferOff()
    w2i.Update()
    image = w2i.GetOutput()
    scalars = image.GetPointData().GetScalars()
    width = image.GetDimensions()[0]
    red = 0
    for yy in range(max(0, _y - 12), min(_size[1] - 1, _y + 12) + 1):
        for xx in range(max(0, _x - 12), min(_size[0] - 1, _x + 12) + 1):
            r, g, b = scalars.GetTuple3(yy * width + xx)
            if r > 150 and g < 90 and b < 90:
                red += 1
    return red
_red = _redPixelsNearPoint()
# the whole sphere of the point, with nothing in front of it. The point is on the surface, and the
# sphere is drawn a little towards the camera on purpose (its -1 unit offset), so most of it shows
# over a surface drawn where it is (88% here); over a surface drawn 4 units too close, under half.
_model.GetDisplayNode().SetVisibility(False)
_render()
_alone = _redPixelsNearPoint()
_model.GetDisplayNode().SetVisibility(True)
_render()
_mmPerPixel = 2.0 * _d * math.tan(math.radians(_cam.GetViewAngle() / 2.0)) / _size[1]
_pointResult = {"redPixelsNearPoint": _red, "redPixelsAlone": _alone, "mmPerPixel": _mmPerPixel, "pixel": [_x, _y]}
`);
const point = JSON.parse(await py("json.dumps(_pointResult)"));
const fraction = point.redPixelsAlone ? point.redPixelsNearPoint / point.redPixelsAlone : 0;
check("a control point on a surface shows when zoomed in at a grazing angle", point.redPixelsAlone >= 40 && fraction >= 0.6,
  `${point.redPixelsNearPoint} of the point's ${point.redPixelsAlone} pixels show (${(100 * fraction).toFixed(0)}%, ` +
  `at least 60% wanted; ${point.mmPerPixel.toFixed(4)} mm per pixel)`);
await browser.close();
console.log(failed ? "FAIL" : "ok");
process.exit(failed ? 1 : 0);

// ctk.ctkVTKChartView drawn as SVG, in a qt.QDialog shown over the page, as SimVascular's ROM
// Simulation reviews an inflow waveform: the chart's plots drawn from their tables (a line through
// every point, a marker on each, the axis titles), drawn again when the data change and the view is
// rendered; the dialog over the page with its title, closed by OK (Accepted) or by Escape (Rejected);
// a check box's checked assigned emits toggled, as in PythonQt.
// Usage: node tests/qt-chart-dialog.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
const py = async (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const ev = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

await py(`
import ctk, qt, vtk
_toggles = []
_dialog = qt.QDialog()
_dialog.setWindowTitle("Inflow waveform")
_layout = qt.QVBoxLayout(_dialog)
_view = ctk.ctkVTKChartView()
_view.minimumSize = qt.QSize(620, 340)
_layout.addWidget(_view)
_negate = qt.QCheckBox("Negate flow")
_negate.connect("toggled(bool)", lambda checked: _toggles.append(checked))
_layout.addWidget(_negate)
_buttons = qt.QDialogButtonBox()
_buttons.addButton(qt.QDialogButtonBox.Ok)
_buttons.addButton(qt.QDialogButtonBox.Cancel)
_buttons.connect("accepted()", _dialog.accept)
_buttons.connect("rejected()", _dialog.reject)
_layout.addWidget(_buttons)
_table = vtk.vtkTable()
for _name in ("time (s)", "flow (mL/s)"):
    _column = vtk.vtkDoubleArray(); _column.SetName(_name); _table.AddColumn(_column)
_table.SetNumberOfRows(5)
for _row, (_t, _q) in enumerate(((0.0, -5.0), (0.2, -10.0), (0.4, -15.0), (0.6, -10.0), (0.8, -5.0))):
    _table.SetValue(_row, 0, vtk.vtkVariant(_t)); _table.SetValue(_row, 1, vtk.vtkVariant(_q))
_plot = vtk.vtkPlotLine()
_plot.SetInputData(_table, 0, 1)
_plot.SetColor(200, 30, 30, 255)
_plot.SetWidth(1.5)
_plot.SetMarkerStyle(vtk.vtkPlotPoints.CIRCLE)
_plot.SetMarkerSize(4.0)
_chart = _view.chart()
_chart.AddPlot(_plot)
_chart.GetAxis(vtk.vtkAxis.BOTTOM).SetTitle("time (s)")
_chart.GetAxis(vtk.vtkAxis.LEFT).SetTitle("flow (mL/s)")
_chart.SetShowLegend(False)
_dialog.show()
_view.renderWindow().Render()
`);
await page.waitForTimeout(500);

const drawn = await page.evaluate(() => {
  const backdrop = document.querySelector(".sw-dialog-backdrop");
  const svg = backdrop?.querySelector(".sw-chart-view svg");
  const line = svg?.querySelector("polyline");
  const rect = svg?.getBoundingClientRect();
  return {
    shown: !!backdrop && getComputedStyle(backdrop).position === "fixed",
    title: backdrop?.querySelector(".sw-dialog-title")?.textContent ?? "",
    points: line ? line.getAttribute("points").trim().split(/\s+/).length : 0,
    stroke: line?.getAttribute("stroke") ?? "",
    markers: svg ? svg.querySelectorAll("circle").length : 0,
    texts: svg ? [...svg.querySelectorAll("text")].map((t) => t.textContent) : [],
    width: rect?.width ?? 0, height: rect?.height ?? 0,
    ys: line ? line.getAttribute("points").trim().split(/\s+/).map((p) => Number(p.split(",")[1])) : [],
  };
});
if (shot) await page.screenshot({ path: shot });
check(drawn.shown, "the dialog is over the page");
check(drawn.title === "Inflow waveform", "with its title", drawn.title);
check(drawn.points === 5, "a line through every point", `${drawn.points} points`);
check(drawn.stroke === "rgba(200,30,30,1.000)", "in the plot's color", drawn.stroke);
check(drawn.markers === 5, "a marker on each point", `${drawn.markers}`);
check(drawn.texts.includes("time (s)") && drawn.texts.includes("flow (mL/s)"), "the axis titles", drawn.texts.join(" | "));
check(drawn.width >= 600 && drawn.height >= 330, "at its minimum size at least", `${drawn.width} x ${drawn.height}`);
// flow is negative: the lowest flow (-15) is drawn lowest (largest y on the screen)
check(drawn.ys[2] === Math.max(...drawn.ys), "the lowest flow drawn lowest");

await py(`
_negate.checked = True
for _row in range(_table.GetNumberOfRows()):
    _table.SetValue(_row, 1, vtk.vtkVariant(-_table.GetValue(_row, 1).ToDouble()))
_table.Modified()
_view.scene().SetDirty(True)
_view.renderWindow().Render()
`);
const negated = await page.evaluate(() => {
  const line = document.querySelector(".sw-dialog-backdrop .sw-chart-view polyline");
  return line.getAttribute("points").trim().split(/\s+/).map((p) => Number(p.split(",")[1]));
});
check(negated[2] === Math.min(...negated), "drawn again from the changed data: the highest flow highest");
check((await ev("str(_toggles)")) === "[True]", "assigning checked emits toggled", await ev("str(_toggles)"));
check((await ev("str(_negate.checked)")) === "True", "and the box is checked");

const geometry = await ev(`str((_buttons.button(qt.QDialogButtonBox.Ok).height > 0,
  _buttons.button(qt.QDialogButtonBox.Ok).mapTo(_dialog, qt.QPoint(0, _buttons.button(qt.QDialogButtonBox.Ok).height)).y() <= _dialog.height))`);
check(geometry === "(True, True)", "the buttons have a size and are inside the dialog", geometry);

await page.locator(".sw-dialog-backdrop").getByText("OK", { exact: true }).click();
await page.waitForTimeout(300);
check((await ev("str(_dialog.result() == qt.QDialog.Accepted)")) === "True", "OK accepts the dialog");
check((await page.locator(".sw-dialog-backdrop").count()) === 0, "and closes it");

await py("_dialog.show()");
await page.waitForTimeout(200);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check((await ev("str(_dialog.result() == qt.QDialog.Rejected)")) === "True", "Escape rejects the dialog");
check((await page.locator(".sw-dialog-backdrop").count()) === 0, "and closes it");

const fixed = await ev("str(qt.QFontDatabase.systemFont(qt.QFontDatabase.FixedFont).family())");
check(fixed === "monospace", "the fixed system font is the browser's monospace", fixed);
const environment = await ev("str(isinstance(slicer.util.startupEnvironment(), dict))");
check(environment === "True", "slicer.util.startupEnvironment() is a dict of the variables");

check(errors.length === 0, "no errors on the page", errors.join(" | "));
await browser.close();
process.exit(failures ? 1 : 0);

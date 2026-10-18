"""ctkVTKChartView: a VTK chart (vtkChartXY) drawn as SVG in the page.

On the desktop, ctkVTKChartView is a VTK context view: a render window whose scene holds a
vtkChartXY, which draws its plots with VTK's 2D context. The browser build of VTK has the charts
(vtkChartXY, vtkPlotLine, vtkPlotPoints, vtkPlotBar, vtkAxis) but no context view to render them,
and a chart without a scene does not compute its bounds or lay out its axes. So the chart here is
VTK's own - module code adds plots, sets colors, markers and axis titles on it as on the desktop -
and it is drawn from what it holds: each visible plot's table, the two columns it plots, its color,
width, line type and markers, the axes' titles, ranges and grid, the chart's title and legend.
It is drawn again when the view is rendered (renderWindow().Render(), scene().SetDirty(True),
forceRender()) and when the page resizes it.
"""

import logging
import math

from . import dom
from .core import Signal, property_value
from .graphics import _number, _svg
from .widgets import QWidget

logger = logging.getLogger(__name__)

#: The size a chart is drawn at before the page has laid it out
DEFAULT_SIZE = (400, 300)
MARGIN = {"left": 58, "right": 14, "top": 14, "bottom": 40}
TICK_FONT_PX = 11
TITLE_FONT_PX = 12

# vtkPlotPoints marker styles and vtkPen line types (0: no pen, 1: solid)
_NONE, _CROSS, _PLUS, _SQUARE, _CIRCLE, _DIAMOND = range(6)
_DASHES = {2: "6 4", 3: "2 3", 4: "6 3 2 3", 5: "6 3 2 3 2 3"}


def _vtk():
    import vtk

    return vtk


def _niceStep(span, count=5):
    """A tick step of 1, 2 or 5 times a power of ten that gives about *count* ticks over *span*."""
    if not span > 0 or not math.isfinite(span):
        return 1.0
    rough = span / count
    power = 10.0 ** math.floor(math.log10(rough))
    for factor in (1.0, 2.0, 5.0, 10.0):
        if rough <= factor * power:
            return factor * power
    return 10.0 * power


def _niceRange(low, high):
    """The data's range widened to whole ticks, as a VTK axis that scales itself (vtkAxis::AUTO)."""
    if low > high:
        return 0.0, 1.0
    if low == high:
        pad = abs(low) * 0.1 or 1.0
        low, high = low - pad, high + pad
    step = _niceStep(high - low)
    return math.floor(low / step + 1e-9) * step, math.ceil(high / step - 1e-9) * step


def _ticks(low, high):
    step = _niceStep(high - low)
    ticks, value = [], math.ceil(low / step - 1e-9) * step
    while value <= high + step * 1e-9 and len(ticks) < 50:
        ticks.append(0.0 if abs(value) < step * 1e-9 else value)
        value += step
    return ticks, step


def _tickLabel(value, step):
    if abs(value) >= 1e6 or (value and abs(value) < 1e-4):
        return f"{value:.3g}"
    decimals = max(0, -int(math.floor(math.log10(step)))) if step > 0 else 0
    return f"{value:.{min(decimals, 6)}f}"


def _cssColor(rgb, opacity=1.0):
    r, g, b = (max(0, min(255, int(round(c * 255)))) for c in rgb[:3])
    return f"rgba({r},{g},{b},{max(0.0, min(1.0, opacity)):.3f})"


class _ChartScene:
    """chartView.scene(): module code marks it dirty after it changed the chart's data."""

    def __init__(self, view):
        self._view = view
        self._dirty = False

    def SetDirty(self, dirty):
        self._dirty = bool(dirty)
        if self._dirty:
            self._view._render()
            self._dirty = False

    def GetDirty(self):
        return self._dirty


class _ChartRenderWindow:
    """chartView.renderWindow(): Render() draws the chart again."""

    def __init__(self, view):
        self._view = view

    def Render(self):
        self._view._render()


class ctkVTKChartView(QWidget):
    """A view of a vtkChartXY (chart()), drawn as SVG."""

    _tag = "div"
    _classes = "sw-chart-view rounded border border-input"

    plotAdded = Signal("plotAdded(vtkPlot*)")
    boundsChanged = Signal("boundsChanged()")
    extentChanged = Signal("extentChanged()")

    def __init__(self, parent=None, *args):
        super().__init__(parent)
        self._chart = _vtk().vtkChartXY()
        self._scene = _ChartScene(self)
        self._renderWindow = _ChartRenderWindow(self)
        self._minimum = (0, 0)
        self._userBounds = None
        self._applyStyle()
        self._svgElement = _svg("svg")
        self._svgElement.setAttribute("width", "100%")
        self._svgElement.setAttribute("height", "100%")
        self._svgElement.setAttribute("style", "display:block; position:absolute; inset:0; overflow:hidden")
        self._el.appendChild(self._svgElement)
        self._observeSize()
        self._render()

    # --- the page's side: the view's size, and drawing again when the page resizes it
    def _applyStyle(self):
        # (inline: the page's stylesheet has only the classes its own sources use)
        width, height = self._minimum
        self._el.setAttribute("style", "position:relative; width:100%; flex:1 1 auto; overflow:hidden; "
                              f"min-width:{int(width)}px; min-height:{int(height) or 200}px")

    def _observeSize(self):
        window = dom.window()
        create_proxy = getattr(dom, "create_proxy", None)
        if window is None or create_proxy is None or getattr(window, "ResizeObserver", None) is None:
            return
        try:
            self._resizeProxy = create_proxy(lambda *args: self._render())
            self._resizeObserver = window.ResizeObserver.new(self._resizeProxy)
            self._resizeObserver.observe(self._el)
        except Exception:
            logger.debug("The chart is not drawn again when it is resized", exc_info=True)
            self._resizeObserver = None

    def _destroy(self):
        observer = getattr(self, "_resizeObserver", None)
        if observer is not None:
            try:
                observer.disconnect()
                self._resizeProxy.destroy()
            except Exception:
                pass
            self._resizeObserver = None
        super()._destroy()

    @property
    def minimumSize(self):
        from .types import QSize

        return QSize(*self._minimum)

    @minimumSize.setter
    def minimumSize(self, size):
        self.setMinimumSize(size)

    def setMinimumSize(self, *args):
        if len(args) == 2:
            self._minimum = (int(args[0]), int(args[1]))
        else:
            self._minimum = (int(args[0].width()), int(args[0].height()))
        self._applyStyle()
        self._render()

    def _size(self):
        width = height = 0.0
        try:
            rect = self._el.getBoundingClientRect()
            width, height = float(rect.width), float(rect.height)
        except Exception:
            pass
        if width <= 0 or height <= 0:
            width = max(self._minimum[0], DEFAULT_SIZE[0])
            height = max(self._minimum[1], DEFAULT_SIZE[1])
        return width, height

    # --- ctkVTKChartView's API
    def chart(self):
        return self._chart

    def scene(self):
        return self._scene

    def renderWindow(self):
        return self._renderWindow

    def addPlot(self, plot):
        self._chart.AddPlot(plot)
        self.plotAdded.emit(plot)
        self._render()

    def removePlot(self, plot):
        for index in range(self._chart.GetNumberOfPlots()):
            if self._chart.GetPlot(index) == plot:
                self._chart.RemovePlot(index)
                break
        self._render()

    def removeAllPlots(self):
        self._chart.ClearPlots()
        self._render()

    def plots(self):
        return [self._chart.GetPlot(i) for i in range(self._chart.GetNumberOfPlots())]

    def setTitle(self, title):
        self._chart.SetTitle(str(title))
        self._render()

    title = property(lambda self: property_value(self._chart.GetTitle() or ""), setTitle)

    def chartBounds(self):
        (x0, x1), (y0, y1) = self._dataRange(self._series())
        return [x0, x1, y0, y1, x0, x1, y0, y1]

    def setChartUserBounds(self, bounds):
        vtk = _vtk()
        self._userBounds = [float(b) for b in list(bounds)[:4]]
        for axisId, (low, high) in ((vtk.vtkAxis.BOTTOM, self._userBounds[0:2]), (vtk.vtkAxis.LEFT, self._userBounds[2:4])):
            axis = self._chart.GetAxis(axisId)
            axis.SetBehavior(vtk.vtkAxis.FIXED)
            axis.SetRange(low, high)
        self._render()

    def chartUserBounds(self):
        return list(self._userBounds or [0.0, 0.0, 0.0, 0.0])

    def setAxesToChartBounds(self):
        vtk = _vtk()
        for axisId in (vtk.vtkAxis.BOTTOM, vtk.vtkAxis.LEFT):
            self._chart.GetAxis(axisId).SetBehavior(vtk.vtkAxis.AUTO)
        self._render()

    def boundAxesToChartBounds(self):
        pass

    def forceRender(self):
        self._render()

    def scheduleRender(self):
        self._render()

    # --- what the chart holds
    def _series(self):
        """Each visible plot: its kind, its points and how it is drawn."""
        series = []
        for index in range(self._chart.GetNumberOfPlots()):
            plot = self._chart.GetPlot(index)
            if plot is None or not plot.GetVisible():
                continue
            table = plot.GetInput()
            if table is None or table.GetNumberOfRows() == 0:
                continue
            mapper = plot.GetData()
            xs = None if plot.GetUseIndexForXSeries() else mapper.GetInputArrayToProcess(0, table)
            ys = mapper.GetInputArrayToProcess(1, table)
            if ys is None:
                continue
            points = []
            for row in range(min(ys.GetNumberOfTuples(), table.GetNumberOfRows())):
                x = float(row) if xs is None else float(xs.GetComponent(row, 0))
                y = float(ys.GetComponent(row, 0))
                if math.isfinite(x) and math.isfinite(y):
                    points.append((x, y))
            color = [0.0, 0.0, 0.0]
            plot.GetColorF(color)
            pen = plot.GetPen()
            hasMarkers = bool(plot.IsA("vtkPlotPoints"))
            if plot.IsA("vtkPlotBar"):
                kind = "bar"
            elif plot.IsA("vtkPlotLine"):
                kind = "line"
            elif hasMarkers:
                kind = "points"
            else:
                kind = "line"
            series.append({
                "kind": kind, "points": points, "color": color, "opacity": pen.GetOpacity() / 255.0,
                "width": float(plot.GetWidth()) or 1.0, "lineType": int(pen.GetLineType()),
                "marker": int(plot.GetMarkerStyle()) if hasMarkers else _NONE,
                "markerSize": float(plot.GetMarkerSize()) if hasMarkers else 0.0,
                "label": str(plot.GetLabel() or ""),
            })
        return series

    @staticmethod
    def _dataRange(series):
        points = [p for s in series for p in s["points"]]
        if not points:
            return (0.0, 1.0), (0.0, 1.0)
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        if any(s["kind"] == "bar" for s in series):
            ys.append(0.0)
        return (min(xs), max(xs)), (min(ys), max(ys))

    @staticmethod
    def _axisRange(axis, low, high):
        vtk = _vtk()
        if axis.GetBehavior() != vtk.vtkAxis.AUTO:
            fixedLow, fixedHigh = float(axis.GetMinimum()), float(axis.GetMaximum())
            if fixedHigh > fixedLow:
                return fixedLow, fixedHigh
        return _niceRange(low, high)

    # --- drawing
    def _render(self):
        svg = getattr(self, "_svgElement", None)
        if svg is None:
            return
        try:
            self._draw(svg)
        except Exception:
            logger.exception("Could not draw the chart")

    def _draw(self, svg):
        vtk = _vtk()
        svg.textContent = ""
        width, height = self._size()
        svg.setAttribute("viewBox", f"0 0 {_number(width)} {_number(height)}")
        series = self._series()
        (dx0, dx1), (dy0, dy1) = self._dataRange(series)
        bottom, left = self._chart.GetAxis(vtk.vtkAxis.BOTTOM), self._chart.GetAxis(vtk.vtkAxis.LEFT)
        x0, x1 = self._axisRange(bottom, dx0, dx1)
        y0, y1 = self._axisRange(left, dy0, dy1)
        title = str(self._chart.GetTitle() or "")
        top = MARGIN["top"] + (TITLE_FONT_PX + 8 if title else 0)
        ax, ay = float(MARGIN["left"]), float(top)
        aw = max(10.0, width - MARGIN["left"] - MARGIN["right"])
        ah = max(10.0, height - top - MARGIN["bottom"])

        def px(x):
            return ax + (x - x0) / ((x1 - x0) or 1.0) * aw

        def py(y):
            return ay + ah - (y - y0) / ((y1 - y0) or 1.0) * ah

        def add(tag, parent=svg, text=None, **attributes):
            element = _svg(tag)
            for name, value in attributes.items():
                element.setAttribute(name.replace("_", "-"), str(value))
            if text is not None:
                element.textContent = text
            parent.appendChild(element)
            return element

        if title:
            add("text", x=_number(width / 2), y=_number(MARGIN["top"] + TITLE_FONT_PX), text=title,
                text_anchor="middle", font_size=TITLE_FONT_PX, font_weight="600", fill="currentColor")

        # the axes: grid, ticks, their labels and the axis titles
        frame = add("g", fill="none", stroke="currentColor")
        if bottom.GetVisible():
            ticks, step = _ticks(x0, x1)
            for tick in ticks:
                x = px(tick)
                if bottom.GetGridVisible():
                    add("line", frame, x1=_number(x), y1=_number(ay), x2=_number(x), y2=_number(ay + ah), stroke_opacity="0.12")
                add("line", frame, x1=_number(x), y1=_number(ay + ah), x2=_number(x), y2=_number(ay + ah + 4), stroke_opacity="0.6")
                add("text", x=_number(x), y=_number(ay + ah + 6 + TICK_FONT_PX), text=_tickLabel(tick, step),
                    text_anchor="middle", font_size=TICK_FONT_PX, fill="currentColor", fill_opacity="0.8")
            if bottom.GetTitle():
                add("text", x=_number(ax + aw / 2), y=_number(height - 6), text=str(bottom.GetTitle()),
                    text_anchor="middle", font_size=TICK_FONT_PX + 1, fill="currentColor")
        if left.GetVisible():
            ticks, step = _ticks(y0, y1)
            for tick in ticks:
                y = py(tick)
                if left.GetGridVisible():
                    add("line", frame, x1=_number(ax), y1=_number(y), x2=_number(ax + aw), y2=_number(y), stroke_opacity="0.12")
                add("line", frame, x1=_number(ax - 4), y1=_number(y), x2=_number(ax), y2=_number(y), stroke_opacity="0.6")
                add("text", x=_number(ax - 7), y=_number(y + TICK_FONT_PX * 0.35), text=_tickLabel(tick, step),
                    text_anchor="end", font_size=TICK_FONT_PX, fill="currentColor", fill_opacity="0.8")
            if left.GetTitle():
                cx, cy = 13.0, ay + ah / 2
                add("text", x=_number(cx), y=_number(cy), text=str(left.GetTitle()), text_anchor="middle",
                    font_size=TICK_FONT_PX + 1, fill="currentColor",
                    transform=f"rotate(-90 {_number(cx)} {_number(cy)})")
        add("rect", frame, x=_number(ax), y=_number(ay), width=_number(aw), height=_number(ah), stroke_opacity="0.5")

        # the plots, clipped to the plot area
        clipId = f"sw-chart-clip-{id(self)}"
        clip = add("clipPath", add("defs"), id=clipId)
        add("rect", clip, x=_number(ax), y=_number(ay), width=_number(aw), height=_number(ah))
        plots = add("g", clip_path=f"url(#{clipId})")
        for s in series:
            color = _cssColor(s["color"], s["opacity"])
            group = add("g", plots, data_series=s["label"])
            points = [(px(x), py(y)) for x, y in s["points"]]
            if s["kind"] == "bar":
                barWidth = max(1.0, aw / max(1, len(points)) * 0.8)
                zero = py(max(y0, min(y1, 0.0)))
                for x, y in points:
                    add("rect", group, x=_number(x - barWidth / 2), y=_number(min(y, zero)), width=_number(barWidth),
                        height=_number(abs(zero - y)), fill=color)
                continue
            if s["kind"] == "line" and len(points) > 1 and s["lineType"] != 0:
                attributes = {"fill": "none", "stroke": color, "stroke_width": _number(s["width"]),
                              "stroke_linejoin": "round", "stroke_linecap": "round",
                              "points": " ".join(f"{_number(x)},{_number(y)}" for x, y in points)}
                if s["lineType"] in _DASHES:
                    attributes["stroke_dasharray"] = _DASHES[s["lineType"]]
                add("polyline", group, **attributes)
            marker, size = s["marker"], s["markerSize"]
            if marker == _NONE or size <= 0:
                continue
            r = size / 2.0
            for x, y in points:
                if marker == _CIRCLE:
                    add("circle", group, cx=_number(x), cy=_number(y), r=_number(r), fill=color)
                elif marker == _SQUARE:
                    add("rect", group, x=_number(x - r), y=_number(y - r), width=_number(size), height=_number(size), fill=color)
                elif marker == _DIAMOND:
                    add("polygon", group, fill=color, points=f"{_number(x)},{_number(y - r)} {_number(x + r)},{_number(y)} "
                        f"{_number(x)},{_number(y + r)} {_number(x - r)},{_number(y)}")
                elif marker == _PLUS:
                    add("path", group, stroke=color, stroke_width="1.5", fill="none",
                        d=f"M{_number(x - r)} {_number(y)}H{_number(x + r)}M{_number(x)} {_number(y - r)}V{_number(y + r)}")
                else:
                    add("path", group, stroke=color, stroke_width="1.5", fill="none",
                        d=f"M{_number(x - r)} {_number(y - r)}L{_number(x + r)} {_number(y + r)}"
                          f"M{_number(x - r)} {_number(y + r)}L{_number(x + r)} {_number(y - r)}")

        # the legend: the plots that have a label
        if self._chart.GetShowLegend():
            labeled = [s for s in series if s["label"]]
            for row, s in enumerate(labeled):
                y = ay + 10 + row * (TICK_FONT_PX + 6)
                add("line", x1=_number(ax + aw - 110), y1=_number(y), x2=_number(ax + aw - 92), y2=_number(y),
                    stroke=_cssColor(s["color"], s["opacity"]), stroke_width="2")
                add("text", x=_number(ax + aw - 88), y=_number(y + TICK_FONT_PX * 0.35), text=s["label"],
                    font_size=TICK_FONT_PX, fill="currentColor")

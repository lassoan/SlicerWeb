"""Qt's graphics view framework (QGraphicsScene, QGraphicsView and their items), drawn with SVG.

A module that draws a diagram of its own - SlicerSimVascular's ROM Simulation draws the blocks of a
0D network and the vessels between them - builds a QGraphicsScene of items and shows it in a
QGraphicsView that zooms and pans. Here the scene is a group of SVG elements, one per item, which
the view shows inside an <svg> element:

- an item is a <g> group placed at its position (setPos), holding its shape - <path>, <polygon>,
  <ellipse>, <rect>, <line> or <text> - and then a group for its child items, which are drawn
  over it, as in Qt; items of the same parent are kept in the order of their z values;
- pens and brushes are SVG stroke and fill; a cosmetic pen (width 0, or setCosmetic) keeps its
  width whatever the zoom;
- the view's transform (scale, centerOn, ensureVisible, fitInView, the wheel and the drag of its
  ScrollHandDrag mode) is the transform of the group the scene is in;
- QGraphicsView.itemAt asks the page which element is under a point, and gives back its item;
- the size of a text item is measured with the page's own font, so that a layout made from
  boundingRect() fits the text the page draws.

Mouse events reach the view's mousePressEvent, mouseMoveEvent, mouseReleaseEvent and wheelEvent,
so a module's subclass of QGraphicsView that overrides them works as on the desktop. Not here:
items that handle mouse events themselves, item selection and movement, a scene shown in two views
at once (it is shown in the last one), rotated or scaled items in bounding rectangles, and pinch
zooming.
"""

import math

from . import dom
from .core import QObject, Signal, property_value
from .types import QBrush, QColor, QFont, QPoint, QRect, Qt

SVG_NAMESPACE = "http://www.w3.org/2000/svg"

# Qt's enumerations that the graphics framework uses, added to the Qt namespace where it lacks them
for _name, _value in {
        "NoPen": 0, "SolidLine": 1, "DashLine": 2, "DotLine": 3, "DashDotLine": 4, "DashDotDotLine": 5,
        "NoBrush": 0, "SolidPattern": 1,
        "FlatCap": 0x00, "SquareCap": 0x10, "RoundCap": 0x20,
        "MiterJoin": 0x00, "BevelJoin": 0x40, "RoundJoin": 0x80,
        "NoButton": 0, "LeftButton": 1, "RightButton": 2, "MiddleButton": 4,
        "IgnoreAspectRatio": 0, "KeepAspectRatio": 1, "KeepAspectRatioByExpanding": 2,
        "RightDockWidgetArea": 2, "LeftDockWidgetArea": 1, "TopDockWidgetArea": 4, "BottomDockWidgetArea": 8,
}.items():
    if not hasattr(Qt, _name):
        setattr(Qt, _name, _value)


def _svg(tag):
    """An SVG element (or the in-memory stand-in where there is no page)."""
    document = getattr(dom, "_document", None)
    if document is not None:
        return document.createElementNS(SVG_NAMESPACE, tag)
    return dom.FakeElement(tag)


def _number(value):
    """A coordinate as SVG wants it: short, and never in exponent notation."""
    text = f"{float(value):.4f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


# ---------------------------------------------------------------------------- geometry

class QPointF:
    def __init__(self, *args):
        if len(args) == 1 and hasattr(args[0], "x"):
            self._x, self._y = float(args[0].x()), float(args[0].y())
        else:
            self._x = float(args[0]) if args else 0.0
            self._y = float(args[1]) if len(args) > 1 else 0.0

    def x(self):
        return self._x

    def y(self):
        return self._y

    def setX(self, x):
        self._x = float(x)

    def setY(self, y):
        self._y = float(y)

    def isNull(self):
        return self._x == 0.0 and self._y == 0.0

    def manhattanLength(self):
        return abs(self._x) + abs(self._y)

    def toPoint(self):
        return QPoint(round(self._x), round(self._y))

    def __add__(self, other):
        return QPointF(self._x + other.x(), self._y + other.y())

    def __sub__(self, other):
        return QPointF(self._x - other.x(), self._y - other.y())

    def __mul__(self, factor):
        return QPointF(self._x * factor, self._y * factor)

    __rmul__ = __mul__

    def __truediv__(self, divisor):
        return QPointF(self._x / divisor, self._y / divisor)

    def __neg__(self):
        return QPointF(-self._x, -self._y)

    def __eq__(self, other):
        return hasattr(other, "x") and hasattr(other, "y") and self._x == other.x() and self._y == other.y()

    __hash__ = None

    def __repr__(self):
        return f"QPointF({self._x}, {self._y})"


# QPoint gets the arithmetic a mouse event's position is used with (event.pos() - pressed)
QPoint.__add__ = lambda self, other: QPointF(self.x() + other.x(), self.y() + other.y())
QPoint.__sub__ = lambda self, other: QPointF(self.x() - other.x(), self.y() - other.y())
QPoint.manhattanLength = lambda self: abs(self.x()) + abs(self.y())


class QSizeF:
    def __init__(self, width=0.0, height=0.0):
        self._width, self._height = float(width), float(height)

    def width(self):
        return self._width

    def height(self):
        return self._height

    def isEmpty(self):
        return self._width <= 0 or self._height <= 0

    def __call__(self):
        return self


class QRectF:
    """QRectF(x, y, width, height), QRectF(topLeft, size) or QRectF(topLeft, bottomRight)."""

    def __init__(self, *args):
        if len(args) == 4:
            self._x, self._y, self._w, self._h = (float(v) for v in args)
        elif len(args) == 2 and isinstance(args[1], QSizeF):
            self._x, self._y = args[0].x(), args[0].y()
            self._w, self._h = args[1].width(), args[1].height()
        elif len(args) == 2:
            self._x, self._y = args[0].x(), args[0].y()
            self._w, self._h = args[1].x() - self._x, args[1].y() - self._y
        elif len(args) == 1 and hasattr(args[0], "width"):
            other = args[0]
            self._x, self._y, self._w, self._h = other.x(), other.y(), other.width(), other.height()
        else:
            self._x = self._y = self._w = self._h = 0.0

    def x(self):
        return self._x

    def y(self):
        return self._y

    def width(self):
        return self._w

    def height(self):
        return self._h

    def left(self):
        return self._x

    def top(self):
        return self._y

    def right(self):
        return self._x + self._w

    def bottom(self):
        return self._y + self._h

    def center(self):
        return QPointF(self._x + self._w / 2.0, self._y + self._h / 2.0)

    def topLeft(self):
        return QPointF(self._x, self._y)

    def topRight(self):
        return QPointF(self.right(), self._y)

    def bottomLeft(self):
        return QPointF(self._x, self.bottom())

    def bottomRight(self):
        return QPointF(self.right(), self.bottom())

    def size(self):
        return QSizeF(self._w, self._h)

    def isNull(self):
        return self._w == 0 and self._h == 0

    def isEmpty(self):
        return self._w <= 0 or self._h <= 0

    def isValid(self):
        return self._w > 0 and self._h > 0

    def adjusted(self, dx1, dy1, dx2, dy2):
        return QRectF(self._x + dx1, self._y + dy1, self._w - dx1 + dx2, self._h - dy1 + dy2)

    def translated(self, *args):
        dx, dy = (args[0].x(), args[0].y()) if len(args) == 1 else args
        return QRectF(self._x + dx, self._y + dy, self._w, self._h)

    def united(self, other):
        if self.isNull():
            return QRectF(other)
        if other.isNull():
            return QRectF(self)
        left, top = min(self.left(), other.left()), min(self.top(), other.top())
        right, bottom = max(self.right(), other.right()), max(self.bottom(), other.bottom())
        return QRectF(left, top, right - left, bottom - top)

    def intersects(self, other):
        return not (other.left() > self.right() or other.right() < self.left()
                    or other.top() > self.bottom() or other.bottom() < self.top())

    def contains(self, *args):
        point = args[0] if len(args) == 1 else QPointF(*args)
        if isinstance(point, QRectF):
            return self.contains(point.topLeft()) and self.contains(point.bottomRight())
        return self.left() <= point.x() <= self.right() and self.top() <= point.y() <= self.bottom()

    def setRect(self, x, y, w, h):
        self._x, self._y, self._w, self._h = float(x), float(y), float(w), float(h)

    def toRect(self):
        return QRect(round(self._x), round(self._y), round(self._w), round(self._h))

    def __eq__(self, other):
        return isinstance(other, QRectF) and (self._x, self._y, self._w, self._h) == (
            other._x, other._y, other._w, other._h)

    __hash__ = None

    def __call__(self):
        return self

    def __repr__(self):
        return f"QRectF({self._x}, {self._y}, {self._w}, {self._h})"


def _bounds(points):
    """The smallest rectangle around the points, or a null one."""
    points = list(points)
    if not points:
        return QRectF()
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return QRectF(min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


class QLineF:
    def __init__(self, *args):
        if len(args) == 2:
            self._p1, self._p2 = QPointF(args[0]), QPointF(args[1])
        elif len(args) == 4:
            self._p1, self._p2 = QPointF(args[0], args[1]), QPointF(args[2], args[3])
        else:
            self._p1, self._p2 = QPointF(), QPointF()

    def p1(self):
        return self._p1

    def p2(self):
        return self._p2

    def length(self):
        return math.hypot(self._p2.x() - self._p1.x(), self._p2.y() - self._p1.y())


class QPolygonF:
    def __init__(self, points=None):
        self._points = [QPointF(p) if not isinstance(p, (tuple, list)) else QPointF(*p) for p in (points or [])]

    def append(self, point):
        self._points.append(QPointF(point))

    def __lshift__(self, point):
        self.append(point)
        return self

    def count(self):
        return len(self._points)

    size = count

    def __len__(self):
        return len(self._points)

    def __iter__(self):
        return iter(self._points)

    def __getitem__(self, index):
        return self._points[index]

    def at(self, index):
        return self._points[index]

    def isEmpty(self):
        return not self._points

    def boundingRect(self):
        return _bounds((p.x(), p.y()) for p in self._points)

    def translated(self, dx, dy=None):
        if dy is None:
            dx, dy = dx.x(), dx.y()
        return QPolygonF([QPointF(p.x() + dx, p.y() + dy) for p in self._points])


class QPainterPath:
    """A path of lines and curves, kept as SVG path commands with the points that bound it."""

    def __init__(self, start=None):
        self._commands = []      # SVG path data, one command each
        self._points = []        # every point and control point, for the bounding rectangle
        self._current = QPointF()
        self._start = QPointF()
        if start is not None:
            self.moveTo(start)

    @staticmethod
    def _point(args):
        return QPointF(args[0]) if len(args) == 1 else QPointF(args[0], args[1])

    def _add(self, command, *points):
        self._commands.append(command)
        self._points.extend((p.x(), p.y()) for p in points)

    def moveTo(self, *args):
        point = self._point(args)
        self._add(f"M{_number(point.x())},{_number(point.y())}", point)
        self._current = self._start = point

    def lineTo(self, *args):
        point = self._point(args)
        self._add(f"L{_number(point.x())},{_number(point.y())}", point)
        self._current = point

    def cubicTo(self, *args):
        if len(args) == 6:
            c1, c2, end = QPointF(args[0], args[1]), QPointF(args[2], args[3]), QPointF(args[4], args[5])
        else:
            c1, c2, end = (QPointF(a) for a in args)
        self._add("C" + " ".join(f"{_number(p.x())},{_number(p.y())}" for p in (c1, c2, end)), c1, c2, end)
        self._current = end

    def quadTo(self, *args):
        if len(args) == 4:
            c, end = QPointF(args[0], args[1]), QPointF(args[2], args[3])
        else:
            c, end = QPointF(args[0]), QPointF(args[1])
        self._add(f"Q{_number(c.x())},{_number(c.y())} {_number(end.x())},{_number(end.y())}", c, end)
        self._current = end

    def closeSubpath(self):
        self._commands.append("Z")
        self._current = self._start

    @staticmethod
    def _rect(args):
        return QRectF(args[0]) if len(args) == 1 else QRectF(*args[:4])

    def addRect(self, *args):
        r = self._rect(args)
        self.moveTo(r.left(), r.top())
        self.lineTo(r.right(), r.top())
        self.lineTo(r.right(), r.bottom())
        self.lineTo(r.left(), r.bottom())
        self.closeSubpath()

    def addRoundedRect(self, *args):
        """addRoundedRect(rect, xRadius, yRadius) or (x, y, w, h, xRadius, yRadius)."""
        if len(args) >= 6:
            r, rx, ry = QRectF(*args[:4]), float(args[4]), float(args[5])
        else:
            r, rx, ry = QRectF(args[0]), float(args[1]), float(args[2])
        rx, ry = max(0.0, min(rx, r.width() / 2.0)), max(0.0, min(ry, r.height() / 2.0))
        if rx == 0 or ry == 0:
            self.addRect(r)
            return
        left, top, right, bottom = r.left(), r.top(), r.right(), r.bottom()
        arc = f"A{_number(rx)},{_number(ry)} 0 0 1 "
        self._add(f"M{_number(left + rx)},{_number(top)}", QPointF(left, top), QPointF(right, bottom))
        self._commands += [
            f"H{_number(right - rx)}", arc + f"{_number(right)},{_number(top + ry)}",
            f"V{_number(bottom - ry)}", arc + f"{_number(right - rx)},{_number(bottom)}",
            f"H{_number(left + rx)}", arc + f"{_number(left)},{_number(bottom - ry)}",
            f"V{_number(top + ry)}", arc + f"{_number(left + rx)},{_number(top)}", "Z"]
        self._current = self._start = QPointF(left + rx, top)

    def addEllipse(self, *args):
        """addEllipse(rect), (x, y, w, h) or (center, rx, ry)."""
        if len(args) == 3:
            center, rx, ry = QPointF(args[0]), float(args[1]), float(args[2])
            r = QRectF(center.x() - rx, center.y() - ry, 2 * rx, 2 * ry)
        else:
            r = self._rect(args)
        rx, ry = r.width() / 2.0, r.height() / 2.0
        cx, cy = r.center().x(), r.center().y()
        arc = f"A{_number(rx)},{_number(ry)} 0 1 1 "
        self._add(f"M{_number(cx + rx)},{_number(cy)}", QPointF(r.left(), r.top()), QPointF(r.right(), r.bottom()))
        self._commands += [arc + f"{_number(cx - rx)},{_number(cy)}", arc + f"{_number(cx + rx)},{_number(cy)}", "Z"]
        self._current = self._start = QPointF(cx + rx, cy)

    def addPolygon(self, polygon):
        points = list(polygon)
        if not points:
            return
        self.moveTo(points[0])
        for point in points[1:]:
            self.lineTo(point)

    def addPath(self, other):
        self._commands += other._commands
        self._points += other._points

    def currentPosition(self):
        return QPointF(self._current)

    def isEmpty(self):
        return not self._commands

    def boundingRect(self):
        return _bounds(self._points)

    controlPointRect = boundingRect

    def translated(self, dx, dy=None):
        if dy is None:
            dx, dy = dx.x(), dx.y()
        moved = QPainterPath()
        moved._commands = [_translateCommand(c, dx, dy) for c in self._commands]
        moved._points = [(x + dx, y + dy) for x, y in self._points]
        return moved

    def _svg(self):
        return " ".join(self._commands)


def _translateCommand(command, dx, dy):
    """An SVG path command moved by (dx, dy)."""
    letter, rest = command[0], command[1:]
    if letter == "Z":
        return command
    if letter == "H":
        return f"H{_number(float(rest) + dx)}"
    if letter == "V":
        return f"V{_number(float(rest) + dy)}"
    if letter == "A":
        radii, flags, end = rest.split(" ")[0], " ".join(rest.split(" ")[1:4]), rest.split(" ")[4]
        x, y = (float(v) for v in end.split(","))
        return f"A{radii} {flags} {_number(x + dx)},{_number(y + dy)}"
    points = []
    for pair in rest.split(" "):
        x, y = (float(v) for v in pair.split(","))
        points.append(f"{_number(x + dx)},{_number(y + dy)}")
    return letter + " ".join(points)


class QPen:
    """QPen(), QPen(color), QPen(color, width[, style, cap, join]), QPen(Qt.NoPen) or QPen(brush, width)."""

    def __init__(self, *args):
        self._color = QColor(0, 0, 0)
        self._width = 1.0
        self._style = Qt.SolidLine
        self._cosmetic = False
        self._cap = Qt.SquareCap
        self._join = Qt.BevelJoin
        if not args:
            return
        first = args[0]
        if isinstance(first, QPen):
            self._color, self._width, self._style = QColor(first._color), first._width, first._style
            self._cosmetic, self._cap, self._join = first._cosmetic, first._cap, first._join
            return
        if isinstance(first, int) and not isinstance(first, bool) and len(args) == 1:
            self._style = first   # Qt.NoPen, Qt.DashLine, ...
            return
        if isinstance(first, QBrush):
            self._color = first.color()
        elif isinstance(first, QColor):
            self._color = QColor(first)
        elif isinstance(first, str):
            self._color = QColor(first)
        if len(args) > 1:
            self._width = float(args[1])
        if len(args) > 2:
            self._style = int(args[2])
        if len(args) > 3:
            self._cap = int(args[3])
        if len(args) > 4:
            self._join = int(args[4])

    def color(self):
        return QColor(self._color)

    def setColor(self, color):
        self._color = QColor(color)

    def brush(self):
        return QBrush(self._color)

    def setBrush(self, brush):
        self._color = brush.color()

    def width(self):
        return int(self._width)

    def widthF(self):
        return self._width

    def setWidth(self, width):
        self._width = float(width)

    setWidthF = setWidth

    def style(self):
        return self._style

    def setStyle(self, style):
        self._style = int(style)

    def isCosmetic(self):
        return self._cosmetic or self._width == 0

    def setCosmetic(self, cosmetic):
        self._cosmetic = bool(cosmetic)

    def capStyle(self):
        return self._cap

    def setCapStyle(self, cap):
        self._cap = int(cap)

    def joinStyle(self):
        return self._join

    def setJoinStyle(self, join):
        self._join = int(join)


class QPainter:
    """Only its render hints, which views take; nothing is painted with it here."""
    Antialiasing, TextAntialiasing, SmoothPixmapTransform, LosslessImageRendering = 0x01, 0x02, 0x04, 0x40
    HighQualityAntialiasing = 0x08


class QTransform:
    """The transform of a view: a scale on each axis and a translation (no rotation, no shear)."""

    def __init__(self, m11=1.0, m12=0.0, m21=0.0, m22=1.0, dx=0.0, dy=0.0):
        self._m11, self._m22, self._dx, self._dy = float(m11), float(m22), float(dx), float(dy)

    def m11(self):
        return self._m11

    def m22(self):
        return self._m22

    def m12(self):
        return 0.0

    def m21(self):
        return 0.0

    def dx(self):
        return self._dx

    def dy(self):
        return self._dy

    def isIdentity(self):
        return (self._m11, self._m22, self._dx, self._dy) == (1.0, 1.0, 0.0, 0.0)

    def map(self, point):
        return QPointF(point.x() * self._m11 + self._dx, point.y() * self._m22 + self._dy)

    def inverted(self):
        return QTransform(1.0 / self._m11, 0, 0, 1.0 / self._m22, -self._dx / self._m11, -self._dy / self._m22)

    def __call__(self):
        return self


# ---------------------------------------------------------------------------- text measurement

_measureContext = None
_pageFontFamily = None


def _fontPixels(font):
    """A font's size in pixels: Qt's point size at 96 dots per inch, as Qt draws on a screen."""
    return font.pointSizeF() * 96.0 / 72.0


def _pageFont():
    """The font the page draws text in, which the SVG text is drawn in too."""
    global _pageFontFamily
    if _pageFontFamily is None:
        _pageFontFamily = "sans-serif"
        window = dom.window()
        document = getattr(dom, "_document", None)
        if window is not None and document is not None and document.body is not None:
            try:
                _pageFontFamily = str(window.getComputedStyle(document.body).fontFamily) or "sans-serif"
            except Exception:
                pass
    return _pageFontFamily


def _cssFont(font):
    family = font.family() or _pageFont()
    return f"{'italic ' if font.italic() else ''}{600 if font.bold() else 400} {_fontPixels(font):.2f}px {family}"


def _measureLines(lines, font):
    """The width of each line and the height of a line, in pixels, as the page draws them."""
    global _measureContext
    pixels = _fontPixels(font)
    document = getattr(dom, "_document", None)
    if document is not None:
        try:
            if _measureContext is None:
                _measureContext = document.createElement("canvas").getContext("2d")
            _measureContext.font = _cssFont(font)
            widths, ascent, descent = [], 0.0, 0.0
            for line in lines:
                metrics = _measureContext.measureText(line or " ")
                widths.append(float(metrics.width) if line else 0.0)
                ascent = max(ascent, float(getattr(metrics, "fontBoundingBoxAscent", pixels * 0.95) or pixels * 0.95))
                descent = max(descent, float(getattr(metrics, "fontBoundingBoxDescent", pixels * 0.25) or pixels * 0.25))
            return widths, ascent + descent, ascent
        except Exception:
            pass
    # no page: an estimate from the size of the font
    return [0.55 * pixels * len(line) for line in lines], 1.2 * pixels, 0.95 * pixels


# ---------------------------------------------------------------------------- items

class QGraphicsItem:
    """An item of a scene: a group placed at its position, holding its shape and its child items."""

    ItemIsMovable, ItemIsSelectable, ItemIsFocusable, ItemClipsToShape = 0x1, 0x2, 0x4, 0x8
    ItemClipsChildrenToShape, ItemIgnoresTransformations, ItemIgnoresParentOpacity = 0x10, 0x20, 0x40
    ItemStacksBehindParent, ItemSendsGeometryChanges = 0x80, 0x800
    NoCache, DeviceCoordinateCache = 0, 1
    Type, UserType = 1, 65536

    _sequence = 0

    def __init__(self, parent=None):
        self._scene = None
        self._parent = None
        self._children = []
        self._z = 0.0
        self._pos = QPointF()
        self._rotation = 0.0
        self._scale = 1.0
        self._data = {}
        self._toolTip = ""
        self._visible = True
        self._opacity = 1.0
        self._flags = 0
        self._acceptedButtons = Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
        QGraphicsItem._sequence += 1
        self._order = QGraphicsItem._sequence   # the order items were made in: Qt's order for equal z values
        self._group = _svg("g")
        self._shape = self._makeShape()
        if self._shape is not None:
            self._group.appendChild(self._shape)
        self._childGroup = _svg("g")
        self._group.appendChild(self._childGroup)
        self._title = None
        if parent is not None:
            self.setParentItem(parent)

    def _makeShape(self):
        return None

    # --- where the item is, and over what
    def setPos(self, *args):
        self._pos = QPointF(args[0]) if len(args) == 1 else QPointF(args[0], args[1])
        self._updateTransform()

    def pos(self):
        return QPointF(self._pos)

    def x(self):
        return self._pos.x()

    def y(self):
        return self._pos.y()

    def setX(self, x):
        self.setPos(x, self._pos.y())

    def setY(self, y):
        self.setPos(self._pos.x(), y)

    def moveBy(self, dx, dy):
        self.setPos(self._pos.x() + dx, self._pos.y() + dy)

    def setRotation(self, degrees):
        self._rotation = float(degrees)
        self._updateTransform()

    def rotation(self):
        return self._rotation

    def setScale(self, factor):
        self._scale = float(factor)
        self._updateTransform()

    def scale(self):
        return self._scale

    def _updateTransform(self):
        transform = f"translate({_number(self._pos.x())} {_number(self._pos.y())})"
        if self._rotation:
            transform += f" rotate({_number(self._rotation)})"
        if self._scale != 1.0:
            transform += f" scale({_number(self._scale)})"
        self._group.setAttribute("transform", transform)

    def setZValue(self, z):
        self._z = float(z)
        self._restack()

    def zValue(self):
        return self._z

    def _restack(self):
        """Put the item among its siblings in the order of their z values."""
        siblings = self._parent._children if self._parent is not None else (self._scene._items if self._scene else None)
        container = self._parent._childGroup if self._parent is not None else (self._scene._root if self._scene else None)
        if siblings is None or container is None:
            return
        for item in sorted(siblings, key=lambda i: (i._z, i._order)):
            container.appendChild(item._group)

    def setParentItem(self, parent):
        if self._parent is parent:
            return
        if self._parent is not None:
            self._parent._children.remove(self)
        elif self._scene is not None and self in self._scene._items:
            self._scene._items.remove(self)
        self._group.remove()
        self._parent = parent
        if parent is not None:
            parent._children.append(self)
            parent._childGroup.appendChild(self._group)
            self._setScene(parent._scene)
            self._restack()

    def parentItem(self):
        return self._parent

    def childItems(self):
        return list(self._children)

    def topLevelItem(self):
        item = self
        while item._parent is not None:
            item = item._parent
        return item

    def scene(self):
        return self._scene

    def _setScene(self, scene):
        if self._scene is not None and self._scene is not scene:
            self._scene._registry.pop(id(self._group), None)
        self._scene = scene
        if scene is not None:
            scene._registry[id(self._group)] = self
            self._group.setAttribute("data-item", str(id(self._group)))
        for child in self._children:
            child._setScene(scene)

    # --- what the item says about itself
    def setData(self, key, value):
        self._data[int(key)] = value

    def data(self, key):
        return self._data.get(int(key))

    def setToolTip(self, text):
        self._toolTip = str(text or "")
        if self._title is None:
            self._title = _svg("title")
            first = getattr(self._group, "firstChild", None)
            if first and hasattr(self._group, "insertBefore"):
                self._group.insertBefore(self._title, first)
            else:
                self._group.appendChild(self._title)
        self._title.textContent = self._toolTip

    def toolTip(self):
        return self._toolTip

    def setVisible(self, visible):
        self._visible = bool(visible)
        self._group.setAttribute("display", "inline" if self._visible else "none")

    def isVisible(self):
        return self._visible and (self._parent is None or self._parent.isVisible())

    def show(self):
        self.setVisible(True)

    def hide(self):
        self.setVisible(False)

    def setOpacity(self, opacity):
        self._opacity = float(opacity)
        self._group.setAttribute("opacity", _number(self._opacity))

    def opacity(self):
        return self._opacity

    def setFlag(self, flag, enabled=True):
        self._flags = (self._flags | int(flag)) if enabled else (self._flags & ~int(flag))

    def setFlags(self, flags):
        self._flags = int(flags)

    def flags(self):
        return self._flags

    def setAcceptedMouseButtons(self, buttons):
        self._acceptedButtons = int(buttons)

    def acceptedMouseButtons(self):
        return self._acceptedButtons

    def setAcceptHoverEvents(self, enabled):
        pass

    def setCursor(self, cursor):
        pass

    def setSelected(self, selected):
        pass

    def isSelected(self):
        return False

    def setCacheMode(self, mode):
        pass

    def update(self, *args):
        pass

    def type(self):
        return self.Type

    # --- geometry
    def boundingRect(self):
        return QRectF()

    def _sceneOffset(self):
        x, y, item = 0.0, 0.0, self
        while item is not None:
            x, y, item = x + item._pos.x(), y + item._pos.y(), item._parent
        return x, y

    def sceneBoundingRect(self):
        x, y = self._sceneOffset()
        return self.boundingRect().translated(x, y)

    def _sceneBoundsWithChildren(self):
        if not self.isVisible():
            return QRectF()
        bounds = self.sceneBoundingRect()
        for child in self._children:
            bounds = bounds.united(child._sceneBoundsWithChildren())
        return bounds

    def scenePos(self):
        return QPointF(*self._sceneOffset())

    def mapToScene(self, *args):
        point = QPointF(args[0]) if len(args) == 1 else QPointF(args[0], args[1])
        x, y = self._sceneOffset()
        return QPointF(point.x() + x, point.y() + y)

    def mapFromScene(self, *args):
        point = QPointF(args[0]) if len(args) == 1 else QPointF(args[0], args[1])
        x, y = self._sceneOffset()
        return QPointF(point.x() - x, point.y() - y)

    def contains(self, point):
        return self.boundingRect().contains(point)


class QAbstractGraphicsShapeItem(QGraphicsItem):
    """An item with a pen and a brush: SVG stroke and fill."""

    def __init__(self, parent=None):
        self._pen = QPen()
        self._brush = QBrush()
        super().__init__(parent)
        self._applyPen()
        self._applyBrush()

    def setPen(self, pen):
        self._pen = QPen(pen)
        self._applyPen()

    def pen(self):
        return QPen(self._pen)

    def setBrush(self, brush):
        self._brush = QBrush(brush) if not isinstance(brush, QColor) else QBrush(brush)
        self._applyBrush()

    def brush(self):
        return QBrush(self._brush)

    def _applyPen(self):
        shape = self._shape
        if shape is None:
            return
        pen = self._pen
        if pen.style() == Qt.NoPen:
            shape.setAttribute("stroke", "none")
            return
        r, g, b, a = pen._color._rgba
        shape.setAttribute("stroke", f"rgb({r},{g},{b})")
        shape.setAttribute("stroke-opacity", _number(a / 255.0))
        shape.setAttribute("stroke-width", _number(pen.widthF() if pen.widthF() > 0 else 1.0))
        shape.setAttribute("stroke-linecap", {Qt.FlatCap: "butt", Qt.RoundCap: "round"}.get(pen.capStyle(), "square"))
        shape.setAttribute("stroke-linejoin", {Qt.MiterJoin: "miter", Qt.RoundJoin: "round"}.get(pen.joinStyle(), "bevel"))
        dashes = {Qt.DashLine: "4 2", Qt.DotLine: "1 2", Qt.DashDotLine: "4 2 1 2", Qt.DashDotDotLine: "4 2 1 2 1 2"}
        width = pen.widthF() if pen.widthF() > 0 else 1.0
        if pen.style() in dashes:
            shape.setAttribute("stroke-dasharray", " ".join(_number(float(v) * width) for v in dashes[pen.style()].split()))
        else:
            shape.setAttribute("stroke-dasharray", "none")
        # a cosmetic pen is as wide on the screen whatever the zoom
        shape.setAttribute("vector-effect", "non-scaling-stroke" if pen.isCosmetic() else "none")

    def _applyBrush(self):
        shape = self._shape
        if shape is None:
            return
        css = self._brush._css()
        shape.setAttribute("fill", css if css else "none")

    def _penMargin(self):
        if self._pen.style() == Qt.NoPen or self._pen.isCosmetic():
            return 0.0
        return self._pen.widthF() / 2.0

    def _withPen(self, rect):
        margin = self._penMargin()
        return rect.adjusted(-margin, -margin, margin, margin) if margin else rect


class QGraphicsPathItem(QAbstractGraphicsShapeItem):
    def __init__(self, *args):
        path = args[0] if args and isinstance(args[0], QPainterPath) else QPainterPath()
        parent = next((a for a in args if isinstance(a, QGraphicsItem)), None)
        self._path = path
        super().__init__(parent)
        self.setPath(path)

    def _makeShape(self):
        return _svg("path")

    def setPath(self, path):
        self._path = path
        self._shape.setAttribute("d", path._svg() or "M0,0")

    def path(self):
        return self._path

    def boundingRect(self):
        return self._withPen(self._path.boundingRect())


class QGraphicsPolygonItem(QAbstractGraphicsShapeItem):
    def __init__(self, *args):
        polygon = args[0] if args and isinstance(args[0], QPolygonF) else QPolygonF()
        parent = next((a for a in args if isinstance(a, QGraphicsItem)), None)
        self._polygon = polygon
        super().__init__(parent)
        self.setPolygon(polygon)

    def _makeShape(self):
        return _svg("polygon")

    def setPolygon(self, polygon):
        self._polygon = QPolygonF(list(polygon))
        self._shape.setAttribute("points", " ".join(f"{_number(p.x())},{_number(p.y())}" for p in self._polygon))

    def polygon(self):
        return QPolygonF(list(self._polygon))

    def boundingRect(self):
        return self._withPen(self._polygon.boundingRect())


class _RectShapeItem(QAbstractGraphicsShapeItem):
    def __init__(self, *args):
        numbers = [a for a in args if isinstance(a, (int, float)) and not isinstance(a, bool)]
        rect = next((a for a in args if isinstance(a, QRectF)), None)
        rect = rect if rect is not None else (QRectF(*numbers[:4]) if len(numbers) >= 4 else QRectF())
        parent = next((a for a in args if isinstance(a, QGraphicsItem)), None)
        self._rect = rect
        super().__init__(parent)
        self.setRect(rect)

    def setRect(self, *args):
        self._rect = QRectF(args[0]) if len(args) == 1 else QRectF(*args)
        self._applyRect()

    def rect(self):
        return QRectF(self._rect)

    def boundingRect(self):
        return self._withPen(self._rect)


class QGraphicsRectItem(_RectShapeItem):
    def _makeShape(self):
        return _svg("rect")

    def _applyRect(self):
        r = self._rect
        for name, value in (("x", r.x()), ("y", r.y()), ("width", max(r.width(), 0)), ("height", max(r.height(), 0))):
            self._shape.setAttribute(name, _number(value))


class QGraphicsEllipseItem(_RectShapeItem):
    def _makeShape(self):
        return _svg("ellipse")

    def _applyRect(self):
        r = self._rect
        for name, value in (("cx", r.center().x()), ("cy", r.center().y()), ("rx", abs(r.width()) / 2.0),
                            ("ry", abs(r.height()) / 2.0)):
            self._shape.setAttribute(name, _number(value))


class QGraphicsLineItem(QAbstractGraphicsShapeItem):
    def __init__(self, *args):
        numbers = [a for a in args if isinstance(a, (int, float)) and not isinstance(a, bool)]
        line = next((a for a in args if isinstance(a, QLineF)), None)
        self._line = line if line is not None else (QLineF(*numbers[:4]) if len(numbers) >= 4 else QLineF())
        parent = next((a for a in args if isinstance(a, QGraphicsItem)), None)
        super().__init__(parent)
        self.setLine(self._line)

    def _makeShape(self):
        return _svg("line")

    def setLine(self, *args):
        self._line = args[0] if len(args) == 1 else QLineF(*args)
        for name, value in (("x1", self._line.p1().x()), ("y1", self._line.p1().y()),
                            ("x2", self._line.p2().x()), ("y2", self._line.p2().y())):
            self._shape.setAttribute(name, _number(value))

    def line(self):
        return self._line

    def _applyBrush(self):
        if self._shape is not None:
            self._shape.setAttribute("fill", "none")

    def boundingRect(self):
        p1, p2 = self._line.p1(), self._line.p2()
        return self._withPen(_bounds([(p1.x(), p1.y()), (p2.x(), p2.y())]))


class QGraphicsSimpleTextItem(QAbstractGraphicsShapeItem):
    """Text, one line per line of it, drawn with its top left corner at the item's position."""

    def __init__(self, *args):
        self._text = next((str(a) for a in args if isinstance(a, str)), "")
        self._font = QFont()
        parent = next((a for a in args if isinstance(a, QGraphicsItem)), None)
        super().__init__(parent)
        self._brush = QBrush(QColor(0, 0, 0))
        self._pen = QPen(Qt.NoPen)
        self._applyPen()
        self._applyBrush()
        self._layout()

    def _makeShape(self):
        text = _svg("text")
        text.setAttribute("style", "user-select: none")
        return text

    def setText(self, text):
        self._text = str(text)
        self._layout()

    def text(self):
        return self._text

    def setFont(self, font):
        self._font = QFont(font)
        self._layout()

    def font(self):
        return QFont(self._font)

    def _layout(self):
        """Lay the text out in lines, measured with the page's font: the size boundingRect() gives."""
        lines = self._text.split("\n")
        widths, lineHeight, ascent = _measureLines(lines, self._font)
        self._size = QSizeF(max(widths) if widths else 0.0, lineHeight * len(lines))
        shape = self._shape
        shape.setAttribute("font-size", _number(_fontPixels(self._font)))
        shape.setAttribute("font-family", self._font.family() or _pageFont())
        shape.setAttribute("font-weight", "600" if self._font.bold() else "400")
        shape.setAttribute("font-style", "italic" if self._font.italic() else "normal")
        # the lines drawn before go (JavaScript's null is not None in Python, so no loop over firstChild)
        if hasattr(shape, "children_"):
            shape.children_ = []
        else:
            shape.textContent = ""
        for index, line in enumerate(lines):
            span = _svg("tspan")
            span.setAttribute("x", "0")
            span.setAttribute("y", _number(index * lineHeight + ascent))
            span.textContent = line
            shape.appendChild(span)

    def boundingRect(self):
        return QRectF(0, 0, self._size.width(), self._size.height())


class QGraphicsTextItem(QGraphicsSimpleTextItem):
    """Plain text: what a QGraphicsTextItem shows when it is not given HTML."""

    def setPlainText(self, text):
        self.setText(text)

    def toPlainText(self):
        return self.text()

    def setHtml(self, html):
        import re

        self.setText(re.sub(r"<[^>]+>", "", str(html).replace("<br>", "\n").replace("<br/>", "\n")))

    def setDefaultTextColor(self, color):
        self.setBrush(QBrush(color))

    def defaultTextColor(self):
        return self._brush.color()


class QGraphicsItemGroup(QGraphicsItem):
    def addToGroup(self, item):
        item.setParentItem(self)

    def removeFromGroup(self, item):
        item.setParentItem(None)
        if self._scene is not None:
            self._scene.addItem(item)

    def boundingRect(self):
        bounds = QRectF()
        for child in self._children:
            bounds = bounds.united(child.boundingRect().translated(child._pos.x(), child._pos.y()))
        return bounds


# ---------------------------------------------------------------------------- scene and view

class QGraphicsScene(QObject):
    """The items, in an SVG group that the view showing the scene holds."""

    changed = Signal("changed(QList<QRectF>)")
    selectionChanged = Signal("selectionChanged()")
    sceneRectChanged = Signal("sceneRectChanged(QRectF)")

    def __init__(self, *args):
        super().__init__(next((a for a in args if isinstance(a, QObject)), None))
        self._items = []          # the top-level items
        self._registry = {}       # id of an item's group -> the item, for finding the item of an element
        self._root = _svg("g")
        self._sceneRect = None
        self._backgroundBrush = QBrush()
        numbers = [a for a in args if isinstance(a, (int, float)) and not isinstance(a, bool)]
        if len(numbers) >= 4:
            self._sceneRect = QRectF(*numbers[:4])
        elif args and isinstance(args[0], QRectF):
            self._sceneRect = QRectF(args[0])

    def addItem(self, item):
        if item._scene is self and item._parent is None and item in self._items:
            return
        if item._parent is not None:
            item.setParentItem(None)
        elif item._scene is not None:
            item._scene.removeItem(item)
        self._items.append(item)
        self._root.appendChild(item._group)
        item._setScene(self)
        item._restack()

    def removeItem(self, item):
        if item._parent is not None:
            item.setParentItem(None)
        if item in self._items:
            self._items.remove(item)
        item._group.remove()
        item._setScene(None)

    def clear(self):
        for item in list(self._items):
            self.removeItem(item)

    def items(self, *args):
        """Every item, the ones on top first (Qt's default order)."""
        result = []

        def collect(item):
            result.append(item)
            for child in item._children:
                collect(child)

        for item in self._items:
            collect(item)
        return sorted(result, key=lambda i: (i._z, i._order), reverse=True)

    def addPath(self, path, pen=None, brush=None):
        return self._addShape(QGraphicsPathItem(path), pen, brush)

    def addPolygon(self, polygon, pen=None, brush=None):
        return self._addShape(QGraphicsPolygonItem(polygon), pen, brush)

    def addEllipse(self, *args):
        rect, pen, brush = self._rectAndStyle(args)
        return self._addShape(QGraphicsEllipseItem(rect), pen, brush)

    def addRect(self, *args):
        rect, pen, brush = self._rectAndStyle(args)
        return self._addShape(QGraphicsRectItem(rect), pen, brush)

    def addLine(self, *args):
        numbers = [a for a in args if isinstance(a, (int, float)) and not isinstance(a, bool)]
        line = next((a for a in args if isinstance(a, QLineF)), None) or QLineF(*numbers[:4])
        pen = next((a for a in args if isinstance(a, QPen)), None)
        return self._addShape(QGraphicsLineItem(line), pen, None)

    def addSimpleText(self, text, font=None):
        item = QGraphicsSimpleTextItem(text)
        if font is not None:
            item.setFont(font)
        self.addItem(item)
        return item

    def addText(self, text, font=None):
        item = QGraphicsTextItem(text)
        if font is not None:
            item.setFont(font)
        self.addItem(item)
        return item

    @staticmethod
    def _rectAndStyle(args):
        numbers = [a for a in args if isinstance(a, (int, float)) and not isinstance(a, bool)]
        rect = next((a for a in args if isinstance(a, QRectF)), None) or QRectF(*numbers[:4])
        pen = next((a for a in args if isinstance(a, QPen)), None)
        brush = next((a for a in args if isinstance(a, QBrush)), None)
        return rect, pen, brush

    def _addShape(self, item, pen, brush):
        if pen is not None:
            item.setPen(pen)
        if brush is not None:
            item.setBrush(brush)
        self.addItem(item)
        return item

    def itemsBoundingRect(self):
        bounds = QRectF()
        for item in self._items:
            bounds = bounds.united(item._sceneBoundsWithChildren())
        return bounds

    def setSceneRect(self, *args):
        self._sceneRect = QRectF(args[0]) if len(args) == 1 else QRectF(*args)
        self.sceneRectChanged.emit(self._sceneRect)

    def sceneRect(self):
        return QRectF(self._sceneRect) if self._sceneRect is not None else self.itemsBoundingRect()

    def width(self):
        return self.sceneRect().width()

    def height(self):
        return self.sceneRect().height()

    def setBackgroundBrush(self, brush):
        self._backgroundBrush = QBrush(brush)

    def backgroundBrush(self):
        return QBrush(self._backgroundBrush)

    def itemAt(self, *args):
        """The topmost item whose bounding rectangle holds a scene point (the page is not asked here)."""
        point = QPointF(args[0]) if args and hasattr(args[0], "x") else QPointF(args[0], args[1])
        for item in self.items():
            if item.isVisible() and item.sceneBoundingRect().contains(point):
                return item
        return None

    def views(self):
        return [self._view] if getattr(self, "_view", None) is not None else []

    def selectedItems(self):
        return []

    def clearSelection(self):
        pass

    def update(self, *args):
        pass


class _MouseEvent:
    """What a view's mouse handlers get: positions in the view, the button and the modifiers."""

    def __init__(self, pos, button, buttons, modifiers, delta=None):
        self._pos, self._button, self._buttons, self._modifiers = pos, button, buttons, modifiers
        self._delta = delta
        self._accepted = True

    def pos(self):
        return QPointF(self._pos)

    position = pos

    def x(self):
        return self._pos.x()

    def y(self):
        return self._pos.y()

    def button(self):
        return self._button

    def buttons(self):
        return self._buttons

    def modifiers(self):
        return self._modifiers

    def angleDelta(self):
        return QPoint(0, int(self._delta or 0))

    def pixelDelta(self):
        return QPoint(0, int(self._delta or 0))

    def delta(self):
        return int(self._delta or 0)

    def accept(self):
        self._accepted = True

    def ignore(self):
        self._accepted = False

    def isAccepted(self):
        return self._accepted


class _Viewport:
    """view.viewport(): the drawing area, its size as rect (a Qt property, also callable)."""

    def __init__(self, view):
        self._view = view

    @property
    def rect(self):
        width, height = self._view._viewportSize()
        return QRect(0, 0, width, height)

    def width(self):
        return self._view._viewportSize()[0]

    def height(self):
        return self._view._viewportSize()[1]

    def size(self):
        return self.rect.size()

    def setCursor(self, cursor):
        pass

    def update(self, *args):
        pass


def _makeQGraphicsView():
    from .widgets import QWidget

    class QGraphicsView(QWidget):
        """A view of a scene: an <svg> that shows the scene's group through the view's transform."""

        NoDrag, ScrollHandDrag, RubberBandDrag = 0, 1, 2
        NoAnchor, AnchorViewCenter, AnchorUnderMouse = 0, 1, 2
        FullViewportUpdate, MinimalViewportUpdate, SmartViewportUpdate, NoViewportUpdate, BoundingRectViewportUpdate = 0, 1, 2, 3, 4
        CacheNone, CacheBackground = 0, 1

        _tag = "div"
        # (sized inline: the page's stylesheet has only the classes its own sources use)
        _classes = "sw-graphics-view rounded border border-input"
        _style = "position:relative; width:100%; min-height:240px; flex:1 1 auto; overflow:hidden"

        #: The size a view is laid out at before the page has given it one
        DEFAULT_SIZE = (400, 300)

        def __init__(self, *args):
            parent = next((a for a in args if isinstance(a, QWidget)), None)
            super().__init__(parent)
            self._scene = None
            self._sx = self._sy = 1.0
            self._tx = self._ty = 0.0
            self._dragMode = self.NoDrag
            self._transformationAnchor = self.AnchorViewCenter
            self._resizeAnchor = self.NoAnchor
            self._renderHints = QPainter.TextAntialiasing
            self._mouse = None            # where the mouse is, in the view
            self._panFrom = None          # where a ScrollHandDrag drag is, in the view
            self._viewport = _Viewport(self)
            self._el.setAttribute("style", self._style)
            self._svg = _svg("svg")
            self._svg.setAttribute("width", "100%")
            self._svg.setAttribute("height", "100%")
            self._svg.setAttribute("style", "display:block; position:absolute; inset:0; touch-action:none; user-select:none")
            self._transformGroup = _svg("g")
            self._svg.appendChild(self._transformGroup)
            self._el.appendChild(self._svg)
            self._applyTransform()
            self._listen()
            scene = next((a for a in args if isinstance(a, QGraphicsScene)), None)
            if scene is not None:
                self.setScene(scene)

        # --- events of the page, handed to the view's (overridable) handlers
        def _listen(self):
            if getattr(dom, "_document", None) is None or getattr(dom, "create_proxy", None) is None:
                return
            if not hasattr(self, "_listeners"):
                self._listeners = []
            for name, handler in (("pointerdown", self._onPointerDown), ("pointermove", self._onPointerMove),
                                  ("pointerup", self._onPointerUp), ("pointercancel", self._onPointerUp),
                                  ("pointerleave", self._onPointerLeave), ("wheel", self._onWheel)):
                proxy = dom.create_proxy(handler)
                self._el.addEventListener(name, proxy)
                self._listeners.append((name, proxy))

        def _eventPos(self, event):
            rect = self._svg.getBoundingClientRect()
            return QPointF(float(event.clientX) - float(rect.left), float(event.clientY) - float(rect.top))

        @staticmethod
        def _modifiers(event):
            return ((Qt.ShiftModifier if event.shiftKey else 0) | (Qt.ControlModifier if event.ctrlKey else 0)
                    | (Qt.AltModifier if event.altKey else 0))

        @staticmethod
        def _button(event):
            return {0: Qt.LeftButton, 1: Qt.MiddleButton, 2: Qt.RightButton}.get(int(event.button), Qt.NoButton)

        @staticmethod
        def _buttons(event):
            buttons, mask = 0, int(event.buttons)
            for bit, button in ((1, Qt.LeftButton), (2, Qt.RightButton), (4, Qt.MiddleButton)):
                if mask & bit:
                    buttons |= button
            return buttons

        def _onPointerDown(self, event):
            try:
                self._el.setPointerCapture(event.pointerId)
            except Exception:
                pass
            self._mouse = self._eventPos(event)
            self.mousePressEvent(_MouseEvent(self._mouse, self._button(event), self._buttons(event), self._modifiers(event)))

        def _onPointerMove(self, event):
            self._mouse = self._eventPos(event)
            self.mouseMoveEvent(_MouseEvent(self._mouse, Qt.NoButton, self._buttons(event), self._modifiers(event)))

        def _onPointerUp(self, event):
            self._mouse = self._eventPos(event)
            try:
                self._el.releasePointerCapture(event.pointerId)
            except Exception:
                pass
            self.mouseReleaseEvent(_MouseEvent(self._mouse, self._button(event), self._buttons(event), self._modifiers(event)))

        def _onPointerLeave(self, event):
            if self._panFrom is None:
                self._mouse = None

        def _onWheel(self, event):
            event.preventDefault()
            self._mouse = self._eventPos(event)
            # A wheel notch is 120 eighths of a degree to Qt, away from the user positive; a page
            # says how far it scrolls, in pixels (deltaMode 0) or lines, down positive
            delta = float(event.deltaY) * (1.0 if int(event.deltaMode) == 0 else 33.0)
            self.wheelEvent(_MouseEvent(self._mouse, Qt.NoButton, self._buttons(event), self._modifiers(event),
                                        delta=-delta * 1.2))

        # --- the default handlers (a subclass calls them as qt.QGraphicsView.mousePressEvent(self, event))
        def mousePressEvent(self, event):
            if self._dragMode == self.ScrollHandDrag and event.button() == Qt.LeftButton:
                self._panFrom = event.pos()
                self._el.style.cursor = "grabbing"

        def mouseMoveEvent(self, event):
            if self._panFrom is not None:
                moved = event.pos() - self._panFrom
                self._panFrom = event.pos()
                self._tx += moved.x()
                self._ty += moved.y()
                self._applyTransform()

        def mouseReleaseEvent(self, event):
            if self._panFrom is not None:
                self._panFrom = None
                self._el.style.cursor = "grab" if self._dragMode == self.ScrollHandDrag else ""

        def mouseDoubleClickEvent(self, event):
            pass

        def wheelEvent(self, event):
            """Qt scrolls on the wheel by default: the scene is moved up or down."""
            self._ty += event.angleDelta().y() / 3.0
            self._applyTransform()

        # --- the scene
        def setScene(self, scene):
            if self._scene is scene:
                return
            if self._scene is not None:
                self._scene._root.remove()
                self._scene._view = None
            self._scene = scene
            if scene is not None:
                scene._view = self
                self._transformGroup.appendChild(scene._root)

        def scene(self):
            return self._scene

        def setRenderHint(self, hint, enabled=True):
            self._renderHints = (self._renderHints | int(hint)) if enabled else (self._renderHints & ~int(hint))
            antialiased = bool(self._renderHints & QPainter.Antialiasing)
            self._svg.setAttribute("shape-rendering", "geometricPrecision" if antialiased else "crispEdges")

        def setRenderHints(self, hints):
            self._renderHints = 0
            self.setRenderHint(hints, True)

        def renderHints(self):
            return self._renderHints

        def setDragMode(self, mode):
            self._dragMode = int(mode)
            self._el.style.cursor = "grab" if self._dragMode == self.ScrollHandDrag else ""

        def dragMode(self):
            return self._dragMode

        def setTransformationAnchor(self, anchor):
            self._transformationAnchor = int(anchor)

        def transformationAnchor(self):
            return self._transformationAnchor

        def setResizeAnchor(self, anchor):
            self._resizeAnchor = int(anchor)

        def setBackgroundBrush(self, brush):
            css = QBrush(brush)._css()
            self._svg.style.backgroundColor = css or ""

        def setViewportUpdateMode(self, mode):
            pass

        def setOptimizationFlag(self, *args):
            pass

        def setOptimizationFlags(self, *args):
            pass

        def setCacheMode(self, mode):
            pass

        def setInteractive(self, interactive):
            pass

        def setAlignment(self, alignment):
            pass

        def setFrameShape(self, shape):
            pass

        def setHorizontalScrollBarPolicy(self, policy):
            pass

        def setVerticalScrollBarPolicy(self, policy):
            pass

        def setMouseTracking(self, enabled):
            pass

        def viewport(self):
            return self._viewport

        def _viewportSize(self):
            width = height = 0
            try:
                width, height = int(self._svg.clientWidth), int(self._svg.clientHeight)
            except Exception:
                pass
            if width <= 0 or height <= 0:
                width, height = self.DEFAULT_SIZE
            return width, height

        # --- the transform: view = scene * scale + translation
        def _applyTransform(self):
            self._transformGroup.setAttribute(
                "transform", f"matrix({_number(self._sx)} 0 0 {_number(self._sy)} {_number(self._tx)} {_number(self._ty)})")

        def _anchor(self):
            """The point of the view that stays put when the view is scaled."""
            if self._transformationAnchor == self.AnchorUnderMouse and self._mouse is not None:
                return self._mouse
            width, height = self._viewportSize()
            return QPointF(width / 2.0, height / 2.0)

        def scale(self, sx, sy=None):
            sy = sx if sy is None else sy
            anchor = self._anchor()
            scenePoint = self.mapToScene(anchor)
            self._sx *= float(sx)
            self._sy *= float(sy)
            self._tx = anchor.x() - scenePoint.x() * self._sx
            self._ty = anchor.y() - scenePoint.y() * self._sy
            self._applyTransform()

        def resetTransform(self):
            center = self.mapToScene(QPointF(*(v / 2.0 for v in self._viewportSize())))
            self._sx = self._sy = 1.0
            self.centerOn(center)

        def setTransform(self, transform, combine=False):
            if combine:
                self._sx *= transform.m11()
                self._sy *= transform.m22()
            else:
                self._sx, self._sy = transform.m11(), transform.m22()
                self._tx, self._ty = transform.dx(), transform.dy()
            self._applyTransform()

        def transform(self):
            return QTransform(self._sx, 0, 0, self._sy, self._tx, self._ty)

        def translate(self, dx, dy):
            self._tx += float(dx) * self._sx
            self._ty += float(dy) * self._sy
            self._applyTransform()

        def mapToScene(self, *args):
            point = QPointF(args[0]) if len(args) == 1 else QPointF(args[0], args[1])
            return QPointF((point.x() - self._tx) / self._sx, (point.y() - self._ty) / self._sy)

        def mapFromScene(self, *args):
            point = QPointF(args[0]) if len(args) == 1 else QPointF(args[0], args[1])
            return QPointF(point.x() * self._sx + self._tx, point.y() * self._sy + self._ty)

        def centerOn(self, *args):
            if args and isinstance(args[0], QGraphicsItem):
                point = args[0].sceneBoundingRect().center()
            else:
                point = QPointF(args[0]) if len(args) == 1 else QPointF(args[0], args[1])
            width, height = self._viewportSize()
            self._tx = width / 2.0 - point.x() * self._sx
            self._ty = height / 2.0 - point.y() * self._sy
            self._applyTransform()

        def ensureVisible(self, *args):
            """Move the view the least that shows an item or a rectangle, with margins (50 by default)."""
            target = args[0]
            rest = list(args[1:])
            if isinstance(target, QGraphicsItem):
                rect = target.sceneBoundingRect()
            elif isinstance(target, QRectF):
                rect = target
            else:
                rect = QRectF(*args[:4])
                rest = list(args[4:])
            xmargin = float(rest[0]) if len(rest) > 0 else 50.0
            ymargin = float(rest[1]) if len(rest) > 1 else 50.0
            width, height = self._viewportSize()
            topLeft = self.mapFromScene(rect.topLeft())
            bottomRight = self.mapFromScene(rect.bottomRight())
            dx = dy = 0.0
            if topLeft.x() - xmargin < 0:
                dx = xmargin - topLeft.x()
            elif bottomRight.x() + xmargin > width:
                dx = max(width - xmargin - bottomRight.x(), xmargin - topLeft.x())
            if topLeft.y() - ymargin < 0:
                dy = ymargin - topLeft.y()
            elif bottomRight.y() + ymargin > height:
                dy = max(height - ymargin - bottomRight.y(), ymargin - topLeft.y())
            if dx or dy:
                self._tx += dx
                self._ty += dy
                self._applyTransform()

        def fitInView(self, *args):
            """Scale and move the view so that a rectangle or an item fills it (aspect kept if asked)."""
            target = args[0]
            if isinstance(target, QGraphicsItem):
                rect, rest = target.sceneBoundingRect(), list(args[1:])
            elif isinstance(target, QRectF):
                rect, rest = target, list(args[1:])
            else:
                rect, rest = QRectF(*args[:4]), list(args[4:])
            mode = int(rest[0]) if rest else Qt.IgnoreAspectRatio
            if rect.isEmpty():
                return
            width, height = self._viewportSize()
            sx, sy = width / rect.width(), height / rect.height()
            if mode == Qt.KeepAspectRatio:
                sx = sy = min(sx, sy)
            elif mode == Qt.KeepAspectRatioByExpanding:
                sx = sy = max(sx, sy)
            self._sx, self._sy = sx, sy
            self.centerOn(rect.center())

        def itemAt(self, *args):
            """The topmost item at a point of the view: the page says which element is there."""
            point = QPointF(args[0]) if len(args) == 1 else QPointF(args[0], args[1])
            if self._scene is None:
                return None
            document = getattr(dom, "_document", None)
            if document is not None:
                rect = self._svg.getBoundingClientRect()
                element = document.elementFromPoint(float(rect.left) + point.x(), float(rect.top) + point.y())
                # (the page's null is falsy, not None)
                while element and element != self._svg:
                    key = element.getAttribute("data-item") if hasattr(element, "getAttribute") else None
                    if key:
                        item = self._scene._registry.get(int(key))
                        if item is not None:
                            return item
                    element = element.parentNode
                return None
            return self._scene.itemAt(self.mapToScene(point))

        def items(self, *args):
            if not args:
                return self._scene.items() if self._scene is not None else []
            item = self.itemAt(*args)
            return [item] if item is not None else []

        def sizeHint(self):
            return QRect(0, 0, *self.DEFAULT_SIZE).size()

    return QGraphicsView


QGraphicsView = _makeQGraphicsView()

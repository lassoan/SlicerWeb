"""QObject, signals and properties with PythonQt semantics.

PythonQt (used by desktop Slicer) exposes Qt properties as Python attributes (``slider.value = 3``,
``combo.currentIndex``), signals as attributes with ``connect()`` (``button.clicked.connect(f)``) and
also accepts ``obj.connect("clicked(bool)", f)``. This module provides the same behavior so that
scripted module code runs unchanged.
"""

import logging
import weakref

logger = logging.getLogger("slicerweb.qt")


class BoundSignal:
    def __init__(self, owner, name):
        self._owner = weakref.ref(owner)
        self._name = name
        self._slots = []

    def connect(self, slot, *args):
        if slot not in self._slots:
            self._slots.append(slot)
        return True

    def disconnect(self, slot=None):
        if slot is None:
            self._slots.clear()
        elif slot in self._slots:
            self._slots.remove(slot)

    def emit(self, *args):
        owner = self._owner()
        if owner is not None and getattr(owner, "_signalsBlocked", False):
            return
        for slot in list(self._slots):
            try:
                _call_slot(slot, args)
            except Exception:
                logger.exception("Error in slot connected to %s", self._name)

    def __call__(self, *args):  # PythonQt allows calling a signal to emit it
        self.emit(*args)


def _call_slot(slot, args):
    """Call a slot with as many arguments as it accepts (Qt drops extra signal arguments)."""
    import inspect

    try:
        sig = inspect.signature(slot)
        params = [p for p in sig.parameters.values() if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
        has_varargs = any(p.kind == p.VAR_POSITIONAL for p in sig.parameters.values())
        if not has_varargs:
            args = args[: len(params)]
    except (TypeError, ValueError):
        pass
    return slot(*args)


class Signal:
    """Class-level signal declaration: ``clicked = Signal("clicked(bool)")``."""

    def __init__(self, signature=""):
        self.signature = signature

    def __set_name__(self, owner, name):
        self.name = name

    def __get__(self, obj, owner=None):
        if obj is None:
            return self
        signals = obj.__dict__.setdefault("_bound_signals", {})
        bound = signals.get(self.name)
        if bound is None:
            bound = signals[self.name] = BoundSignal(obj, self.name)
        return bound


class QProp:
    """Qt property exposed as a Python attribute (PythonQt style).

    :param default: initial value
    :param el: name of the element property to update (custom element property), or None
    :param signal: name of a signal emitted when the value changes, or None
    :param convert: function applied to assigned values
    """

    def __init__(self, default=None, el=None, signal=None, convert=None):
        self.default = default
        self.el = el
        self.signal = signal
        self.convert = convert

    def __set_name__(self, owner, name):
        self.name = name
        self.attr = "_qp_" + name

    def __get__(self, obj, owner=None):
        if obj is None:
            return self
        return obj.__dict__.get(self.attr, self.default)

    def __set__(self, obj, value):
        if self.convert is not None and value is not None:
            value = self.convert(value)
        old = obj.__dict__.get(self.attr, self.default)
        obj.__dict__[self.attr] = value
        if self.el:
            obj._setElementProperty(self.el, value)
        obj._propertyChanged(self.name, value)
        if self.signal and old != value:
            getattr(obj, self.signal).emit(value)

    def set_silently(self, obj, value):
        """Set from the user interface: store and emit, without updating the element."""
        if self.convert is not None and value is not None:
            value = self.convert(value)
        old = obj.__dict__.get(self.attr, self.default)
        obj.__dict__[self.attr] = value
        if self.signal and old != value:
            getattr(obj, self.signal).emit(value)


class QObject:
    destroyed = Signal("destroyed()")
    objectNameChanged = Signal("objectNameChanged(QString)")

    def __init__(self, parent=None, *args, **kwargs):
        self._parent = None
        self._children = []
        self._objectName = ""
        self._dynamicProperties = {}
        self._signalsBlocked = False
        if parent is not None:
            self.setParent(parent)

    # --- object tree
    def setParent(self, parent):
        if self._parent is not None and self in self._parent._children:
            self._parent._children.remove(self)
        self._parent = parent
        if parent is not None and self not in parent._children:
            parent._children.append(self)

    def parent(self):
        return self._parent

    def children(self):
        return list(self._children)

    def findChild(self, cls, name=""):
        for child in self.findChildren(cls, name):
            return child
        return None

    def findChildren(self, cls=None, name=""):
        result = []
        stack = list(self._children)
        while stack:
            c = stack.pop(0)
            if (cls is None or isinstance(c, cls)) and (not name or c._objectName == name):
                result.append(c)
            stack.extend(c._children)
        return result

    # --- names and properties
    @property
    def objectName(self):
        return self._objectName

    @objectName.setter
    def objectName(self, value):
        self.setObjectName(value)

    @property
    def name(self):  # PythonQt exposes objectName as "name"
        return self._objectName

    @name.setter
    def name(self, value):
        self.setObjectName(value)

    def setObjectName(self, value):
        self._objectName = str(value)
        self.objectNameChanged.emit(self._objectName)

    def className(self):
        return type(self).__name__

    def metaObject(self):
        return _MetaObject(type(self).__name__)

    def inherits(self, className):
        return any(c.__name__ == className for c in type(self).__mro__)

    def setProperty(self, name, value):
        descriptor = getattr(type(self), name, None)
        if isinstance(descriptor, (QProp, property)):
            setattr(self, name, value)
        else:
            self._dynamicProperties[name] = value
        return True

    def property(self, name):
        descriptor = getattr(type(self), name, None)
        if isinstance(descriptor, (QProp, property)):
            return getattr(self, name)
        return self._dynamicProperties.get(name)

    def dynamicPropertyNames(self):
        return list(self._dynamicProperties)

    # --- signals
    def connect(self, *args):
        """PythonQt connect: obj.connect("signal(args)", slot) or obj.connect(sender, "signal()", slot)."""
        if len(args) == 2:
            signal, slot = args
            return self._signal(signal).connect(slot)
        if len(args) >= 3:
            sender, signal, slot = args[:3]
            return sender._signal(signal).connect(slot)
        raise TypeError("connect() expects (signal, slot) or (sender, signal, slot)")

    def disconnect(self, *args):
        if not args:
            for s in self.__dict__.get("_bound_signals", {}).values():
                s.disconnect()
            return
        if len(args) == 2:
            signal, slot = args
            self._signal(signal).disconnect(slot)
        elif len(args) == 1:
            self._signal(args[0]).disconnect()
        else:
            sender, signal, slot = args[:3]
            sender._signal(signal).disconnect(slot)

    def _signal(self, signature):
        name = signature.split("(")[0].strip()
        signal = getattr(self, name, None)
        if not isinstance(signal, BoundSignal):
            # Unknown signal: create a silent one so that connections do not fail
            signals = self.__dict__.setdefault("_bound_signals", {})
            signal = signals.setdefault(name, BoundSignal(self, name))
        return signal

    def blockSignals(self, block):
        previous = self._signalsBlocked
        self._signalsBlocked = bool(block)
        return previous

    def signalsBlocked(self):
        return self._signalsBlocked

    def deleteLater(self):
        self.setParent(None)
        self.destroyed.emit()

    def installEventFilter(self, obj):
        pass

    def removeEventFilter(self, obj):
        pass

    def tr(self, text, *args):
        return text

    # hooks for widgets
    def _setElementProperty(self, name, value):
        pass

    def _propertyChanged(self, name, value):
        pass


class _MetaObject:
    def __init__(self, name):
        self._name = name

    def className(self):
        return self._name


# ---------------------------------------------------------------------------- property values
# PythonQt exposes Qt properties as attributes (widget.currentNodeID, slicer.app.majorVersion), while
# a getter with the same name is also callable in Slicer code (widget.currentNodeID()). Values of
# such properties are returned as str/int subclasses that return themselves when called.
class _CallableStr(str):
    def __call__(self):
        return str(self)


class _CallableInt(int):
    def __call__(self):
        return int(self)


class _CallableFloat(float):
    def __call__(self):
        return float(self)


def property_value(value):
    """Value of a Qt property, usable both as attribute and as getter call."""
    if value is None:
        return _CallableStr("")
    if isinstance(value, bool):
        return _CallableInt(int(value))
    if isinstance(value, int):
        return _CallableInt(value)
    if isinstance(value, float):
        return _CallableFloat(value)
    if isinstance(value, str):
        return _CallableStr(value)
    return value

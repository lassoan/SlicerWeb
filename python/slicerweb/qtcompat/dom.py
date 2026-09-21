"""Minimal DOM access for the Qt compatibility layer.

In the browser the real DOM is used (Pyodide ``js`` module). Elsewhere (Node.js tests, desktop
Slicer) a small in-memory element implementation is used so that module GUIs can still be created
and their logic exercised.
"""

try:  # pragma: no cover - browser only
    import js
    from pyodide.ffi import create_proxy, to_js

    _document = js.document if hasattr(js, "document") else None
except ImportError:  # pragma: no cover
    js = None
    _document = None
    create_proxy = None
    to_js = None


class FakeElement:
    """In-memory stand-in for a DOM element (used when no browser DOM is available)."""

    def __init__(self, tag):
        self.tagName = tag.upper()
        self.children_ = []
        self.attributes = {}
        self.listeners = {}
        self.style = type("Style", (), {})()
        self.textContent = ""
        self.className = ""
        self.parentNode = None

    def appendChild(self, child):
        if getattr(child, "parentNode", None) is not None:
            child.parentNode.removeChild(child)
        self.children_.append(child)
        child.parentNode = self
        return child

    def removeChild(self, child):
        if child in self.children_:
            self.children_.remove(child)
            child.parentNode = None
        return child

    def remove(self):
        if self.parentNode is not None:
            self.parentNode.removeChild(self)

    def setAttribute(self, name, value):
        self.attributes[name] = value

    def getAttribute(self, name):
        return self.attributes.get(name)

    def addEventListener(self, name, callback):
        self.listeners.setdefault(name, []).append(callback)

    def dispatch(self, name, detail=()):
        event = type("Event", (), {"detail": list(detail)})()
        for cb in self.listeners.get(name, []):
            cb(event)


def available():
    return _document is not None


def create(tag, className=""):
    if _document is not None:
        el = _document.createElement(tag)
    else:
        el = FakeElement(tag)
    if className:
        el.className = className
    return el


def query(selector):
    if _document is None:
        return None
    return _document.querySelector(selector)


def set_prop(el, name, value):
    """Set a property of a (custom) element; lists and dicts are converted to JS values."""
    if _document is not None and isinstance(value, (list, tuple, dict)):
        value = to_js(value, dict_converter=js.Object.fromEntries)
    setattr(el, name, value)


def listen(el, event, callback):
    """Listen to a DOM event. Custom element events carry the Qt signal arguments in event.detail."""
    if _document is not None:
        def handler(e):
            detail = getattr(e, "detail", None)
            try:
                args = detail.to_py() if detail is not None and hasattr(detail, "to_py") else []
            except Exception:
                args = []
            if not isinstance(args, list):
                args = [args]
            callback(*args)

        proxy = create_proxy(handler)
        el.addEventListener(event, proxy)
        return proxy
    el.addEventListener(event, lambda e: callback(*getattr(e, "detail", [])))
    return None


def proxy(callback):
    """A Python callable JavaScript can hold on to (the caller keeps it alive)."""
    return create_proxy(callback) if create_proxy is not None else callback


def set_timeout(callback, ms):
    if js is not None and hasattr(js, "setTimeout"):
        from pyodide.ffi import create_once_callable

        return js.setTimeout(create_once_callable(callback), int(ms))
    callback()
    return 0


def set_interval(callback, ms):
    if js is not None and hasattr(js, "setInterval"):
        proxy = create_proxy(callback)
        return js.setInterval(proxy, int(ms)), proxy
    return 0, None


def clear_interval(handle):
    if js is not None and hasattr(js, "clearInterval"):
        js.clearInterval(handle)

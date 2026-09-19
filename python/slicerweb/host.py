"""Link to the hosting web page.

The web application registers a JavaScript module named ``slicerweb_host`` with
``pyodide.registerJsModule("slicerweb_host", host)`` before importing :mod:`slicerweb`.
It must provide ``emit(eventName: str, payloadJson: str)``. When no host is registered
(e.g. in Node.js tests or in desktop Slicer), events are only logged.
"""

import json
import logging

logger = logging.getLogger("slicerweb.host")

try:  # pragma: no cover - only available in the browser
    import slicerweb_host as _js_host  # type: ignore
except ImportError:
    _js_host = None

_listeners = {}


def available():
    return _js_host is not None


def emit(event, payload=None):
    """Send an event with a JSON-serializable payload to the web page and Python listeners."""
    for callback in list(_listeners.get(event, [])):
        try:
            callback(payload)
        except Exception:
            logger.exception("Error in listener of %s", event)
    if _js_host is not None:
        try:
            _js_host.emit(event, json.dumps(payload, default=_json_default))
        except Exception:
            logger.exception("Failed to send %s to the web page", event)
    else:
        logger.debug("host event %s: %s", event, payload)


def on(event, callback):
    """Register a Python listener (used by tests and the desktop bridge)."""
    _listeners.setdefault(event, []).append(callback)
    return callback


def off(event, callback):
    if callback in _listeners.get(event, []):
        _listeners[event].remove(callback)


def call(method, *args):
    """Call an optional method of the JavaScript host; returns None if not available."""
    if _js_host is None or not hasattr(_js_host, method):
        return None
    return getattr(_js_host, method)(*args)


def _json_default(obj):
    try:
        return list(obj)
    except TypeError:
        return str(obj)

"""Letting the browser draw while Python code runs: processEvents() and delayDisplay().

Python runs in the thread the page draws with. On the desktop, slicer.app.processEvents() runs the
Qt event loop, so a module - a self test, a long loop that updates its views - is seen at work; in
the browser nothing is drawn until Python returns. Where the browser supports JavaScript Promise
Integration (JSPI) and the code was started so that it may be suspended (the page starts a self
test and the Python console that way, see bridge.ts callYielding), processEvents() suspends the
Python code until the next frame has been drawn: the views render, the page is painted and answers
the pointer, and the code goes on. Elsewhere - a browser without JSPI, code run from an event of
the page, or the "Allow JavaScript Promise Integration" setting turned off - it does nothing, as
before.
"""

import logging
import time

from . import host

logger = logging.getLogger("slicerweb.yielding")

SETTING = "Developer/AllowJSPI"

# processEvents() is also called in tight loops: the page is given a frame at most this often
_MIN_INTERVAL = 0.03
_lastYield = [0.0]


def allowed():
    """Whether the application settings allow suspending Python code (on by default)."""
    try:
        import slicer

        return bool(slicer.app.userSettings().value(SETTING, True, type=bool))
    except Exception:
        return True


def can_yield():
    """Whether Python code running now can be suspended until the browser has drawn a frame."""
    if not allowed() or not host.available():
        return False
    try:
        from pyodide.ffi import can_run_sync
    except ImportError:
        return False
    try:
        return bool(can_run_sync())
    except Exception:
        return False


def yield_to_browser(milliseconds=0, force=False):
    """Let the browser draw a frame (and wait *milliseconds* more); returns whether it could.

    Unless *force*, a call that comes soon after the previous one returns at once, so that a loop
    that calls processEvents() at every step is not slowed down to a step per frame.
    """
    if not can_yield():
        return False
    now = time.monotonic()
    if not force and milliseconds <= 0 and now - _lastYield[0] < _MIN_INTERVAL:
        return True
    from pyodide.ffi import run_sync

    try:
        run_sync(host.call("waitForFrame", max(0, int(milliseconds))))
    except Exception:
        logger.debug("Could not let the browser draw", exc_info=True)
        return False
    finally:
        _lastYield[0] = time.monotonic()
    return True


def process_events(*args):
    """slicer.app.processEvents(), qt.QApplication.processEvents(): let the page draw and answer."""
    yield_to_browser()


def delay_display(message, autoCloseMsec=1000, parent=None, **kwargs):
    """slicer.util.delayDisplay(): the message is shown by the page, and the page is let draw.

    On the desktop the message is shown in a popup for autoCloseMsec milliseconds (below 400 the
    events are only processed). Here it is logged and shown where the code that is running is
    followed (the Reload and Test section says what a self test is doing), and the page is let
    draw for as long, when the code can be suspended.
    """
    logging.info(message)
    host.emit("delay-display", {"message": str(message)})
    wait = autoCloseMsec if autoCloseMsec is not None and autoCloseMsec >= 400 else 0
    yield_to_browser(milliseconds=min(wait, 10000), force=True)


def install():
    """processEvents() and delayDisplay() of slicer.app, slicer.util and the qt shims."""
    import slicer.util

    slicer.util.delayDisplay = delay_display
    from .qtcompat import types

    types.QApplication.processEvents = staticmethod(process_events)
    types.QEventLoop.processEvents = lambda self, *args: process_events(*args)

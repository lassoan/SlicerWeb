"""Icons for the qt/ctk compatibility layer.

Module GUIs set button icons in two ways:

- from a file in the module's Resources (``self.resourcePath("Icons/X.svg")``), which is in the
  installed wheel and can be read and shown as a data URL;
- from a Qt resource of the Slicer application (``":/Icons/Medium/SlicerVisibleInvisible.png"``),
  which does not exist in the browser: the drawings below stand in for the ones commonly used.
"""

import base64
import logging
import os

logger = logging.getLogger("slicerweb.icons")

_MIME = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

_STROKE = "%23dfe6f5"  # light foreground, as the icons are shown in an <img> (no currentColor)


def _svg(body, fill="none"):
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='" + fill + "' stroke='" + _STROKE.replace("%23", "#")
        + "' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" + body + "</svg>"
    )
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")


# Qt resource name (lower case, matched as a substring) -> drawing
_BUILTIN = [
    ("visibleinvisible", _svg("<path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z'/><circle cx='12' cy='12' r='3'/><path d='M4 20 20 4'/>")),
    ("invisible", _svg("<path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z'/><path d='M4 20 20 4'/>")),
    ("visible", _svg("<path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z'/><circle cx='12' cy='12' r='3'/>")),
    ("mousemodeplace", _svg("<path d='M12 3v18M3 12h18'/><circle cx='12' cy='12' r='4'/>")),
    ("deleteallrows", _svg("<path d='M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13'/><path d='M10 11v6M14 11v6'/>")),
    ("delete", _svg("<path d='M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13'/>")),
    ("viewspin", _svg("<path d='M20 12a8 8 0 1 1-2.3-5.7'/><path d='M20 4v4h-4'/>")),
    ("reload", _svg("<path d='M20 12a8 8 0 1 1-2.3-5.7'/><path d='M20 4v4h-4'/>")),
    ("plus", _svg("<path d='M12 5v14M5 12h14'/>")),
    ("edit", _svg("<path d='M4 20h4L20 8l-4-4L4 16v4Z'/>")),
]

_UNKNOWN = _svg("<circle cx='12' cy='12' r='7'/>")

_cache = {}


def icon_url(path):
    """Data URL of an icon file or of the drawing that stands in for a Qt resource ("" if none)."""
    if not path:
        return ""
    path = str(path)
    if path in _cache:
        return _cache[path]
    url = _resource_url(path) if path.startswith(":") else _file_url(path)
    _cache[path] = url
    return url


def _resource_url(path):
    name = path.rsplit("/", 1)[-1].lower()
    for key, url in _BUILTIN:
        if key in name:
            return url
    logger.debug("No drawing for the Slicer icon %s", path)
    return _UNKNOWN


def _file_url(path):
    extension = os.path.splitext(path)[1].lower()
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        logger.debug("Icon file %s cannot be read", path)
        return ""
    return "data:%s;base64,%s" % (_MIME.get(extension, "application/octet-stream"),
                                  base64.b64encode(data).decode("ascii"))

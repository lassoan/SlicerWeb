"""Sample data sets registered by modules (SampleData module registry).

Modules register data sets with SampleData.SampleDataLogic.registerCustomSampleDataSource(), which
adds them to slicer.modules.sampleDataSources. Downloading in the browser is done by the web page
(fetch, with the application's download proxy for other origins); the downloaded files are then loaded
here with the same SampleData logic as in desktop Slicer.
"""

import logging
import os

import slicer

from .bridge import method

logger = logging.getLogger("slicerweb.sample_data")


_registered = False


def _register_built_in():
    """Register the data sets that Slicer itself offers.

    A module registers its own data sets when it is loaded, but Slicer's built-in ones are
    registered by SampleDataLogic when one is first made (SampleDataLogic.__init__ calls
    registerBuiltInSampleDataSources). Without that, the list holds only what the extensions put
    in it, and the rest appear the moment somebody opens the Sample Data module.
    """
    global _registered
    if _registered:
        return
    try:
        import SampleData

        SampleData.SampleDataLogic()
        _registered = True
    except Exception:
        logger.debug("Built-in sample data sets could not be registered", exc_info=True)


def _sources():
    _register_built_in()
    return getattr(slicer.modules, "sampleDataSources", {}) or {}


def _logic():
    import SampleData

    return SampleData.SampleDataLogic()


def _as_list(value, count, default=None):
    if value is None:
        return [default] * count
    if isinstance(value, (list, tuple)):
        return list(value) + [default] * (count - len(value))
    return [value] * count


_thumbnails = {}


def _icon_named_after(source):
    """The icon file named after what a data set loads, in the SampleData module's icons."""
    try:
        import SampleData

        icons = os.path.join(os.path.dirname(SampleData.__file__), "Resources", "Icons")
    except Exception:
        return ""
    names = [source.sampleName] + list(source.nodeNames or [])
    for name in names:
        if not name:
            continue
        candidate = os.path.join(icons, name + ".png")
        if os.path.isfile(candidate):
            return candidate
    return ""


def _thumbnail(source):
    """The picture a data set is known by, as a data URL, or "" where it has none.

    A data set names a file (SampleDataLogic registers them with thumbnailFileName), which lives in
    the Resources/Icons of the module that registered it. The page cannot read the file system of
    the runtime, so the picture travels with the list.
    """
    path = getattr(source, "thumbnailFileName", None)
    if not path:
        # A data set that names no picture may still have one, under the name of what it loads, in
        # the icons of the SampleData module - which is where the module's own GUI looks for it.
        path = _icon_named_after(source)
    if not path:
        return ""
    if path in _thumbnails:
        return _thumbnails[path]
    picture = ""
    try:
        import base64

        if os.path.isfile(path):
            with open(path, "rb") as handle:
                kind = "jpeg" if path.lower().endswith((".jpg", ".jpeg")) else "png"
                picture = "data:image/%s;base64,%s" % (kind, base64.b64encode(handle.read()).decode("ascii"))
    except Exception:
        logger.debug("The thumbnail %s could not be read", path, exc_info=True)
    _thumbnails[path] = picture
    return picture


@method()
def getSampleDataSources():
    """Sample data sets registered by modules: [{category, categoryTitle, name, ...}]."""
    try:
        import SampleData
    except ImportError:
        return []
    result = []
    for category, sources in _sources().items():
        for source in sources:
            uris = list(source.uris or [])
            count = len(uris)
            result.append({
                "category": category,
                "categoryTitle": SampleData.SampleDataLogic.categoryTitle(category),
                "name": source.sampleName or (source.nodeNames[0] if source.nodeNames else ""),
                "description": source.sampleDescription or "",
                "uris": uris,
                "fileNames": _as_list(source.fileNames, count),
                "nodeNames": _as_list(source.nodeNames, count),
                # A data set says nothing about loading (None) when it wants to be loaded; only an
                # explicit False means "download it and leave it at that" (SampleDataLogic
                # .downloadFromSource reads it the same way).
                "loadFiles": [load is not False for load in _as_list(source.loadFiles, count, None)],
                "loadFileTypes": _as_list(source.loadFileTypes, count),
                "loadFileProperties": dict(source.loadFileProperties or {}),
                # data sets with their own downloader (e.g. from a server that needs a login) can only
                # be downloaded by their module
                "customDownloader": source.customDownloader is not None,
                "thumbnail": _thumbnail(source),
            })
    result.sort(key=lambda s: (s["categoryTitle"], s["name"]))
    return result


@method()
def loadSampleDataFiles(files, source=None):
    """Load files downloaded by the web page: files is [{path, nodeName, fileType, properties}]."""
    logic = _logic()
    loaded = []
    for f in files:
        path = f["path"]
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        properties = dict((source or {}).get("loadFileProperties") or {})
        properties.update(f.get("properties") or {})
        fileType = f.get("fileType")
        nodeName = f.get("nodeName")
        if fileType == "ZipFile":
            directory = os.path.join(os.path.dirname(path), os.path.splitext(os.path.basename(path))[0])
            slicer.util.extractArchive(path, directory)
            loaded.append(directory)
            continue
        if fileType == "SceneFile":
            logic.loadScene(path, properties)
            loaded.append(path)
            continue
        if not f.get("load", True):
            loaded.append(path)
            continue
        node = logic.loadNode(path, nodeName, fileType, properties)
        if node is None:
            raise RuntimeError(f"Failed to load {os.path.basename(path)}")
        loaded.append(node.GetID() if hasattr(node, "GetID") else str(node))
    return loaded

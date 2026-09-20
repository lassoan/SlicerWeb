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


def _sources():
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
                "loadFiles": [bool(load) for load in _as_list(source.loadFiles, count, True)],
                "loadFileTypes": _as_list(source.loadFileTypes, count),
                "loadFileProperties": dict(source.loadFileProperties or {}),
                # data sets with their own downloader (e.g. from a server that needs a login) can only
                # be downloaded by their module
                "customDownloader": source.customDownloader is not None,
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

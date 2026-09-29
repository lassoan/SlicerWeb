"""The scene of the last session, kept for when the page is opened again.

A phone reclaims a tab of this size as soon as another application is in front, and the page is
started from nothing when it is returned to. The scene is saved as the page goes into the
background, into a directory the page keeps in IndexedDB, and offered back at the next start; a
reload then costs the start-up time rather than the work.

The session is a folder: the scene (scene.mrml) and a folder of files for each node, so that
saving costs what changed rather than everything. A node is written only when it changed since
the session last wrote it; a node unchanged since it was loaded is not encoded at all - the file
it was loaded from is copied; and nothing is compressed except segmentations (whose labelmaps
are mostly empty). The page then copies only the files that changed into IndexedDB.
"""

import json
import logging
import os
import shutil
import time

import slicer

logger = logging.getLogger("slicerweb.session")

from .bridge import method

#: Where the session lives: a folder of the browser tab's own, which the page mounts on an IndexedDB
#: database of its own (SlicerRuntime.claimSession), so that it survives a reload of the tab and no
#: other tab touches it. The page says which (setSessionDirectory) before anything is kept.
SESSION_DIR = SCENE_FILE = NODES_DIR = INFO_FILE = LEGACY_BUNDLE = None


def _set_paths(directory):
    global SESSION_DIR, SCENE_FILE, NODES_DIR, INFO_FILE, LEGACY_BUNDLE
    SESSION_DIR = directory
    SCENE_FILE = os.path.join(directory, "scene.mrml")
    NODES_DIR = os.path.join(directory, "nodes")
    INFO_FILE = os.path.join(directory, "session.json")
    #: A session kept by an earlier version: one bundle. Restored once, then replaced.
    LEGACY_BUNDLE = os.path.join(directory, "scene.mrb")


_set_paths("/home/pyodide/SlicerData/session")

#: What the scene looked like when it was last kept: the nodes and when each last changed (their
#: names and other properties, which scene.mrml holds); their data is followed by _written.
_kept = None
#: For each node the session holds: the files it is kept in, the stored time of its storage node
#: then, and (a segmentation) what its file holds then (see _segmentation_time). The node is current in
#: the session while it has not changed since (the storage node says so: GetModifiedSinceRead) and
#: nothing else has written it meanwhile (the stored time).
_written = {}


def _segmentation_time(node):
    """What a segmentation's file holds, by when it last changed: the segments, their names and
    colors, and their source representation (the labelmap that painting changes). A segmentation
    node counts itself as modified after any change of a representation, and loading one makes the
    representations for display right after reading it: by its own account it would always have
    changed, and it would be written again at every save."""
    if not node.IsA("vtkMRMLSegmentationNode") or not node.GetSegmentation():
        return None
    segmentation = node.GetSegmentation()
    source = segmentation.GetSourceRepresentationName()
    state = []
    for i in range(segmentation.GetNumberOfSegments()):
        segmentID = segmentation.GetNthSegmentID(i)
        segment = segmentation.GetSegment(segmentID)
        representation = segment.GetRepresentation(source)
        state.append((segmentID, segment.GetName(), tuple(segment.GetColor()),
                      representation.GetMTime() if representation is not None else 0))
    return (source, tuple(state))


def _record(node, files, storageNode):
    _written[node.GetID()] = (files, _stored_time(storageNode), _segmentation_time(node))


def _fingerprint(nodes):
    return tuple(sorted((node.GetID(), node.GetMTime()) for node in nodes))


def _storable_nodes():
    """The nodes worth keeping: what was loaded or made, not the scene's own furniture."""
    nodes = []
    for node in slicer.util.getNodesByClass("vtkMRMLStorableNode"):
        if node.GetHideFromEditors() or node.IsA("vtkMRMLColorNode") or node.IsA("vtkMRMLSliceNode"):
            continue
        if node.IsA("vtkMRMLCameraNode") or node.IsA("vtkMRMLViewNode"):
            continue
        nodes.append(node)
    return nodes


def _files(storageNode):
    """The files a storage node reads or writes: its file name and the others of its list."""
    files = [storageNode.GetFileName()] if storageNode.GetFileName() else []
    for i in range(storageNode.GetNumberOfFileNames()):
        name = storageNode.GetNthFileName(i)
        if name and name not in files:
            files.append(name)
    return files


def _stored_time(storageNode):
    return storageNode.GetStoredTime().GetMTime()


def _node_folder(node):
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in node.GetID())
    return os.path.join(NODES_DIR, safe)


def _is_current(node, storageNode):
    """Whether the session holds the node as it is now."""
    kept = _written.get(node.GetID())
    if kept is None or not all(os.path.exists(f) for f in kept[0]) or kept[1] != _stored_time(storageNode):
        return False
    if kept[2] is not None:
        return kept[2] == _segmentation_time(node)
    return not node.GetModifiedSinceRead()


def _keep_node(node):
    """Bring the session's files of a node up to date. Returns (files, how): files are the session
    files the scene refers to for it, how is "kept", "copied" or "written"."""
    storageNode = node.GetStorageNode()
    if storageNode is None:
        node.AddDefaultStorageNode()
        storageNode = node.GetStorageNode()
    if storageNode is None:
        return None, "no storage"
    if _is_current(node, storageNode):
        return _written[node.GetID()][0], "kept"
    folder = _node_folder(node)
    originals = _files(storageNode)
    # Unchanged since it was loaded, from files that are still there: those files, as they are
    if (not node.GetModifiedSinceRead() and originals and all(os.path.isfile(f) for f in originals)
            and not all(f.startswith(SESSION_DIR + "/") for f in originals)):
        shutil.rmtree(folder, ignore_errors=True)
        os.makedirs(folder, exist_ok=True)
        copies = []
        for original in originals:
            copy = os.path.join(folder, os.path.basename(original))
            shutil.copyfile(original, copy)
            copies.append(copy)
        _record(node, copies, storageNode)
        return copies, "copied"
    # Restored from the session and unchanged: its files are the session's already
    if not node.GetModifiedSinceRead() and originals and all(f.startswith(SESSION_DIR + "/") and os.path.isfile(f) for f in originals):
        _record(node, originals, storageNode)
        return originals, "kept"
    # Written: into the session, uncompressed except a segmentation, with the node's own storage
    # node (so that it knows it has been stored); what it said before is put back afterwards
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, "data." + storageNode.GetDefaultWriteFileExtension())
    fileName, fileNames = storageNode.GetFileName(), originals[1:]
    compression = storageNode.GetUseCompression()
    storageNode.SetUseCompression(1 if node.IsA("vtkMRMLSegmentationNode") else 0)
    storageNode.SetFileName(target)
    storageNode.ResetFileNameList()
    try:
        ok = storageNode.WriteData(node)
    finally:
        storageNode.SetFileName(fileName or "")
        storageNode.ResetFileNameList()
        for name in fileNames:
            storageNode.AddFileName(name)
        storageNode.SetUseCompression(compression)
    if not ok:
        logger.warning("%s could not be kept in the session", node.GetName())
        return None, "failed"
    written = [target] + [os.path.join(folder, f) for f in os.listdir(folder) if os.path.join(folder, f) != target]
    _record(node, written, storageNode)
    return written, "written"


def _write_scene(files):
    """scene.mrml, referring to the session's files of the nodes: each storage node says those for
    the moment of writing, and then what it said before again."""
    scene = slicer.mrmlScene
    changed = []
    for node, nodeFiles in files:
        storageNode = node.GetStorageNode()
        changed.append((storageNode, storageNode.GetFileName(), _files(storageNode)[1:]))
        storageNode.SetFileName(nodeFiles[0])
        storageNode.ResetFileNameList()
        for name in nodeFiles[1:]:
            storageNode.AddFileName(name)
    url, root = scene.GetURL(), scene.GetRootDirectory()
    partial = SCENE_FILE + ".part"
    try:
        scene.SetRootDirectory(SESSION_DIR)
        scene.SetURL(partial)
        ok = scene.Commit(partial)
    finally:
        scene.SetURL(url)
        scene.SetRootDirectory(root)
        for storageNode, fileName, fileNames in changed:
            storageNode.SetFileName(fileName or "")
            storageNode.ResetFileNameList()
            for name in fileNames:
                storageNode.AddFileName(name)
    if ok and os.path.exists(partial):
        os.replace(partial, SCENE_FILE)
    return ok


def _keep_module(module):
    """Note the module that is open in the kept session, without writing the scene again.
    Returns whether the description changed."""
    if module is None or not os.path.exists(INFO_FILE):
        return False
    try:
        with open(INFO_FILE, encoding="utf-8") as handle:
            info = json.load(handle)
        if info.get("module") == module:
            return False
        info["module"] = module
        with open(INFO_FILE, "w", encoding="utf-8") as handle:
            json.dump(info, handle)
        return True
    except Exception:
        logger.debug("The module of the session could not be noted", exc_info=True)
        return False


def _session_bytes():
    total = 0
    for directory, _, files in os.walk(SESSION_DIR):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(directory, name))
            except OSError:
                pass
    return total


def _needs_saving(nodes):
    """Whether the scene differs from what the session holds: nodes added, removed or changed
    (their properties, or their data)."""
    if _kept != _fingerprint(nodes) or not os.path.exists(SCENE_FILE):
        return True
    return any(not (n.GetStorageNode() and _is_current(n, n.GetStorageNode())) for n in nodes)


def _sequence_playing():
    """Whether a sequence is being played: its nodes change at every frame then."""
    return any(browser.GetPlaybackActive() for browser in slicer.util.getNodesByClass("vtkMRMLSequenceBrowserNode"))


@method()
def sessionNeedsSaving():
    """Whether saveSession would write anything (for auto-save, which tells the user when it does)."""
    nodes = _storable_nodes()
    if not nodes:
        return os.path.exists(INFO_FILE)   # a scene emptied since: the session is to be dropped
    return _needs_saving(nodes)


@method()
def sessionState():
    """For auto-save: {"unsaved": whether anything changed since the session was saved, "playing":
    whether a sequence is being played (which changes its nodes at every frame: not saved then)}."""
    return {"unsaved": sessionNeedsSaving(), "playing": _sequence_playing()}


@method()
def saveSession(force=False, module=None):
    """Keep the scene for the next start, if it holds anything and anything changed, and the module
    that is open (the page says which), to open again with it.

    Returns what was done: {"saved": bool, "reason": str, "bytes": int, "changed": bool, "nodes":
    {"written": n, "copied": n, "kept": n}}; "changed" is whether anything was written (the scene,
    or only the module).
    """
    global _kept
    nodes = _storable_nodes()
    if not nodes:
        forgetSession()
        return {"saved": False, "reason": "nothing to keep", "bytes": 0, "changed": False}
    if not force and not _needs_saving(nodes):
        return {"saved": False, "reason": "nothing changed", "changed": _keep_module(module), "bytes": _session_bytes()}

    os.makedirs(NODES_DIR, exist_ok=True)
    started = time.time()
    files, counts = [], {"written": 0, "copied": 0, "kept": 0}
    for node in nodes:
        nodeFiles, how = _keep_node(node)
        if nodeFiles:
            files.append((node, nodeFiles))
            counts[how] = counts.get(how, 0) + 1
    if not _write_scene(files):
        logger.warning("The session could not be saved")
        return {"saved": False, "reason": "the scene could not be written", "bytes": 0, "changed": False}
    # the files of nodes the scene no longer has
    keep = {_node_folder(node) for node, _ in files}
    for name in os.listdir(NODES_DIR):
        if os.path.join(NODES_DIR, name) not in keep:
            shutil.rmtree(os.path.join(NODES_DIR, name), ignore_errors=True)
    for nodeID in [i for i in _written if not slicer.mrmlScene.GetNodeByID(i)]:
        del _written[nodeID]
    if os.path.exists(LEGACY_BUNDLE):
        os.remove(LEGACY_BUNDLE)
    size = _session_bytes()
    with open(INFO_FILE, "w", encoding="utf-8") as handle:
        json.dump({
            "savedAt": time.time(),
            "bytes": size,
            "nodes": [node.GetName() for node in nodes][:12],
            "count": len(nodes),
            "module": module,
        }, handle)
    _kept = _fingerprint(nodes)
    logger.info("Session saved in %.1f s: %d node(s) written, %d copied as loaded, %d unchanged; %.1f MB",
                time.time() - started, counts["written"], counts["copied"], counts["kept"], size / 1048576)
    return {"saved": True, "reason": "saved", "bytes": size, "changed": True, "nodes": counts}


@method()
def sessionInfo():
    """What was kept from the last session, or None: {savedAt, bytes, nodes, count, module}."""
    if not (os.path.exists(INFO_FILE) and (os.path.exists(SCENE_FILE) or os.path.exists(LEGACY_BUNDLE))):
        return None
    try:
        with open(INFO_FILE, encoding="utf-8") as handle:
            info = json.load(handle)
    except Exception:
        logger.debug("The session description could not be read", exc_info=True)
        return None
    info["bytes"] = _session_bytes()
    return info


@method()
def restoreSession():
    """Bring the kept scene back, into a scene that is otherwise empty. Returns the node IDs."""
    global _kept
    scene = SCENE_FILE if os.path.exists(SCENE_FILE) else LEGACY_BUNDLE
    if not os.path.exists(scene):
        return []
    manager = slicer.app.coreIOManager()
    ids = manager.loadFiles([scene], {"clear": True})
    # What came back is what is kept: saving again right away would only write the same thing. Its
    # nodes were read from the session's files, which hold them as they are.
    _written.clear()
    nodes = _storable_nodes()
    for node in nodes:
        storageNode = node.GetStorageNode()
        files = _files(storageNode) if storageNode else []
        if files and all(f.startswith(NODES_DIR + "/") and os.path.isfile(f) for f in files):
            _record(node, files, storageNode)
    _kept = _fingerprint(nodes) if scene == SCENE_FILE else None
    return ids


@method()
def setSessionDirectory(directory):
    """The folder of this tab's session (the page's; see SlicerRuntime.claimSession)."""
    global _kept
    _set_paths(directory)
    os.makedirs(directory, exist_ok=True)
    _written.clear()
    _kept = None
    return True


@method()
def forgetSession():
    """Drop the kept scene, when there is nothing to keep or the person declined it. (The folder
    itself stays: the page has its database mounted there.)"""
    global _kept
    if os.path.isdir(SESSION_DIR):
        for name in os.listdir(SESSION_DIR):
            path = os.path.join(SESSION_DIR, name)
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                os.remove(path)
    _written.clear()
    _kept = None
    return True

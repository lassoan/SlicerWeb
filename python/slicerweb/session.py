"""The scene of the last session, kept for when the page is opened again.

A phone reclaims a tab of this size as soon as another application is in front, and the page is
started from nothing when it is returned to. The scene is saved as the page goes into the
background, into a directory the page keeps in IndexedDB, and offered back at the next start; a
reload then costs the start-up time rather than the work.

Saving is a synchronous write of a scene bundle, which blocks for a moment - acceptable while the
page is hidden - and is only done when something has changed since the last one.
"""

import json
import logging
import os
import time

import slicer

logger = logging.getLogger("slicerweb.session")

from .bridge import method

#: Where the session lives: the page mounts /home/pyodide/SlicerData on IndexedDB (see
#: SlicerRuntime.mountPersistentStorage), so this survives a reload.
SESSION_DIR = "/home/pyodide/SlicerData/session"
SCENE_FILE = os.path.join(SESSION_DIR, "scene.mrb")
INFO_FILE = os.path.join(SESSION_DIR, "session.json")

#: What the scene looked like when it was last kept: the nodes and when each last changed.
#: Compared rather than asked of the scene, because GetModifiedSinceRead answers by storage nodes'
#: timestamps, which writing a bundle does not reliably move, and would say "changed" for ever.
_kept = None


def _fingerprint(nodes):
    return tuple(sorted((node.GetID(), node.GetMTime()) for node in nodes))


def _storable_nodes():
    """The nodes worth keeping: what was loaded or made, not the scene's own furniture."""
    scene = slicer.mrmlScene
    nodes = []
    for node in slicer.util.getNodesByClass("vtkMRMLStorableNode"):
        if node.GetHideFromEditors() or node.IsA("vtkMRMLColorNode") or node.IsA("vtkMRMLSliceNode"):
            continue
        if node.IsA("vtkMRMLCameraNode") or node.IsA("vtkMRMLViewNode"):
            continue
        nodes.append(node)
    return nodes


@method()
def saveSession(force=False):
    """Keep the scene for the next start, if it holds anything and anything changed.

    Returns what was done: {"saved": bool, "reason": str, "bytes": int}.
    """
    global _kept
    scene = slicer.mrmlScene
    nodes = _storable_nodes()
    if not nodes:
        forgetSession()
        return {"saved": False, "reason": "nothing to keep", "bytes": 0}
    now = _fingerprint(nodes)
    if _kept == now and not force:
        return {"saved": False, "reason": "nothing changed", "bytes": os.path.getsize(SCENE_FILE) if os.path.exists(SCENE_FILE) else 0}

    os.makedirs(SESSION_DIR, exist_ok=True)
    started = time.time()
    # Written beside the old one and moved into place, so a session cut short mid-write leaves
    # the previous one whole rather than half of this one.
    partial = SCENE_FILE + ".part"
    ok = scene.WriteToMRB(partial, None)
    if not ok or not os.path.exists(partial):
        logger.warning("The session could not be saved")
        return {"saved": False, "reason": "the scene could not be written", "bytes": 0}
    os.replace(partial, SCENE_FILE)
    size = os.path.getsize(SCENE_FILE)
    with open(INFO_FILE, "w", encoding="utf-8") as handle:
        json.dump({
            "savedAt": time.time(),
            "bytes": size,
            "nodes": [node.GetName() for node in nodes][:12],
            "count": len(nodes),
        }, handle)
    _kept = _fingerprint(nodes)
    logger.info("Session saved: %d node(s), %.1f MB in %.1f s", len(nodes), size / 1048576, time.time() - started)
    return {"saved": True, "reason": "saved", "bytes": size}


@method()
def sessionInfo():
    """What was kept from the last session, or None: {savedAt, bytes, nodes, count}."""
    if not (os.path.exists(SCENE_FILE) and os.path.exists(INFO_FILE)):
        return None
    try:
        with open(INFO_FILE, encoding="utf-8") as handle:
            info = json.load(handle)
    except Exception:
        logger.debug("The session description could not be read", exc_info=True)
        return None
    info["bytes"] = os.path.getsize(SCENE_FILE)
    return info


@method()
def restoreSession():
    """Bring the kept scene back, into a scene that is otherwise empty. Returns the node IDs."""
    global _kept
    if not os.path.exists(SCENE_FILE):
        return []
    manager = slicer.app.coreIOManager()
    ids = manager.loadFiles([SCENE_FILE], {"clear": True})
    # What came back is what is kept: saving again right away would only write the same thing.
    _kept = _fingerprint(_storable_nodes())
    return ids


@method()
def forgetSession():
    """Drop the kept scene, when there is nothing to keep or the person declined it."""
    global _kept
    for path in (SCENE_FILE, INFO_FILE, SCENE_FILE + ".part"):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError:
            logger.debug("%s could not be removed", path, exc_info=True)
    _kept = None
    return True

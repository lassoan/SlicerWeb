"""Progress of loading files, for the page to show (the "loading-progress" event).

Loading a scene reads every file in it (vtkMRMLStorageNode::ReadData) one after the other, which
takes a while for a large one, and the page cannot draw while Python runs. Each storage node that
the loading adds is watched: its read state leaves Idle when its file is about to be read and
returns to Idle when it has been read, so the share of the files read so far is known. Each step is
sent to the page, and where the loading was started so that it may be suspended (bridge.ts
callYielding, see yielding.py), the page is let draw it: the progress bar moves and the page
answers. Slicer itself reports no progress of an import (vtkMRMLScene::ImportProgressFeedbackEvent
is never invoked).
"""

import os
import time

import vtk

from . import host, yielding

EVENT = "loading-progress"

# The page is sent a step (and let draw it) at most this often
_MIN_INTERVAL = 0.1


def report(message, fraction=None, detail=""):
    """Send a step of the loading to the page; fraction is None when how far along it is not known."""
    host.emit(EVENT, {"message": message, "fraction": fraction, "detail": detail})


class FileLoadingProgress:
    """Report the loading of one of *count* files (the *index*-th) while in this context."""

    def __init__(self, scene, fileName, index=0, count=1):
        self.scene = scene
        self.name = os.path.basename(str(fileName))
        self.index = index
        self.count = max(1, count)
        self.storageNodes = []
        self.reading = set()
        self.read = set()
        self.observers = []
        self.lastReport = 0.0

    def __enter__(self):
        import slicer

        self._report(None, force=True)
        self.observers.append((self.scene, self.scene.AddObserver(slicer.vtkMRMLScene.NodeAddedEvent, self._onNodeAdded)))
        return self

    def __exit__(self, *args):
        for obj, tag in self.observers:
            obj.RemoveObserver(tag)
        self.observers = []
        return False

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onNodeAdded(self, caller, event, node):
        if node is None or not node.IsA("vtkMRMLStorageNode"):
            return
        self.storageNodes.append(node)
        self.observers.append((node, node.AddObserver(vtk.vtkCommand.ModifiedEvent, self._onStorageNodeModified)))

    def _onStorageNodeModified(self, node, event):
        key = node.GetID() or str(id(node))
        if node.GetReadState() != node.Idle:
            self.reading.add(key)
        elif key in self.reading and key not in self.read:
            self.read.add(key)
            # the last one is always shown, the others not more often than _MIN_INTERVAL
            self._report(len(self.read) / max(1, len(self.storageNodes)), force=len(self.read) == len(self.storageNodes))

    def _report(self, fileFraction, force=False):
        now = time.monotonic()
        if not force and now - self.lastReport < _MIN_INTERVAL:
            return
        self.lastReport = now
        prefix = f"Loading {self.name}" if self.count == 1 else f"Loading {self.name} ({self.index + 1} of {self.count})"
        if fileFraction is None:
            report(prefix, self.index / self.count if self.count > 1 else None)
        else:
            detail = f"{len(self.read)} of {len(self.storageNodes)} files read"
            report(prefix, (self.index + min(1.0, fileFraction)) / self.count, detail)
        # let the page draw the step (where the loading may be suspended)
        yielding.yield_to_browser(force=True)

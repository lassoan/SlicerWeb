"""Qt-free replacement of qSlicerSubjectHierarchyPluginLogic.

In desktop Slicer the subject hierarchy plugins (Qt classes) add every new data node to the
subject hierarchy. This module does the same for the node types of the built-in plugins, and sets the
owner plugin name that the desktop plugin would set.
"""

import logging

import vtk

logger = logging.getLogger(__name__)

# Node class -> owner plugin name (same names as the desktop subject hierarchy plugins).
# Checked in order, so more specific classes come first.
_PLUGINS = [
    ("vtkMRMLSegmentationNode", "Segmentations"),
    ("vtkMRMLLabelMapVolumeNode", "LabelMaps"),
    ("vtkMRMLScalarVolumeNode", "Volumes"),
    ("vtkMRMLVolumeNode", "Volumes"),
    ("vtkMRMLModelNode", "Models"),
    ("vtkMRMLMarkupsNode", "Markups"),
    ("vtkMRMLTransformNode", "Transforms"),
    ("vtkMRMLTableNode", "Tables"),
    ("vtkMRMLTextNode", "Texts"),
    ("vtkMRMLPlotChartNode", "Plots"),
    ("vtkMRMLPlotSeriesNode", "Plots"),
    ("vtkMRMLSequenceBrowserNode", "SequenceBrowser"),
    ("vtkMRMLSequenceNode", "Sequences"),
    ("vtkMRMLColorTableNode", "ColorLegend"),
    ("vtkMRMLDisplayableNode", "Default"),
    ("vtkMRMLStorableNode", "Default"),
]


def ownerPluginName(node):
    """Name of the subject hierarchy plugin that owns this kind of data node, or None."""
    if node is None:
        return None
    # Not data: application state, display and storage nodes, cameras (desktop plugins do not own them)
    for className in ("vtkMRMLSubjectHierarchyNode", "vtkMRMLDisplayNode", "vtkMRMLStorageNode", "vtkMRMLCameraNode",
                      "vtkMRMLAbstractViewNode"):
        if node.IsA(className):
            return None
    for className, plugin in _PLUGINS:
        if node.IsA(className):
            return plugin
    return None


class SubjectHierarchyPluginLogic:
    def __init__(self, scene):
        import slicer

        self._scene = scene
        self._tags = [
            scene.AddObserver(slicer.vtkMRMLScene.NodeAddedEvent, self._onNodeAdded),
            scene.AddObserver(slicer.vtkMRMLScene.EndImportEvent, self._onSceneImportEnded),
            scene.AddObserver(slicer.vtkMRMLScene.EndCloseEvent, self._onSceneCloseEnded),
        ]
        slicer.vtkMRMLSubjectHierarchyNode.ResolveSubjectHierarchy(scene)
        self.addSupportedDataNodesToSubjectHierarchy()

    def _shNode(self):
        import slicer

        return slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(self._scene)

    def addNodeToSubjectHierarchy(self, node, parentItemID=None):
        plugin = ownerPluginName(node)
        if plugin is None or node.GetHideFromEditors():
            return 0
        shNode = self._shNode()
        if shNode is None:
            return 0
        itemID = shNode.GetItemByDataNode(node)
        if itemID:
            return itemID
        if parentItemID is None:
            parentItemID = shNode.GetSceneItemID()
        itemID = shNode.CreateItem(parentItemID, node)
        if itemID:
            shNode.SetItemOwnerPluginName(itemID, plugin)
        return itemID

    def addSupportedDataNodesToSubjectHierarchy(self):
        nodes = self._scene.GetNodes()
        for i in range(nodes.GetNumberOfItems()):
            node = nodes.GetItemAsObject(i)
            if node is not None and not node.GetHideFromEditors():
                self.addNodeToSubjectHierarchy(node)

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onNodeAdded(self, caller, event, node):
        import slicer

        if isinstance(node, slicer.vtkMRMLSubjectHierarchyNode):
            slicer.vtkMRMLSubjectHierarchyNode.ResolveSubjectHierarchy(self._scene)
            return
        if self._scene.IsImporting() or node is None or node.GetHideFromEditors():
            return
        try:
            self.addNodeToSubjectHierarchy(node)
        except Exception:
            logger.exception("Failed to add %s to the subject hierarchy", node.GetID())

    def _onSceneImportEnded(self, caller, event):
        import slicer

        slicer.vtkMRMLSubjectHierarchyNode.ResolveSubjectHierarchy(self._scene)
        self.addSupportedDataNodesToSubjectHierarchy()

    def _onSceneCloseEnded(self, caller, event):
        import slicer

        slicer.vtkMRMLSubjectHierarchyNode.ResolveSubjectHierarchy(self._scene)

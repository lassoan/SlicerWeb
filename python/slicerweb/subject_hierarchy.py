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
    for className in ("vtkMRMLSubjectHierarchyNode", "vtkMRMLDisplayNode", "vtkMRMLStorageNode", "vtkMRMLCameraNode", "vtkMRMLVolumePropertyNode", "vtkMRMLShaderPropertyNode",
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
            scene.AddObserver(slicer.vtkMRMLScene.NodeRemovedEvent, self._onNodeRemoved),
            scene.AddObserver(slicer.vtkMRMLScene.EndImportEvent, self._onSceneImportEnded),
            scene.AddObserver(slicer.vtkMRMLScene.EndCloseEvent, self._onSceneCloseEnded),
        ]
        slicer.vtkMRMLSubjectHierarchyNode.ResolveSubjectHierarchy(scene)
        self._itemNames = {}
        self._shTag = None
        self._watchNames()
        self.addSupportedDataNodesToSubjectHierarchy()

    def _watchNames(self):
        """Tell the page when an item is renamed, so that the trees showing it follow.

        A renamed data node makes the subject hierarchy say its item changed - but so does every
        other change to that node, a control point dragged as much as a name typed. Only the name
        is of interest here, so what each item is called is remembered and the word goes out when
        it differs.
        """
        import slicer

        shNode = self._shNode()
        if shNode is None or self._shTag is not None:
            return
        self._shTag = shNode.AddObserver(
            slicer.vtkMRMLSubjectHierarchyNode.SubjectHierarchyItemModifiedEvent, self._onItemModified)

    @vtk.calldata_type(vtk.VTK_LONG)
    def _onItemModified(self, caller, event, itemID):
        from . import host

        if not itemID:
            return
        name = caller.GetItemName(itemID)
        if self._itemNames.get(itemID) == name:
            return
        self._itemNames[itemID] = name
        host.emit("item-renamed", {"itemID": int(itemID), "name": name})

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

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onNodeRemoved(self, caller, event, node):
        """Remove the subject hierarchy item of a removed data node (e.g. temporary nodes of a module)."""
        if node is None or self._scene.IsClosing():
            return
        shNode = self._shNode()
        if shNode is None:
            return
        itemID = shNode.GetItemByDataNode(node)
        if not itemID:
            return
        import vtk as _vtk

        children = _vtk.vtkIdList()
        shNode.GetItemChildren(itemID, children, False)
        if children.GetNumberOfIds() == 0:
            shNode.RemoveItem(itemID, False, False)

    def _forgetNames(self):
        self._itemNames = {}
        self._shTag = None
        self._watchNames()

    def _onSceneImportEnded(self, caller, event):
        import slicer

        slicer.vtkMRMLSubjectHierarchyNode.ResolveSubjectHierarchy(self._scene)
        self._forgetNames()
        self.addSupportedDataNodesToSubjectHierarchy()

    def _onSceneCloseEnded(self, caller, event):
        import slicer

        slicer.vtkMRMLSubjectHierarchyNode.ResolveSubjectHierarchy(self._scene)
        # A closed scene takes its subject hierarchy node with it, and the next one is watched anew.
        self._forgetNames()


# ---------------------------------------------------------------------------- scripted plugins
class qSlicerSubjectHierarchyPluginHandler:
    """Registry of subject hierarchy plugins (desktop: Qt plugins that provide icons, context menu
    actions and ownership of data nodes in the data tree). Plugins are registered, so that modules
    that provide them load; the web data tree does not use them yet."""

    _instance = None

    def __init__(self):
        self._plugins = []

    @classmethod
    def instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def registerPlugin(self, plugin):
        if plugin not in self._plugins:
            self._plugins.append(plugin)
        return True

    def pluginByName(self, name):
        return next((p for p in self._plugins if getattr(p, "name", None) == name), None)

    def allPlugins(self):
        return list(self._plugins)

    def subjectHierarchyNode(self):
        import slicer

        return slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(slicer.mrmlScene)


class qSlicerSubjectHierarchyScriptedPlugin:
    """Python-implemented subject hierarchy plugin adaptor (qSlicerSubjectHierarchyScriptedPlugin):
    setPythonSource() instantiates the plugin class defined in the given Python file."""

    def __init__(self, parent=None):
        self.name = ""
        self.self = None  # the Python plugin object (desktop: self())
        self._pythonSource = None

    def setPythonSource(self, filePath, className=None):
        import importlib.util
        import os
        import sys

        moduleName = os.path.splitext(os.path.basename(filePath))[0]
        className = className or moduleName
        module = sys.modules.get(moduleName)
        if module is None or getattr(module, "__file__", None) != filePath:
            spec = importlib.util.spec_from_file_location(moduleName, filePath)
            module = importlib.util.module_from_spec(spec)
            sys.modules[moduleName] = module
            spec.loader.exec_module(module)
        cls = getattr(module, className)
        self._pythonSource = filePath
        if not self.name:
            self.name = className.replace("SubjectHierarchyPlugin", "")
        self.self = cls(self)
        return True

    def pythonSource(self):
        return self._pythonSource

    def __call__(self):
        return self.self

    def setName(self, name):
        self.name = name


def install():
    """Add the plugin classes to the slicer namespace (desktop: PythonQt wrappers)."""
    import slicer

    slicer.qSlicerSubjectHierarchyPluginHandler = qSlicerSubjectHierarchyPluginHandler
    slicer.qSlicerSubjectHierarchyScriptedPlugin = qSlicerSubjectHierarchyScriptedPlugin

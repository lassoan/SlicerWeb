"""qMRML* and qSlicer* widgets (installed in the ``slicer`` namespace)."""

from . import dom
from .core import QProp, Signal
from .widgets import QVBoxLayout, QWidget, _ElementWidget


def _list(v):
    if isinstance(v, str):
        return [s for s in v.replace(";", ",").split(",") if s]
    return list(v)


class qMRMLWidget(QWidget):
    mrmlSceneChanged = Signal("mrmlSceneChanged(vtkMRMLScene*)")

    def setMRMLScene(self, scene):
        super().setMRMLScene(scene)
        self.mrmlSceneChanged.emit(scene)


class qSlicerWidget(qMRMLWidget):
    pass


class qMRMLNodeComboBox(_ElementWidget):
    _tag = "sw-node-selector"
    _classes = ""
    _events = {"currentNodeChanged": "_onCurrentNodeChanged", "nodeAdded": "_onNodeAdded"}

    currentNodeChanged = Signal("currentNodeChanged(vtkMRMLNode*)")
    currentNodeIDChanged = Signal("currentNodeIDChanged(QString)")
    nodeAdded = Signal("nodeAdded(vtkMRMLNode*)")
    nodeAddedByUser = Signal("nodeAddedByUser(vtkMRMLNode*)")
    nodeActivated = Signal("nodeActivated(vtkMRMLNode*)")
    mrmlSceneChanged = Signal("mrmlSceneChanged(vtkMRMLScene*)")

    nodeTypes = QProp([], el="nodeTypes", convert=_list)
    noneEnabled = QProp(False, el="noneEnabled", convert=bool)
    addEnabled = QProp(False, el="addEnabled", convert=bool)
    removeEnabled = QProp(False, el="removeEnabled", convert=bool)
    renameEnabled = QProp(False, el="renameEnabled", convert=bool)
    showHidden = QProp(False, el="showHidden", convert=bool)
    baseName = QProp("", el="baseName", convert=str)
    noneDisplay = QProp("None", el="noneDisplay", convert=str)
    showChildNodeTypes = QProp(True)
    selectNodeUponCreation = QProp(True)
    editEnabled = QProp(False)
    interactionNodeSingletonTag = QProp("")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._currentNodeID = None
        self._attributeFilters = {}

    def _onCurrentNodeChanged(self, nodeID=None):
        self._currentNodeID = nodeID or None
        node = self.currentNode()
        self.currentNodeChanged.emit(node)
        self.currentNodeIDChanged.emit(self._currentNodeID or "")
        self.nodeActivated.emit(node)

    def _onNodeAdded(self, nodeID=None):
        import slicer

        node = slicer.mrmlScene.GetNodeByID(nodeID) if nodeID else None
        self.nodeAdded.emit(node)
        self.nodeAddedByUser.emit(node)

    def currentNode(self):
        import slicer

        return slicer.mrmlScene.GetNodeByID(self._currentNodeID) if self._currentNodeID else None

    def currentNodeID(self):
        return self._currentNodeID or ""

    currentNodeId = property(lambda self: self._currentNodeID or "")

    def setCurrentNode(self, node):
        nodeID = node.GetID() if node is not None and not isinstance(node, str) else node
        self.setCurrentNodeID(nodeID)

    def setCurrentNodeID(self, nodeID):
        nodeID = nodeID or None
        if nodeID == self._currentNodeID:
            return
        self._currentNodeID = nodeID
        dom.set_prop(self._el, "currentNodeID", nodeID)
        node = self.currentNode()
        self.currentNodeChanged.emit(node)
        self.currentNodeIDChanged.emit(nodeID or "")

    def setMRMLScene(self, scene):
        super().setMRMLScene(scene)
        self.mrmlSceneChanged.emit(scene)

    def addAttribute(self, nodeType, name, value=None):
        self._attributeFilters[(nodeType, name)] = value

    def removeAttribute(self, nodeType, name):
        self._attributeFilters.pop((nodeType, name), None)

    def addNode(self, className=None):
        import slicer

        node = slicer.mrmlScene.AddNewNodeByClass(className or (self.nodeTypes[0] if self.nodeTypes else "vtkMRMLNode"), self.baseName)
        if self.selectNodeUponCreation:
            self.setCurrentNode(node)
        return node

    def nodeCount(self):
        import slicer

        count = 0
        for t in self.nodeTypes:
            count += slicer.mrmlScene.GetNumberOfNodesByClass(t)
        return count

    def nodeFromIndex(self, index):
        return None

    def setNodeTypeLabel(self, label, nodeType):
        pass

    def sortFilterProxyModel(self):
        return _NullModel()


class _NullModel:
    def __getattr__(self, name):
        return lambda *a, **k: None


class qMRMLCheckableNodeComboBox(qMRMLNodeComboBox):
    checkedNodesChanged = Signal("checkedNodesChanged()")

    def checkedNodes(self):
        node = self.currentNode()
        return [node] if node else []


class qMRMLSubjectHierarchyComboBox(qMRMLNodeComboBox):
    currentItemChanged = Signal("currentItemChanged(vtkIdType)")

    def currentItem(self):
        import slicer

        node = self.currentNode()
        if node is None:
            return 0
        sh = slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(slicer.mrmlScene)
        return sh.GetItemByDataNode(node)


class qMRMLSegmentSelectorWidget(qMRMLNodeComboBox):
    currentSegmentChanged = Signal("currentSegmentChanged(QString)")

    def __init__(self, parent=None):
        super().__init__(parent)
        self.nodeTypes = ["vtkMRMLSegmentationNode"]
        self._segmentID = ""

    def currentSegmentID(self):
        return self._segmentID

    def setCurrentSegmentID(self, segmentID):
        self._segmentID = segmentID
        self.currentSegmentChanged.emit(segmentID)


class qMRMLSegmentsTableView(QWidget):
    selectionChanged = Signal("selectionChanged(QItemSelection,QItemSelection)")

    def setSegmentationNode(self, node):
        self._segmentationNode = node

    def selectedSegmentIDs(self):
        return []


class qMRMLSegmentEditorWidget(QWidget):
    """Placeholder: the browser Segment Editor is available as the "Segment Editor" module panel."""

    def __init__(self, parent=None):
        super().__init__(parent)
        from .widgets import QLabel

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("Use the Segment Editor module panel to edit segments."))

    def setSegmentationNode(self, node):
        from .. import segment_editor

        segment_editor.editor().setup(node.GetID() if node else None, None)

    def setSourceVolumeNode(self, node):
        from .. import segment_editor

        segment_editor.editor().setup(None, node.GetID() if node else None)

    setMasterVolumeNode = setSourceVolumeNode

    def setMRMLSegmentEditorNode(self, node):
        pass

    def setActiveEffectByName(self, name):
        from .. import segment_editor

        segment_editor.editor().setEffect(name)


class qSlicerSimpleMarkupsWidget(qMRMLNodeComboBox):
    markupsNodeChanged = Signal("markupsNodeChanged()")

    def __init__(self, parent=None):
        super().__init__(parent)
        self.nodeTypes = ["vtkMRMLMarkupsFiducialNode"]
        self.currentNodeChanged.connect(lambda *a: self.markupsNodeChanged.emit())

    def setNodeBaseName(self, name):
        self.baseName = name

    def setDefaultNodeColor(self, color):
        pass

    def setEnterPlaceModeOnNodeChange(self, v):
        pass

    def setMarkupsNode(self, node):
        self.setCurrentNode(node)

    def markupsNode(self):
        return self.currentNode()


class qSlicerMarkupsPlaceWidget(QWidget):
    def setMRMLScene(self, scene):
        pass

    def setCurrentNode(self, node):
        self._node = node

    def setPlaceModeEnabled(self, enabled):
        import slicer

        interaction = slicer.app.applicationLogic().GetInteractionNode()
        interaction.SetCurrentInteractionMode(interaction.Place if enabled else interaction.ViewTransform)

    def setButtonsVisible(self, v):
        pass

    def setPlaceMultipleMarkups(self, v):
        pass


class qMRMLSliderWidget(_ElementWidget):
    _tag = "sw-slider"
    _classes = ""
    _events = {"valueChanged": "_onValueChanged"}

    valueChanged = Signal("valueChanged(double)")
    value = QProp(0.0, el="value", signal="valueChanged", convert=float)
    minimum = QProp(0.0, el="minimum", convert=float)
    maximum = QProp(100.0, el="maximum", convert=float)
    singleStep = QProp(1.0, el="singleStep", convert=float)
    decimals = QProp(2, el="decimals", convert=int)
    suffix = QProp("", el="suffix", convert=str)

    def _onValueChanged(self, v):
        type(self).value.set_silently(self, v)

    def setValue(self, v):
        self.value = v

    def setRange(self, lo, hi):
        self.minimum, self.maximum = lo, hi

    def setQuantity(self, q):
        pass

    def setMRMLScene(self, scene):
        pass


class qMRMLSpinBox(qMRMLSliderWidget):
    _tag = "sw-spinbox"


class qMRMLRangeWidget(QWidget):
    pass


class qMRMLWindowLevelWidget(QWidget):
    def setMRMLVolumeNode(self, node):
        self._volume = node


class qMRMLVolumeThresholdWidget(QWidget):
    def setMRMLVolumeNode(self, node):
        self._volume = node


class qMRMLTransformSliders(QWidget):
    TRANSLATION, ROTATION = 0, 1

    def setMRMLTransformNode(self, node):
        self._node = node


class qMRMLColorTableComboBox(qMRMLNodeComboBox):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.nodeTypes = ["vtkMRMLColorTableNode"]


class qMRMLSubjectHierarchyTreeView(QWidget):
    currentItemChanged = Signal("currentItemChanged(vtkIdType)")

    def setCurrentItem(self, item):
        self._item = item

    def currentItem(self):
        return getattr(self, "_item", 0)

    def setMRMLScene(self, scene):
        pass


class qMRMLThreeDWidget(QWidget):
    pass


class qMRMLSliceWidget(QWidget):
    pass


class qMRMLTableView(QWidget):
    def setMRMLTableNode(self, node):
        self._node = node


class qSlicerModuleWidget(qMRMLWidget):
    pass


WIDGETS = {name: obj for name, obj in globals().items() if name.startswith(("qMRML", "qSlicer"))}

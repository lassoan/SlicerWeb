"""qMRML* and qSlicer* widgets (installed in the ``slicer`` namespace)."""

from . import dom
from .core import property_value
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

    @property
    def currentNodeID(self):
        """Qt property (attribute in PythonQt); also callable as currentNodeID()."""
        return property_value(self._currentNodeID or "")

    currentNodeId = currentNodeID

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

    @property
    def currentSegmentID(self):
        """Qt property (attribute in PythonQt); also callable as currentSegmentID()."""
        return property_value(self._segmentID or "")

    def setCurrentSegmentID(self, segmentID):
        self._segmentID = segmentID or ""
        self.currentSegmentChanged.emit(self._segmentID)

    def setCurrentSegmentIDs(self, segmentIDs):
        self.setCurrentSegmentID(segmentIDs[0] if segmentIDs else "")

    def segmentationNode(self):
        return self.currentNode()

    def setSegmentationNode(self, node):
        self.setCurrentNode(node)


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


class qSlicerSimpleMarkupsWidget(qMRMLWidget):
    """Markups node selector with the list of control points (qSlicerSimpleMarkupsWidget).

    The node selection API of the desktop widget (currentNode, setCurrentNode, nodeTypes, ...) is
    provided by the embedded node selector (markupsSelectorComboBox()).
    """

    markupsNodeChanged = Signal("markupsNodeChanged()")
    markupsFiducialActivated = Signal("markupsFiducialActivated(QModelIndex)")
    markupsFiducialTableContextMenuRequested = Signal("markupsFiducialTableContextMenuRequested(QPoint)")
    activeMarkupsFiducialPlaceModeChanged = Signal("activeMarkupsFiducialPlaceModeChanged(bool)")
    currentNodeChanged = Signal("currentNodeChanged(vtkMRMLNode*)")

    def __init__(self, parent=None):
        from .widgets import QTableWidget

        super().__init__(parent)
        layout = QVBoxLayout(self)
        self._selector = qMRMLNodeComboBox(self)
        self._selector.nodeTypes = ["vtkMRMLMarkupsFiducialNode"]
        self._selector.addEnabled = True
        self._selector.removeEnabled = True
        layout.addWidget(self._selector)
        self._placeWidget = qSlicerMarkupsPlaceWidget(self)
        layout.addWidget(self._placeWidget)
        self._table = QTableWidget(self)
        self._table.setColumnCount(4)
        self._table.setHorizontalHeaderLabels(["Label", "R", "A", "S"])
        layout.addWidget(self._table)
        self._observed = None
        self._observerTag = None
        self._selector.currentNodeChanged.connect(self._onNodeChanged)

    # desktop API
    def markupsSelectorComboBox(self):
        return self._selector

    def markupsPlaceWidget(self):
        return self._placeWidget

    def tableWidget(self):
        return self._table

    def currentNode(self):
        return self._selector.currentNode()

    def setCurrentNode(self, node):
        self._selector.setCurrentNode(node)

    @property
    def currentNodeID(self):
        return self._selector.currentNodeID

    def setMRMLScene(self, scene):
        super().setMRMLScene(scene)
        self._selector.setMRMLScene(scene)
        self._placeWidget.setMRMLScene(scene)

    def setNodeBaseName(self, name):
        self._selector.baseName = name

    def nodeBaseName(self):
        return getattr(self._selector, "baseName", "")

    def setDefaultNodeColor(self, color):
        pass

    def setEnterPlaceModeOnNodeChange(self, v):
        pass

    def setJumpToSliceEnabled(self, v):
        pass

    def setViewGroup(self, group):
        pass

    def setMarkupsNode(self, node):
        self.setCurrentNode(node)

    def markupsNode(self):
        return self.currentNode()

    def highlightNthControlPoint(self, n):
        pass

    highlightNthFiducial = highlightNthControlPoint

    def getCurrentNode(self):
        return self.currentNode()

    def placeActive(self, place):
        self._placeWidget.setPlaceModeEnabled(bool(place))

    def activate(self):
        self.placeActive(True)

    def setInteractionNode(self, interactionNode):
        pass

    def setNodeSelectorVisible(self, visible):
        self._selector.setVisible(bool(visible))

    def nodeSelectorVisible(self):
        return self._selector.isVisible()

    def setOptionsVisible(self, visible):
        pass

    def optionsVisible(self):
        return False

    def setNodeColor(self, color):
        node = self.currentNode()
        display = node.GetDisplayNode() if node is not None else None
        if display is not None and hasattr(color, "redF"):
            display.SetSelectedColor(color.redF(), color.greenF(), color.blueF())

    def setPositionStatusColumnVisible(self, visible):
        pass

    def enterPlaceModeOnNodeChange(self):
        return False

    def jumpToSliceEnabled(self):
        return False

    def viewGroup(self):
        return -1

    def __getattr__(self, name):
        # node selector properties (nodeTypes, addEnabled, noneEnabled, ...)
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._selector, name)

    def __setattr__(self, name, value):
        if name in ("nodeTypes", "addEnabled", "removeEnabled", "noneEnabled", "renameEnabled",
                    "showHidden", "showChildNodeTypes", "baseName", "selectNodeUponCreation", "editEnabled"):
            setattr(self._selector, name, value)
        else:
            super().__setattr__(name, value)

    def _onNodeChanged(self, node):
        import vtk

        if self._observed is not None and self._observerTag is not None:
            self._observed.RemoveObserver(self._observerTag)
        self._observed, self._observerTag = node, None
        if node is not None:
            self._observerTag = node.AddObserver(vtk.vtkCommand.ModifiedEvent, lambda *a: self._updateTable())
        self._placeWidget.setCurrentNode(node)
        self._updateTable()
        self.currentNodeChanged.emit(node)
        self.markupsNodeChanged.emit()

    def _updateTable(self):
        from .types import QTableWidgetItem

        node = self._observed
        count = node.GetNumberOfControlPoints() if node is not None and hasattr(node, "GetNumberOfControlPoints") else 0
        self._table.setRowCount(count)
        for i in range(count):
            p = [0.0, 0.0, 0.0]
            node.GetNthControlPointPosition(i, p)
            self._table.setItem(i, 0, QTableWidgetItem(node.GetNthControlPointLabel(i)))
            for c in range(3):
                self._table.setItem(i, c + 1, QTableWidgetItem(f"{p[c]:.1f}"))


class qSlicerMarkupsPlaceWidget(QWidget):
    """Button that starts placing control points in the current markups node."""

    activeMarkupsPlaceModeChanged = Signal("activeMarkupsPlaceModeChanged(bool)")

    def __init__(self, parent=None):
        from .widgets import QHBoxLayout, QPushButton

        super().__init__(parent)
        self._node = None
        layout = QHBoxLayout(self)
        self._button = QPushButton("Place", self)
        self._button.setCheckable(True)
        self._button.toggled.connect(self.setPlaceModeEnabled)
        layout.addWidget(self._button)

    def setMRMLScene(self, scene):
        pass

    def setCurrentNode(self, node):
        self._node = node

    def currentNode(self):
        return self._node

    def placeModeEnabled(self):
        import slicer

        interaction = slicer.app.applicationLogic().GetInteractionNode()
        return interaction.GetCurrentInteractionMode() == interaction.Place

    def setPlaceModeEnabled(self, enabled):
        import slicer

        appLogic = slicer.app.applicationLogic()
        if enabled and self._node is not None:
            selection = appLogic.GetSelectionNode()
            selection.SetReferenceActivePlaceNodeClassName(self._node.GetClassName())
            selection.SetActivePlaceNodeID(self._node.GetID())
        interaction = appLogic.GetInteractionNode()
        interaction.SetCurrentInteractionMode(interaction.Place if enabled else interaction.ViewTransform)
        self.activeMarkupsPlaceModeChanged.emit(bool(enabled))

    def setPlaceModePersistency(self, persistent):
        import slicer

        slicer.app.applicationLogic().GetInteractionNode().SetPlaceModePersistence(1 if persistent else 0)

    def setButtonsVisible(self, v):
        pass

    def setDeleteAllControlPointsOptionVisible(self, v):
        pass

    def setUnsetLastControlPointOptionVisible(self, v):
        pass

    def setPlaceMultipleMarkups(self, v):
        pass

    def placeButton(self):
        return self._button


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


class qSlicerScriptedLoadableModuleWidget(QWidget):
    """Qt wrapper of a Python module widget in desktop Slicer.

    Scripted module widgets are plain Python objects here, so nothing is an instance of this class;
    it exists because slicer.util.getModuleWidget() checks for it (and then returns the Python
    object, which is what this application already provides).
    """

    def self(self):
        return self


WIDGETS = {name: obj for name, obj in globals().items() if name.startswith(("qMRML", "qSlicer"))}

"""qMRML* and qSlicer* widgets (installed in the ``slicer`` namespace)."""

import logging

from . import dom
from .core import property_value
from .core import QProp, Signal
from .ctkwidgets import ctkCollapsibleButton, ctkCoordinatesWidget, ctkRangeWidget
from .widgets import QVBoxLayout, QWidget, _ElementWidget

logger = logging.getLogger("slicerweb.qt")

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

    # Adding and removing nodes are on unless turned off, as in qMRMLNodeComboBox (a .ui file that
    # says nothing of them gets "Create new ..." and "Delete current node"); the selectors made for
    # other purposes turn them off, as their C++ classes do.
    _addRemoveByDefault = True

    def __init__(self, parent=None):
        super().__init__(parent)
        self._currentNodeID = None
        self._attributeFilters = {}
        self._proxyModel = _NodeComboBoxProxyModel(self)
        self.addEnabled = self._addRemoveByDefault
        self.removeEnabled = self._addRemoveByDefault

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
        """Only list nodes with this attribute (e.g. the parameter nodes of one module)."""
        self._attributeFilters[(nodeType, name)] = value
        self._updateAttributeFilters()

    def removeAttribute(self, nodeType, name):
        self._attributeFilters.pop((nodeType, name), None)
        self._updateAttributeFilters()

    def _updateAttributeFilters(self):
        # not "attributes": that is a read-only property of every DOM element
        dom.set_prop(self._el, "nodeAttributes", {name: value for (_type, name), value in self._attributeFilters.items()})

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

    def nodes(self):
        """The nodes the list holds, in the order of the scene: those of the node types, without the
        ones hidden from editors (unless showHidden), those without the attributes asked for, and
        those left out by ID (sortFilterProxyModel().hiddenNodeIDs)."""
        import slicer

        hidden = set(self._proxyModel.hiddenNodeIDs)
        result, seen = [], set()
        for nodeType in self.nodeTypes:
            for node in slicer.util.getNodesByClass(nodeType):
                nodeID = node.GetID()
                if nodeID in seen or nodeID in hidden or (node.GetHideFromEditors() and not self.showHidden):
                    continue
                if not all(self._hasAttribute(node, filterType, name, value)
                           for (filterType, name), value in self._attributeFilters.items()):
                    continue
                seen.add(nodeID)
                result.append(node)
        return result

    @staticmethod
    def _hasAttribute(node, nodeType, name, value):
        """Whether a node passes the filter of addAttribute: one of another type always does."""
        if not node.IsA(nodeType):
            return True
        found = node.GetAttribute(name)
        return found is not None if value is None else found == str(value)

    def nodeFromIndex(self, index):
        return None

    def setNodeTypeLabel(self, label, nodeType):
        pass

    def sortFilterProxyModel(self):
        return self._proxyModel


class _NodeComboBoxProxyModel:
    """The node selector's qMRMLSortFilterProxyModel: what of it a module sets.

    hiddenNodeIDs leaves nodes out by their ID (Virtual Cath Lab keeps its own X-ray volumes out
    of the volume selector). Anything else it is asked to do, it lets pass.
    """

    def __init__(self, comboBox):
        self._comboBox = comboBox
        self._hiddenNodeIDs = []

    @property
    def hiddenNodeIDs(self):
        return list(self._hiddenNodeIDs)

    @hiddenNodeIDs.setter
    def hiddenNodeIDs(self, nodeIDs):
        self._hiddenNodeIDs = [str(nodeID) for nodeID in (nodeIDs or [])]
        self._comboBox._setElementProperty("hiddenNodeIDs", list(self._hiddenNodeIDs))

    def setHiddenNodeIDs(self, nodeIDs):
        self.hiddenNodeIDs = nodeIDs

    def __getattr__(self, name):
        return lambda *a, **k: None


class qMRMLCheckableNodeComboBox(qMRMLNodeComboBox):
    """Node selector whose nodes are each checked on and off (Lights: the views it manages).

    Every node starts unchecked, as on the desktop. The check states are kept here, by node ID, and
    shown by the element (its checkable mode); a node the user checks or unchecks comes back as the
    list of checked nodes.
    """

    _addRemoveByDefault = False
    _events = dict(qMRMLNodeComboBox._events, checkedNodesChanged="_onCheckedNodesChanged")
    checkedNodesChanged = Signal("checkedNodesChanged()")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._checkStates = {}   # node ID -> Qt.CheckState, for the nodes not unchecked
        self._notUserCheckable = set()
        dom.set_prop(self._el, "checkable", True)

    def _showCheckStates(self):
        from .types import Qt

        dom.set_prop(self._el, "checkedNodeIDs", [nodeID for nodeID, state in self._checkStates.items() if state == Qt.Checked])

    def _onCheckedNodesChanged(self, nodeIDs=None):
        from .types import Qt

        checked = set(nodeIDs or [])
        states = {nodeID: Qt.Checked for nodeID in checked}
        # a node the user cannot check keeps its state
        states.update({nodeID: state for nodeID, state in self._checkStates.items() if nodeID in self._notUserCheckable})
        if states != self._checkStates:
            self._checkStates = states
            self._showCheckStates()
            self.checkedNodesChanged.emit()

    def checkState(self, node):
        from .types import Qt

        return self._checkStates.get(node.GetID(), Qt.Unchecked) if node is not None else Qt.Unchecked

    def setCheckState(self, node, state):
        from .types import Qt

        if node is None or node.GetID() not in {n.GetID() for n in self.nodes()}:
            return   # not in the list: as on the desktop, nothing to check
        state = int(state)
        if self._checkStates.get(node.GetID(), Qt.Unchecked) == state:
            return
        if state == Qt.Unchecked:
            del self._checkStates[node.GetID()]
        else:
            self._checkStates[node.GetID()] = state
        self._showCheckStates()
        self.checkedNodesChanged.emit()

    def check(self, node):
        from .types import Qt

        self.setCheckState(node, Qt.Checked)

    def uncheck(self, node):
        from .types import Qt

        self.setCheckState(node, Qt.Unchecked)

    def checkedNodes(self):
        from .types import Qt

        return [node for node in self.nodes() if self._checkStates.get(node.GetID()) == Qt.Checked]

    def uncheckedNodes(self):
        checked = {node.GetID() for node in self.checkedNodes()}
        return [node for node in self.nodes() if node.GetID() not in checked]

    def allChecked(self):
        return not self.uncheckedNodes()

    def noneChecked(self):
        return not self.checkedNodes()

    def setUserCheckable(self, node, userCheckable):
        if node is None:
            return
        if userCheckable:
            self._notUserCheckable.discard(node.GetID())
        else:
            self._notUserCheckable.add(node.GetID())
        dom.set_prop(self._el, "uncheckableNodeIDs", sorted(self._notUserCheckable))


class qMRMLSubjectHierarchyComboBox(qMRMLNodeComboBox):
    _addRemoveByDefault = False
    currentItemChanged = Signal("currentItemChanged(vtkIdType)")

    def currentItem(self):
        import slicer

        node = self.currentNode()
        if node is None:
            return 0
        sh = slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(slicer.mrmlScene)
        return sh.GetItemByDataNode(node)


class qMRMLSegmentSelectorWidget(qMRMLWidget):
    """Segmentation node selector with the list of its segments (qMRMLSegmentSelectorWidget).

    The node selection API of the desktop widget (currentNode, setCurrentNode, nodeTypes, ...) is
    provided by the embedded node selector (segmentationNodeComboBox()).
    """

    currentSegmentChanged = Signal("currentSegmentChanged(QString)")
    segmentSelectionChanged = Signal("segmentSelectionChanged(QStringList)")
    currentNodeChanged = Signal("currentNodeChanged(vtkMRMLNode*)")
    currentNodeIDChanged = Signal("currentNodeIDChanged(QString)")

    def __init__(self, parent=None):
        from .widgets import QComboBox

        super().__init__(parent)
        layout = QVBoxLayout(self)
        self._selector = qMRMLNodeComboBox(self)
        self._selector.nodeTypes = ["vtkMRMLSegmentationNode"]
        layout.addWidget(self._selector)
        self._segments = QComboBox(self)
        layout.addWidget(self._segments)
        self._segmentID = ""
        self._noneEnabled = False
        self._observed = None
        self._observerTags = []
        self._selector.currentNodeChanged.connect(self._onNodeChanged)
        self._segments.currentIndexChanged.connect(self._onSegmentIndexChanged)

    # --- node selection (forwarded to the node selector)
    def segmentationNodeComboBox(self):
        return self._selector

    def segmentationNode(self):
        return self._selector.currentNode()

    def setSegmentationNode(self, node):
        self._selector.setCurrentNode(node)

    def currentNode(self):
        return self._selector.currentNode()

    def setCurrentNode(self, node):
        self._selector.setCurrentNode(node)

    @property
    def currentNodeID(self):
        return self._selector.currentNodeID

    currentNodeId = currentNodeID

    def setCurrentNodeID(self, nodeID):
        self._selector.setCurrentNodeID(nodeID)

    def setMRMLScene(self, scene):
        super().setMRMLScene(scene)
        self._selector.setMRMLScene(scene)

    # node properties are set on the widget itself in .ui files and in module code
    _NODE_PROPERTIES = ("nodeTypes", "addEnabled", "removeEnabled", "renameEnabled", "editEnabled",
                        "baseName", "showChildNodeTypes", "selectNodeUponCreation", "showHidden",
                        "noneDisplay")

    def __getattr__(self, name):
        if name in qMRMLSegmentSelectorWidget._NODE_PROPERTIES:
            return getattr(self.__dict__["_selector"], name)
        raise AttributeError(name)

    def __setattr__(self, name, value):
        if name in qMRMLSegmentSelectorWidget._NODE_PROPERTIES and "_selector" in self.__dict__:
            setattr(self._selector, name, value)
            return
        super().__setattr__(name, value)

    # --- segment selection
    @property
    def currentSegmentID(self):
        """Qt property (attribute in PythonQt); also callable as currentSegmentID()."""
        return property_value(self._segmentID or "")

    def setCurrentSegmentID(self, segmentID):
        segmentID = segmentID or ""
        if segmentID:
            index = self._segments.findData(segmentID)
            if index < 0:
                return  # not a segment of this segmentation (e.g. read from a saved scene)
        else:
            index = -1 if self._noneEnabled else 0
        self._setSegmentIndex(index)

    def selectedSegmentIDs(self):
        return [self._segmentID] if self._segmentID else []

    def setSelectedSegmentIDs(self, segmentIDs):
        self.setCurrentSegmentID(segmentIDs[0] if segmentIDs else "")

    def clearSelection(self):
        self.setCurrentSegmentID("")

    def setNoneEnabled(self, enabled):
        self._noneEnabled = bool(enabled)
        self._updateSegments()

    def noneEnabled(self):
        return self._noneEnabled

    def setSegmentationNodeSelectorVisible(self, visible):
        self._selector.setVisible(bool(visible))

    def setMultiSelection(self, enabled):
        pass

    def setHideSegments(self, segmentIDs):
        pass

    def setEditEnabled(self, enabled):
        pass

    # --- keeping the segment list up to date
    def _onNodeChanged(self, node=None):
        self._observeSegmentation(node)
        self._updateSegments()
        self.currentNodeChanged.emit(node)
        self.currentNodeIDChanged.emit(node.GetID() if node is not None else "")

    def _observeSegmentation(self, node):
        import vtk

        segmentation = node.GetSegmentation() if node is not None else None
        if segmentation is self._observed:
            return
        if self._observed is not None:
            for tag in self._observerTags:
                self._observed.RemoveObserver(tag)
        self._observerTags = []
        self._observed = segmentation
        if segmentation is None:
            return
        events = [vtk.vtkCommand.ModifiedEvent]
        for name in ("SegmentAdded", "SegmentRemoved", "SegmentModified"):
            event = getattr(type(segmentation), name, None)
            if isinstance(event, int):
                events.append(event)
        for event in events:
            self._observerTags.append(segmentation.AddObserver(event, self._onSegmentationModified))

    def _onSegmentationModified(self, caller=None, event=None):
        self._updateSegments()

    def _updateSegments(self):
        node = self._selector.currentNode()
        segmentation = node.GetSegmentation() if node is not None else None
        items = []
        if segmentation is not None:
            for index in range(segmentation.GetNumberOfSegments()):
                segmentID = segmentation.GetNthSegmentID(index)
                segment = segmentation.GetNthSegment(index)
                items.append((segment.GetName() or segmentID, segmentID))
        self._segments.blockSignals(True)
        self._segments.clear()
        if self._noneEnabled:
            self._segments.addItem("None", "")
        for text, segmentID in items:
            self._segments.addItem(text, segmentID)
        self._segments.blockSignals(False)
        self._segments.setVisible(bool(items))
        # keep the selected segment if it is still there, otherwise select the first one
        index = self._segments.findData(self._segmentID) if self._segmentID else -1
        if index < 0:
            index = -1 if (self._noneEnabled or not items) else 0
        self._setSegmentIndex(index)

    def _setSegmentIndex(self, index):
        self._segments.blockSignals(True)
        self._segments.currentIndex = index
        self._segments.blockSignals(False)
        self._setSegmentID(str(self._segments.itemData(index) or "") if index >= 0 else "")

    def _onSegmentIndexChanged(self, index=None):
        self._setSegmentID(str(self._segments.itemData(self._segments.currentIndex) or ""))

    def _setSegmentID(self, segmentID):
        if segmentID == self._segmentID:
            return
        self._segmentID = segmentID
        self.currentSegmentChanged.emit(self._segmentID)
        self.segmentSelectionChanged.emit(self.selectedSegmentIDs())


class qMRMLSegmentsTableView(QWidget):
    selectionChanged = Signal("selectionChanged(QItemSelection,QItemSelection)")

    def setSegmentationNode(self, node):
        self._segmentationNode = node

    def setHideSegments(self, segmentIDs):
        self._hiddenSegmentIDs = list(segmentIDs)

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
        self._segmentEditorNode = node

    def mrmlSegmentEditorNode(self):
        return getattr(self, "_segmentEditorNode", None)

    def setActiveEffectByName(self, name):
        from .. import segment_editor

        segment_editor.editor().setEffect(name)


class _WebView:
    """webView() of qSlicerWebWidget: its url is the widget's."""

    def __init__(self, widget):
        self._widget = widget

    @property
    def url(self):
        return self._widget.url

    @url.setter
    def url(self, value):
        self._widget.url = value

    def setUrl(self, value):
        self._widget.url = value

    def setHtml(self, html, *args):
        self._widget.setHtml(html)


class qSlicerWebWidget(QWidget):
    """A web page inside a module panel, shown in an iframe. A page of the extension itself (a file in
    the virtual file system, which the browser cannot load by address) is shown from its content."""

    loadFinished = Signal("loadFinished(bool)")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._url = ""
        self._frame = dom.create("iframe", "w-full border-0")
        try:
            self._frame.style.minHeight = "400px"
            self._el.appendChild(self._frame)
        except Exception:
            pass

    @property
    def url(self):
        return self._url

    @url.setter
    def url(self, value):
        self.setUrl(value)

    def setUrl(self, value):
        import os

        value = str(getattr(value, "toString", lambda: value)()) if not isinstance(value, str) else value
        self._url = value
        path = value[len("file://"):] if value.startswith("file://") else value
        if not value.startswith(("http://", "https://", "data:", "blob:")) and os.path.isfile(path):
            with open(path, encoding="utf8", errors="replace") as handle:
                self.setHtml(handle.read())
        else:
            try:
                self._frame.removeAttribute("srcdoc")
                self._frame.src = value
            except Exception:
                pass
        self.loadFinished.emit(True)

    def setHtml(self, html, *args):
        try:
            self._frame.srcdoc = str(html)
        except Exception:
            pass

    def webView(self):
        return _WebView(self)


class qMRMLCollapsibleButton(ctkCollapsibleButton):
    """ctkCollapsibleButton that is given the scene, as qMRMLWidget is (a .ui file uses it as the
    top of a module panel section)."""

    mrmlSceneChanged = Signal("mrmlSceneChanged(vtkMRMLScene*)")

    def setMRMLScene(self, scene):
        super().setMRMLScene(scene)
        self.mrmlSceneChanged.emit(scene)


class qMRMLCoordinatesWidget(ctkCoordinatesWidget):
    """ctkCoordinatesWidget that is given the scene (on the desktop, for the units of its values)."""

    def setMRMLScene(self, scene):
        super().setMRMLScene(scene)

    def setQuantity(self, quantity):
        self._quantity = quantity


class qMRMLUtils:
    """qMRMLUtils: conversions between VTK and Qt types (here, the images: a QImage holds the
    vtkImageData it is made from)."""

    def vtkImageDataToQImage(self, imageData, image):
        import vtk

        copy = vtk.vtkImageData()
        copy.DeepCopy(imageData)
        image._vtkImage = copy
        return True

    def qImageToVtkImageData(self, image, imageData):
        if getattr(image, "_vtkImage", None) is None:
            return False
        imageData.DeepCopy(image._vtkImage)
        return True


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
    """Buttons that place control points in the current markups node, and remove them again."""

    # How many markups a press of Place places (qSlicerMarkupsPlaceWidget::PlaceMultipleMarkupsType,
    # with the same values)
    ShowPlaceMultipleMarkupsOption, HidePlaceMultipleMarkupsOption = 0, 1
    ForcePlaceSingleMarkup, ForcePlaceMultipleMarkups = 2, 3

    activeMarkupsPlaceModeChanged = Signal("activeMarkupsPlaceModeChanged(bool)")
    # The name the signal had when the widget only placed fiducials; modules still connect to it.
    activeMarkupsFiducialPlaceModeChanged = Signal("activeMarkupsFiducialPlaceModeChanged(bool)")

    def __init__(self, parent=None):
        from .widgets import QHBoxLayout, QPushButton

        super().__init__(parent)
        self._node = None
        self._deleteAllVisible = True
        self._placeMultipleMarkups = self.ShowPlaceMultipleMarkupsOption
        layout = QHBoxLayout(self)
        self._button = QPushButton("Place", self)
        self._button.setCheckable(True)
        self._button.toggled.connect(self.setPlaceModeEnabled)
        # a click records the state it clicked the button into after toggled has been handled: the
        # button is set back to what is true then (pressed only if placing into this node started)
        self._button.clicked.connect(lambda *args: self._updatePlaceButton())
        layout.addWidget(self._button)
        # Beside Place, as the desktop widget has it: a press removes the point placed last.
        self._deleteButton = QPushButton("Delete", self)
        self._deleteButton.setToolTip("Remove the last control point")
        self._deleteButton.clicked.connect(self.deleteLastPoint)
        layout.addWidget(self._deleteButton)
        # Named as qSlicerMarkupsPlaceWidget names its children, for the module that reaches in
        # (VirtualCathLab hides the colour button by findChild("ctkColorPickerButton", "ColorButton"))
        from .ctkwidgets import ctkColorPickerButton

        self._button.setObjectName("PlaceButton")
        self._deleteButton.setObjectName("DeleteButton")
        self._colorButton = ctkColorPickerButton(self)
        self._colorButton.setObjectName("ColorButton")
        self._colorButton.setToolTip("Color of the markups")
        self._colorButton.colorChanged.connect(self._onColorChanged)
        layout.addWidget(self._colorButton)
        # The "..." button that opens the menu of the actions below on the desktop (modules hide it
        # by findChild(..., "MoreButton")); hidden here until a button can show a menu.
        from .widgets import QMenu

        self._moreButton = QPushButton("...", self)
        self._moreButton.setObjectName("MoreButton")
        self._moreButton.setMenu(QMenu(self._moreButton))
        self._moreButton.setVisible(False)
        layout.addWidget(self._moreButton)
        # The actions of the real widget's "more" menu, by name, so that a module may hide or use
        # them; here they are kept as actions without a menu to show them in yet.
        from .types import QAction

        self._actions = {}
        for name, text in (("ActionDeleteAll", "Delete all points"), ("ActionUnsetAll", "Unset all points"),
                           ("ActionUnsetLast", "Unset last point"), ("ActionFixedNumberOfControlPoints", "Fixed number of control points"),
                           ("ActionLocked", "Locked"), ("ActionVisibility", "Visible"), ("ActionPlacePersistentPoint", "Place multiple control points")):
            action = QAction(self)
            action.setObjectName(name)
            action.text = text
            self._actions[name] = action
            self._moreButton.menu().addAction(action)
        # The Place button shows whether points are being placed into this widget's node, whatever
        # started or ended it (the toolbar, another place widget, a placement that is not persistent
        # ending by itself), as the desktop widget does: it follows the interaction node (the mouse
        # mode) and the selection node (the node points are placed into).
        self._lastSignaledPlaceMode = False
        self._observations = []
        try:
            import slicer
            import vtk

            appLogic = slicer.app.applicationLogic()
            for node in (appLogic.GetInteractionNode(), appLogic.GetSelectionNode()):
                if node is not None:
                    self._observations.append((node, node.AddObserver(vtk.vtkCommand.ModifiedEvent, self._onPlaceStateModified)))
        except Exception:
            logger.debug("The place widget cannot follow the place mode", exc_info=True)
        self._displayObservation = None
        self._updateFromNode()

    def _onPlaceStateModified(self, caller=None, event=None):
        self._updatePlaceButton()

    def _updatePlaceButton(self):
        """The Place button pressed exactly while points are placed into the current node (set without
        the button's toggled, which would start or end placing), and activeMarkupsPlaceModeChanged
        when that changes."""
        enabled = self.placeModeEnabled()
        if self._button.checked != enabled:
            type(self._button).checked.set_silently(self._button, enabled)
            dom.set_prop(self._button._el, "checked", enabled)
        if enabled != self._lastSignaledPlaceMode:
            self._lastSignaledPlaceMode = enabled
            self.activeMarkupsPlaceModeChanged.emit(enabled)
            self.activeMarkupsFiducialPlaceModeChanged.emit(enabled)

    def _destroy(self):
        # the interaction and selection nodes outlive the widget: they must not keep calling it
        for node, tag in self._observations:
            node.RemoveObserver(tag)
        self._observations = []
        if self._node is not None and getattr(self, "_displayObservation", None) is not None:
            self._node.RemoveObserver(self._displayObservation)
            self._displayObservation = None
        super()._destroy()

    def colorButton(self):
        return self._colorButton

    def _onColorChanged(self, color):
        node = getattr(self, "_node", None) or getattr(self, "currentNode", lambda: None)()
        display = node.GetDisplayNode() if node is not None and hasattr(node, "GetDisplayNode") else None
        if display is None:
            return
        try:
            rgb = color if isinstance(color, (list, tuple)) else color.getRgbF()[:3]
            display.SetSelectedColor(*rgb)
            display.SetColor(*rgb)
        except Exception:
            pass

    def placeButton(self):
        return self._button

    def deleteButton(self):
        return self._deleteButton

    def moreButton(self):
        # The desktop widget keeps its rarer actions behind a third button; here they all sit on
        # the delete button, so a module showing or hiding "more" acts on that one.
        return self._deleteButton

    def deleteLastPoint(self):
        """Remove the control point that was placed last."""
        node = self._node
        if node is None or node.GetNumberOfControlPoints() == 0:
            return
        node.RemoveNthControlPoint(node.GetNumberOfControlPoints() - 1)

    def deleteAllPoints(self):
        """Remove every control point of the current node."""
        if self._node is not None:
            self._node.RemoveAllControlPoints()

    def setMRMLScene(self, scene):
        pass

    def setCurrentNode(self, node):
        import vtk

        old = self._node
        if old is not None and getattr(self, "_displayObservation", None) is not None:
            old.RemoveObserver(self._displayObservation)
            self._displayObservation = None
        self._node = node
        # the color button follows the node's display, whatever changes it (the Markups module, code)
        if node is not None and hasattr(node, "AddObserver"):
            self._displayObservation = node.AddObserver(
                getattr(node, "DisplayModifiedEvent", vtk.vtkCommand.ModifiedEvent), lambda *args: self._updateFromNode())
        self._updateFromNode()
        self._updatePlaceButton()

    def _updateFromNode(self):
        """The color button shows the selected color of the node's display (the default color, disabled,
        when there is no node), and the Place button the icon of its kind of markup, as on the desktop."""
        from .types import QColor

        node = self._node
        display = node.GetDisplayNode() if node is not None and hasattr(node, "GetDisplayNode") else None
        if display is not None:
            r, g, b = display.GetSelectedColor()
            color = QColor(int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))
        else:
            color = QColor(0, 255, 0)   # qSlicerMarkupsPlaceWidget's color when there is no node
        wasBlocked = self._colorButton.blockSignals(True)
        try:
            self._colorButton.setColor(color)
        finally:
            self._colorButton.blockSignals(wasBlocked)
        self._colorButton.setEnabled(node is not None)
        dom.set_prop(self._button._el, "markupsClass", node.GetClassName() if node is not None else "")

    def currentNode(self):
        return self._node

    def placeModeEnabled(self):
        """Whether points are being placed into the current node: the mouse mode is Place, and the node
        points are placed into is this one (qSlicerMarkupsPlaceWidget::placeModeEnabled)."""
        import slicer

        if self._node is None:
            return False
        appLogic = slicer.app.applicationLogic()
        interaction, selection = appLogic.GetInteractionNode(), appLogic.GetSelectionNode()
        if interaction is None or selection is None:
            return False
        return (interaction.GetCurrentInteractionMode() == interaction.Place
                and selection.GetActivePlaceNodeID() == self._node.GetID())

    def setPlaceModeEnabled(self, enabled):
        import slicer

        appLogic = slicer.app.applicationLogic()
        interaction = appLogic.GetInteractionNode()
        if enabled:
            if self._node is None:
                # nothing to place into: the button goes back to what is true
                self._updatePlaceButton()
                return
            selection = appLogic.GetSelectionNode()
            selection.SetReferenceActivePlaceNodeClassName(self._node.GetClassName())
            selection.SetActivePlaceNodeID(self._node.GetID())
            self._applyPlaceMultipleMarkups()
            interaction.SetCurrentInteractionMode(interaction.Place)
        elif self.placeModeEnabled():
            # only placing into this node is ended here, not another widget's
            interaction.SetCurrentInteractionMode(interaction.ViewTransform)
        # the button and the signal follow from the nodes (_updatePlaceButton), whatever changed them
        self._updatePlaceButton()

    def setPlaceModePersistency(self, persistent):
        import slicer

        slicer.app.applicationLogic().GetInteractionNode().SetPlaceModePersistence(1 if persistent else 0)

    def setButtonsVisible(self, v):
        self._deleteButton.setVisible(bool(v))

    def setDeleteAllControlPointsOptionVisible(self, v):
        self._deleteAllVisible = bool(v)

    deleteAllControlPointsOptionVisible = property(
        lambda self: self._deleteAllVisible, setDeleteAllControlPointsOptionVisible)

    def setUnsetLastControlPointOptionVisible(self, v):
        pass

    unsetLastControlPointOptionVisible = property(lambda self: False,
                                                  setUnsetLastControlPointOptionVisible)

    def setPlaceMultipleMarkups(self, v):
        """Whether Place places one markup or keeps placing, as qSlicerMarkupsPlaceWidget has it:
        ForcePlaceSingleMarkup turns place mode persistence off when placing starts (a line ends after
        its two points), ForcePlaceMultipleMarkups turns it on, ShowPlaceMultipleMarkupsOption leaves it
        as the user set it. A .ui file gives it as text ("qSlicerMarkupsPlaceWidget::ForcePlaceSingleMarkup")."""
        if isinstance(v, str):
            name = v.split("::")[-1]
            v = getattr(type(self), name, self.ShowPlaceMultipleMarkupsOption)
        self._placeMultipleMarkups = int(v)
        # applied at once while placing into this node, as on the desktop
        if self.placeModeEnabled():
            self._applyPlaceMultipleMarkups()

    placeMultipleMarkups = property(lambda self: self._placeMultipleMarkups, setPlaceMultipleMarkups)

    def _applyPlaceMultipleMarkups(self):
        if self._placeMultipleMarkups == self.ForcePlaceSingleMarkup:
            self.setPlaceModePersistency(False)
        elif self._placeMultipleMarkups == self.ForcePlaceMultipleMarkups:
            self.setPlaceModePersistency(True)

    def placeModePersistency(self):
        import slicer

        return bool(slicer.app.applicationLogic().GetInteractionNode().GetPlaceModePersistence())


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


class qMRMLRangeWidget(ctkRangeWidget):
    """A range slider that knows what it is showing, as the Qt one does (it derives from ctkRangeWidget).

    Modules connect to valuesChanged and read minimumValue and maximumValue, all of which the ctk
    widget already has; the quantity and the scene only decide how the numbers are displayed.
    """

    def setQuantity(self, quantity):
        self._quantity = quantity

    def quantity(self):
        return getattr(self, "_quantity", "")

    def setMRMLScene(self, scene):
        self._scene = scene


class qMRMLWindowLevelWidget(QWidget):
    def setMRMLVolumeNode(self, node):
        self._volume = node


class qMRMLVolumeThresholdWidget(QWidget):
    def setMRMLVolumeNode(self, node):
        self._volume = node


class qMRMLTransformSliders(QWidget):
    """Three sliders that move or turn a transform, as qMRMLTransformSliders does.

    A collapsible group (titled as the module titles it) holding a slider for each axis: LR, PA
    and IS millimetres of translation, or degrees of rotation about those axes. Moving one writes
    the transform node's matrix; choosing a node sets the sliders from its matrix. Rotation angles
    are those vtkTransform reads from and writes to a matrix (its orientation, applied as Z, X, Y),
    so a matrix goes round trip unchanged. The translation is set in the parent's frame whatever
    the coordinate reference says; the local frame is not told apart yet.
    """
    TRANSLATION, ROTATION = 0, 1
    GLOBAL, LOCAL = 0, 1
    _AXES = ("LR", "PA", "IS")

    # As qMRMLTransformSliders declares them: values changed by a slider (not by choosing a node),
    # the range, the decimals
    valuesChanged = Signal("valuesChanged()")
    rangeChanged = Signal("rangeChanged(double,double)")
    decimalsChanged = Signal("decimalsChanged(int)")

    def __init__(self, parent=None):
        super().__init__(parent)
        from .ctkwidgets import ctkCollapsibleGroupBox, ctkSliderWidget
        from .widgets import QHBoxLayout, QLabel, QVBoxLayout

        self._node = None
        self._type = self.TRANSLATION
        self._coordinateReference = self.GLOBAL
        self._updating = False
        self._range = (-200.0, 200.0)
        self._groupBox = ctkCollapsibleGroupBox("", self)
        column = QVBoxLayout()
        self._sliders = []
        for axis in self._AXES:
            row = QHBoxLayout()
            row.addWidget(QLabel(axis))
            slider = ctkSliderWidget()
            # named as in qMRMLTransformSliders.ui, where tests find them (slicer.util.findChild)
            slider.setObjectName(axis + "Slider")
            slider.setRange(*self._range)
            slider.setValue(0.0)
            if hasattr(slider, "setDecimals"):
                slider.setDecimals(2)
            slider.connect("valueChanged(double)", self._onSliderChanged)
            row.addWidget(slider)
            column.addLayout(row) if hasattr(column, "addLayout") else column.addWidget(slider)
            self._sliders.append(slider)
        self._groupBox.setLayout(column)
        layout = QVBoxLayout()
        layout.addWidget(self._groupBox)
        self.setLayout(layout)

    # --- what the module sets up
    def setMRMLTransformNode(self, node):
        self._node = node
        self._readNode()

    def mrmlTransformNode(self):
        return self._node

    def setTypeOfTransform(self, typeOfTransform):
        self._type = typeOfTransform
        self.setRange(*((-200.0, 200.0) if typeOfTransform == self.TRANSLATION else (-180.0, 180.0)))
        self._readNode()

    def typeOfTransform(self):
        return self._type

    def setCoordinateReference(self, reference):
        self._coordinateReference = reference

    def coordinateReference(self):
        return self._coordinateReference

    def setTitle(self, title):
        self._groupBox.setTitle(title) if hasattr(self._groupBox, "setTitle") else None
        self._title = title

    def title(self):
        return getattr(self, "_title", "")

    def setRange(self, minimum, maximum):
        self._range = (float(minimum), float(maximum))
        for slider in self._sliders:
            slider.setRange(minimum, maximum)
        self.rangeChanged.emit(float(minimum), float(maximum))

    def setMinMaxVisible(self, visible):
        self._minMaxVisible = bool(visible)

    def minMaxVisible(self):
        return getattr(self, "_minMaxVisible", True)

    def setSingleStep(self, step):
        for slider in self._sliders:
            if hasattr(slider, "setSingleStep"):
                slider.setSingleStep(step)

    def setDecimals(self, decimals):
        for slider in self._sliders:
            if hasattr(slider, "setDecimals"):
                slider.setDecimals(decimals)
        self.decimalsChanged.emit(int(decimals))

    def reset(self):
        for slider in self._sliders:
            slider.setValue(0.0)

    # --- the matrix, both ways
    def _transform(self):
        import vtk

        matrix = vtk.vtkMatrix4x4()
        if self._node is not None:
            self._node.GetMatrixTransformToParent(matrix)
        transform = vtk.vtkTransform()
        transform.SetMatrix(matrix)
        return transform

    def _readNode(self):
        if self._node is None:
            return
        transform = self._transform()
        values = transform.GetPosition() if self._type == self.TRANSLATION else transform.GetOrientation()
        self._updating = True
        try:
            for slider, value in zip(self._sliders, values):
                slider.setValue(float(value))
        finally:
            self._updating = False

    def _onSliderChanged(self, *_):
        if self._updating or self._node is None:
            return
        import vtk

        current = self._transform()
        position = list(current.GetPosition())
        orientation = list(current.GetOrientation())
        values = [float(slider.value) if not callable(slider.value) else float(slider.value()) for slider in self._sliders]
        if self._type == self.TRANSLATION:
            position = values
        else:
            orientation = values
        transform = vtk.vtkTransform()
        transform.Translate(*position)
        transform.RotateZ(orientation[2])
        transform.RotateX(orientation[0])
        transform.RotateY(orientation[1])
        self._node.SetMatrixTransformToParent(transform.GetMatrix())
        self.valuesChanged.emit()


class qSlicerVolumeRenderingPresetComboBox(QWidget):
    """Placeholder for the volume rendering preset chooser: its named parts, and its signal.

    The real widget holds a "Presets" label and a preset combo box, which a module may hide by
    name (VirtualCathLab does, and offers presets of its own), and says when the preset's offset
    is changed. The chooser itself is not drawn yet; the parts are there to be found.
    """
    presetOffsetChanged = Signal("presetOffsetChanged(double,double,bool)")
    currentNodeChanged = Signal("currentNodeChanged(vtkMRMLNode*)")

    def __init__(self, parent=None):
        super().__init__(parent)
        from .widgets import QComboBox, QHBoxLayout, QLabel

        layout = QHBoxLayout()
        self._label = QLabel("Presets", self)
        self._label.setObjectName("PresetsLabel")
        layout.addWidget(self._label)
        self._combo = QComboBox(self)
        self._combo.setObjectName("PresetComboBox")
        layout.addWidget(self._combo)
        self.setLayout(layout)
        self._node = None

    def setMRMLScene(self, scene):
        self._scene = scene

    def setCurrentNode(self, node):
        self._node = node
        self.currentNodeChanged.emit(node)

    def currentNode(self):
        return self._node

    # The chooser applies a preset to a volume property node; which node is set here.
    def setMRMLVolumePropertyNode(self, node):
        self._volumePropertyNode = node

    def mrmlVolumePropertyNode(self):
        return getattr(self, "_volumePropertyNode", None)

    def setShowIcons(self, show):
        self._showIcons = bool(show)

    def updateWidgetToMRML(self):
        pass


class qMRMLVolumePropertyNodeWidget(QWidget):
    """Placeholder for the transfer function editor: keeps the volume property node it is given.

    Editing the transfer functions is not offered here yet; the Volume Rendering module's own
    panel is where a volume's rendering is set up.
    """
    volumePropertyNodeChanged = Signal("volumePropertyNodeChanged()")

    def __init__(self, parent=None):
        super().__init__(parent)
        self._node = None

    def setMRMLVolumePropertyNode(self, node):
        self._node = node
        self.volumePropertyNodeChanged.emit()

    def mrmlVolumePropertyNode(self):
        return self._node

    def setMRMLScene(self, scene):
        self._scene = scene

    def setThresholdEnabled(self, enabled):
        self._thresholdEnabled = bool(enabled)

    def moveAllPoints(self, x, y=0.0, dontMoveFirstAndLast=False):
        """Shift the transfer function's points, as a preset's offset slider does.

        The node's scalar opacity and colour functions are moved by *x* along the scalar axis,
        which is what the real widget does with its points; the editor is not drawn here.
        """
        node = self._node
        if node is None or not x:
            return
        import vtk

        for getter in ("GetScalarOpacity", "GetColor"):
            function = getattr(node, getter, lambda: None)()
            if function is None:
                continue
            size = function.GetSize()
            values = 6 if isinstance(function, vtk.vtkColorTransferFunction) else 4
            points = []
            for i in range(size):
                point = [0.0] * values
                function.GetNodeValue(i, point)
                points.append(point)
            for i, point in enumerate(points):
                if dontMoveFirstAndLast and i in (0, size - 1):
                    continue
                point[0] += x
            function.RemoveAllPoints()
            for point in points:
                if values == 6:
                    function.AddRGBPoint(point[0], point[1], point[2], point[3], point[4], point[5])
                else:
                    function.AddPoint(point[0], point[1], point[2], point[3])


class qMRMLColorTableComboBox(qMRMLNodeComboBox):
    _addRemoveByDefault = False

    def __init__(self, parent=None):
        super().__init__(parent)
        self.nodeTypes = ["vtkMRMLColorTableNode"]


class _SubjectHierarchyModel:
    """The columns of qMRMLSubjectHierarchyModel, by name, for a module that hides some of them."""
    nameColumn, idColumn, visibilityColumn, colorColumn, transformColumn, descriptionColumn = 0, 1, 2, 3, 4, 5

    def columnCount(self, *args):
        return 6


class qMRMLSubjectHierarchyTreeView(QWidget):
    """Placeholder for the subject hierarchy tree of a module: keeps what it is told, draws nothing.

    The data panel's tree is the application's; a tree inside a module (CardiacDeviceSimulator
    lists its measurements in one) is not drawn yet. What a module sets on it at setup - which
    columns are hidden, the root item, the scene - is kept, so that the module gets past its setup.
    """
    currentItemChanged = Signal("currentItemChanged(vtkIdType)")
    currentItemsChanged = Signal("currentItemsChanged(QList<vtkIdType>)")
    editMenuActionVisible = QProp(True)
    selectRoleSubMenuVisible = QProp(True)
    multiSelection = QProp(False)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._model = _SubjectHierarchyModel()
        self._hiddenColumns = set()
        self._rootItem = 0
        self._nodeTypes = []

    def setCurrentItem(self, item):
        self._item = item

    def currentItem(self):
        return getattr(self, "_item", 0)

    def currentItems(self, idList=None):
        """The selected items: returned, or put into the vtkIdList given, as the desktop tree does
        (modules call currentItems(idList) and read the list)."""
        items = [self.currentItem()] if self.currentItem() else []
        if idList is None:
            return items
        idList.Reset()
        for item in items:
            idList.InsertNextId(item)
        return None

    def setMRMLScene(self, scene):
        self._scene = scene

    def mrmlScene(self):
        return getattr(self, "_scene", None)

    def model(self):
        return self._model

    def sortFilterProxyModel(self):
        return self._model

    def setColumnHidden(self, column, hidden):
        (self._hiddenColumns.add if hidden else self._hiddenColumns.discard)(column)

    def isColumnHidden(self, column):
        return column in self._hiddenColumns

    def hideColumn(self, column):
        self.setColumnHidden(column, True)

    def showColumn(self, column):
        self.setColumnHidden(column, False)

    def setRootItem(self, item):
        self._rootItem = item

    def rootItem(self):
        return self._rootItem

    def setNodeTypes(self, types):
        self._nodeTypes = list(types)

    def nodeTypes(self):
        return list(self._nodeTypes)

    def expandToDepth(self, depth):
        pass

    def resetColumnSizesToDefault(self):
        pass


class qMRMLThreeDWidget(QWidget):
    """A 3D view of its own, for a view node the module makes (Baffle Planner renders a flattened
    model in one and captures it into an image to print). The view is a browser view like those of
    the layout, drawn on a canvas inside the widget; a widget that is not placed in the page is kept
    off screen, where its view still renders and can be captured (vtkWindowToImageFilter)."""

    _count = 0

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = None
        self._viewNode = None
        self._view = None
        self._size = (400, 400)
        self.viewLabel = ""
        self.viewColor = None

    def setMRMLScene(self, scene):
        self._scene = scene

    def mrmlScene(self):
        return self._scene

    def setMRMLViewNode(self, viewNode):
        if viewNode is self._viewNode:
            return
        self._releaseView()
        self._viewNode = viewNode

    def mrmlViewNode(self):
        return self._viewNode

    def resize(self, width, height=None):
        if height is None:
            width, height = width.width(), width.height()
        self._size = (int(width), int(height))
        if self._view is not None:
            self._view.SetSize(*self._size)

    def show(self):
        super().show()
        self._ensureView()

    def threeDView(self):
        from ..layout import ThreeDView

        self._ensureView()
        return ThreeDView(self._view) if self._view is not None else None

    def viewLogic(self):
        self._ensureView()
        return self._view.GetViewLogic() if self._view is not None else None

    def _ensureView(self):
        if self._view is not None or self._viewNode is None:
            return
        import slicer

        qMRMLThreeDWidget._count += 1
        canvasID = f"sw-threed-widget-{qMRMLThreeDWidget._count}"
        canvas = dom.create("canvas")
        canvas.id = canvasID
        canvas.width, canvas.height = self._size
        self._el.appendChild(canvas)
        if not getattr(self._el, "isConnected", False):
            offscreen = dom.query("#sw-offscreen-views")
            if not offscreen:  # None, or JavaScript's null
                offscreen = dom.create("div")
                offscreen.id = "sw-offscreen-views"
                offscreen.style.position = "fixed"
                offscreen.style.left = "-100000px"
                offscreen.style.top = "0"
                body = dom.query("body")
                if body:
                    body.appendChild(offscreen)
            offscreen.appendChild(self._el)
        view = slicer.vtkSlicerWebThreeDView()
        view.SetCanvasSelector("#" + canvasID)
        view.SetSize(*self._size)
        layoutName = self._viewNode.GetSingletonTag() or self._viewNode.GetLayoutName()
        if not view.Initialize(slicer.app.applicationLogic(), self._scene or slicer.mrmlScene, layoutName):
            raise RuntimeError(f"The 3D view of {layoutName} could not be made")
        view.Start()
        self._view = view

    def _releaseView(self):
        if self._view is not None:
            self._view.Finalize()
            self._view = None
            while self._el.firstChild:
                self._el.removeChild(self._el.firstChild)


class qMRMLSliceWidget(QWidget):
    pass


class qMRMLTableView(QWidget):
    def setMRMLTableNode(self, node):
        self._node = node

    # Selection options: the table is shown read-only, as QTableWidget's is
    def setSelectionMode(self, mode):
        pass

    def setSelectionBehavior(self, behavior):
        pass


class qSlicerAbstractModuleWidget(qSlicerWidget):
    """The Qt widget of a module's GUI: the parent a scripted module widget is made with.

    isEntered says whether the module is the one shown, as on the desktop: true from just before the
    module's enter() runs until just before its exit() does (slicerweb.modules sets it). Module code
    asks it of self.parent, to do something only while the module is shown.
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self._entered = False

    @property
    def isEntered(self):
        return self._entered


class qSlicerModuleWidget(qSlicerAbstractModuleWidget):
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

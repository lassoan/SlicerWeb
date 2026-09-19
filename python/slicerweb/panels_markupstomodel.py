"""Bridge methods of the web GUI of the MarkupsToModel module (MarkupsToModel extension).

The desktop GUI (qSlicerMarkupsToModelModuleWidget) is a Qt C++ widget; the web GUI
(web/src/app/modules/MarkupsToModelPanel.vue) uses the same MRML parameter node
(vtkMRMLMarkupsToModelNode) and module logic (vtkSlicerMarkupsToModelLogic).
"""

import slicer

from .bridge import method

# Parameter node properties: web name -> (getter, setter, type)
_PROPERTIES = {
    "modelType": ("GetModelType", "SetModelType", int),
    "curveType": ("GetCurveType", "SetCurveType", int),
    "pointParameterType": ("GetPointParameterType", "SetPointParameterType", int),
    "polynomialOrder": ("GetPolynomialOrder", "SetPolynomialOrder", int),
    "polynomialFitType": ("GetPolynomialFitType", "SetPolynomialFitType", int),
    "polynomialSampleWidth": ("GetPolynomialSampleWidth", "SetPolynomialSampleWidth", float),
    "polynomialWeightType": ("GetPolynomialWeightType", "SetPolynomialWeightType", int),
    "kochanekTension": ("GetKochanekTension", "SetKochanekTension", float),
    "kochanekBias": ("GetKochanekBias", "SetKochanekBias", float),
    "kochanekContinuity": ("GetKochanekContinuity", "SetKochanekContinuity", float),
    "kochanekEndsCopyNearestDerivatives": ("GetKochanekEndsCopyNearestDerivatives", "SetKochanekEndsCopyNearestDerivatives", bool),
    "tubeRadius": ("GetTubeRadius", "SetTubeRadius", float),
    "tubeSegmentsBetweenControlPoints": ("GetTubeSegmentsBetweenControlPoints", "SetTubeSegmentsBetweenControlPoints", int),
    "tubeNumberOfSides": ("GetTubeNumberOfSides", "SetTubeNumberOfSides", int),
    "tubeLoop": ("GetTubeLoop", "SetTubeLoop", bool),
    "tubeCapping": ("GetTubeCapping", "SetTubeCapping", bool),
    "autoUpdateOutput": ("GetAutoUpdateOutput", "SetAutoUpdateOutput", bool),
    "cleanMarkups": ("GetCleanMarkups", "SetCleanMarkups", bool),
    "butterflySubdivision": ("GetButterflySubdivision", "SetButterflySubdivision", bool),
    "delaunayAlpha": ("GetDelaunayAlpha", "SetDelaunayAlpha", float),
    "convexHull": ("GetConvexHull", "SetConvexHull", bool),
}


def _node(nodeID):
    node = slicer.mrmlScene.GetNodeByID(nodeID)
    if node is None or not node.IsA("vtkMRMLMarkupsToModelNode"):
        raise ValueError(f"{nodeID} is not a MarkupsToModel parameter node")
    return node


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(round(max(0.0, min(1.0, c)) * 255)) for c in rgb)


def _logic():
    return slicer.modules.markupstomodel.logic()


def _outputModel(node, create=False):
    model = node.GetOutputModelNode()
    if model is None and create:
        model = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLModelNode", slicer.mrmlScene.GenerateUniqueName(node.GetName() + " model"))
        model.CreateDefaultDisplayNodes()
        display = model.GetDisplayNode()
        display.SetColor(1.0, 0.5, 0.0)
        display.SetOpacity(0.6)
        display.SetVisibility2D(True)
        node.SetAndObserveOutputModelNodeID(model.GetID())
    return model


@method()
def markupsToModelInfo(nodeID):
    node = _node(nodeID)
    info = {name: prop[2](getattr(node, prop[0])()) for name, prop in _PROPERTIES.items()}
    inputNode = node.GetInputNode()
    info["inputNodeID"] = inputNode.GetID() if inputNode else None
    info["inputPoints"] = inputNode.GetNumberOfControlPoints() if inputNode is not None and hasattr(inputNode, "GetNumberOfControlPoints") else 0
    model = node.GetOutputModelNode()
    info["outputModelNodeID"] = model.GetID() if model else None
    info["outputPoints"] = model.GetPolyData().GetNumberOfPoints() if model is not None and model.GetPolyData() else 0
    info["curveLength"] = node.GetOutputCurveLength() if hasattr(node, "GetOutputCurveLength") else 0.0
    display = model.GetDisplayNode() if model else None
    if display is not None:
        info["display"] = {
            "visible": bool(display.GetVisibility()),
            "color": _hex(display.GetColor()),
            "opacity": display.GetOpacity(),
            "sliceIntersection": bool(display.GetVisibility2D()),
        }
    else:
        info["display"] = None
    return info


@method()
def setMarkupsToModel(nodeID, properties):
    node = _node(nodeID)
    wasModified = node.StartModify()
    try:
        for name, value in properties.items():
            if name in _PROPERTIES:
                getattr(node, _PROPERTIES[name][1])(_PROPERTIES[name][2](value))
            elif name == "inputNodeID":
                # the logic updates the output when the points change (auto-update): create it first
                if value:
                    _outputModel(node, create=True)
                node.SetAndObserveInputNodeID(value or None)
            elif name == "outputModelNodeID":
                node.SetAndObserveOutputModelNodeID(value or None)
    finally:
        node.EndModify(wasModified)
    display = properties.get("display")
    model = node.GetOutputModelNode()
    if display and model is not None:
        if model.GetDisplayNode() is None:
            model.CreateDefaultDisplayNodes()
        d = model.GetDisplayNode()
        if "visible" in display:
            d.SetVisibility(bool(display["visible"]))
        if "color" in display:
            c = display["color"].lstrip("#")
            d.SetColor(*(int(c[i:i + 2], 16) / 255.0 for i in (0, 2, 4)))
        if "opacity" in display:
            d.SetOpacity(float(display["opacity"]))
        if "sliceIntersection" in display:
            d.SetVisibility2D(bool(display["sliceIntersection"]))
    if node.GetAutoUpdateOutput() and node.GetInputNode() is not None and any(k in _PROPERTIES for k in properties):
        _outputModel(node, create=True)
        _logic().UpdateOutputModel(node)
    return True


@method()
def markupsToModelUpdate(nodeID):
    """Update button: create the output model if needed and compute it from the input points."""
    node = _node(nodeID)
    if node.GetInputNode() is None:
        raise ValueError("Select input points")
    _outputModel(node, create=True)
    _logic().UpdateOutputModel(node)
    return True


@method()
def markupsToModelCreateInput(nodeID):
    """Create an input point list for the parameter node (like the desktop widget's "Create new")."""
    node = _node(nodeID)
    points = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", slicer.mrmlScene.GenerateUniqueName("Points"))
    points.CreateDefaultDisplayNodes()
    _outputModel(node, create=True)
    node.SetAndObserveInputNodeID(points.GetID())
    return points.GetID()


@method()
def markupsToModelPlace(nodeID, enabled=True):
    """Place points into the input node (qSlicerMarkupsPlaceWidget)."""
    node = _node(nodeID)
    inputNode = node.GetInputNode()
    appLogic = slicer.app.applicationLogic()
    interaction = appLogic.GetInteractionNode()
    if enabled and inputNode is not None and inputNode.IsA("vtkMRMLMarkupsNode"):
        selection = appLogic.GetSelectionNode()
        selection.SetReferenceActivePlaceNodeClassName(inputNode.GetClassName())
        selection.SetActivePlaceNodeID(inputNode.GetID())
        interaction.SetPlaceModePersistence(1)
        interaction.SetCurrentInteractionMode(interaction.Place)
    else:
        interaction.SetCurrentInteractionMode(interaction.ViewTransform)
    return True

"""Bridge methods of the View Controllers module GUI, and of the transform display and node list
of the Transforms module GUI.

View Controllers edits the properties of a view chosen from the layout: for a slice view what
qMRMLSliceControllerWidget offers, for a 3D view what qMRMLThreeDViewControllerWidget offers.
"""

import slicer
import vtk

from .bridge import method

# ------------------------------------------------------------------------------ views

_ORIENTATION_MARKERS = ["None", "Cube", "Human", "Axes"]
_ORIENTATION_MARKER_SIZES = ["Small", "Medium", "Large"]
_RULERS = ["None", "Thin", "Thick"]


def _views_of(description, out):
    if not isinstance(description, dict):
        return
    if description.get("type") == "view":
        out.append({k: description.get(k) for k in ("layoutName", "kind", "className", "label", "color", "nodeID")})
        return
    for child in description.get("children") or []:
        _views_of(child, out)


@method()
def listViews():
    """The views of the current layout, in layout order: [{layoutName, kind, label, color, nodeID}]."""
    views = []
    _views_of(slicer.app.layoutManager().layoutDescription(), views)
    return views


def _viewNode(layoutName):
    lm = slicer.app.layoutManager()
    widget = lm.sliceWidget(layoutName)
    if widget is not None:
        return widget.mrmlSliceNode(), "slice"
    # A 3D view is found by its layout name on the node; the layout manager's threeDWidget() takes
    # an index, not a name.
    node = None
    for candidate in slicer.util.getNodesByClass("vtkMRMLViewNode"):
        if candidate.GetLayoutName() == layoutName:
            node = candidate
            break
    return node, "threeD"


@method()
def viewControllerInfo(layoutName):
    """What the View Controllers module shows for this view, by its kind."""
    from . import bridge

    node, kind = _viewNode(layoutName)
    if node is None:
        return None
    common = {
        "layoutName": layoutName,
        "kind": kind,
        "label": node.GetLayoutLabel() or layoutName,
        "color": [round(c, 3) for c in node.GetLayoutColor()],
        "orientationMarker": _ORIENTATION_MARKERS[node.GetOrientationMarkerType()],
        "orientationMarkerSize": _ORIENTATION_MARKER_SIZES[node.GetOrientationMarkerSize()],
        "ruler": _RULERS[node.GetRulerType()],
        "orientationMarkers": _ORIENTATION_MARKERS,
        "orientationMarkerSizes": _ORIENTATION_MARKER_SIZES,
        "rulers": _RULERS,
    }
    if kind == "slice":
        state = bridge.getSliceViewState(layoutName) or {}
        state.update(common)
        state["linked"] = bool(bridge.getViewLinked(layoutName))
        state["orientations"] = ["Axial", "Sagittal", "Coronal", "Reformat"]
        state["volumes"] = [{"id": v.GetID(), "name": v.GetName()} for v in slicer.util.getNodesByClass("vtkMRMLVolumeNode")
                            if not v.GetHideFromEditors()]
        return state
    common.update({
        "boxVisible": bool(node.GetBoxVisible()),
        "axisLabelsVisible": bool(node.GetAxisLabelsVisible()),
        "backgroundColor": [round(c, 3) for c in node.GetBackgroundColor()],
        "backgroundColor2": [round(c, 3) for c in node.GetBackgroundColor2()],
        "linked": bool(node.GetLinkedControl()),
        "renderMode": "orthographic" if node.GetRenderMode() == node.Orthographic else "perspective",
    })
    return common


@method()
def setViewControllerProperties(layoutName, properties):
    """Set what viewControllerInfo reports; keys not given are left alone."""
    from . import bridge

    node, kind = _viewNode(layoutName)
    if node is None:
        return False
    wasModifying = node.StartModify()
    try:
        if "orientationMarker" in properties:
            node.SetOrientationMarkerType(_ORIENTATION_MARKERS.index(properties["orientationMarker"]))
        if "orientationMarkerSize" in properties:
            node.SetOrientationMarkerSize(_ORIENTATION_MARKER_SIZES.index(properties["orientationMarkerSize"]))
        if "ruler" in properties:
            node.SetRulerType(_RULERS.index(properties["ruler"]))
        if kind == "threeD":
            if "boxVisible" in properties:
                node.SetBoxVisible(1 if properties["boxVisible"] else 0)
            if "axisLabelsVisible" in properties:
                node.SetAxisLabelsVisible(1 if properties["axisLabelsVisible"] else 0)
            if "backgroundColor" in properties:
                node.SetBackgroundColor(*[float(c) for c in properties["backgroundColor"]])
            if "backgroundColor2" in properties:
                node.SetBackgroundColor2(*[float(c) for c in properties["backgroundColor2"]])
            if "linked" in properties:
                node.SetLinkedControl(1 if properties["linked"] else 0)
            if "renderMode" in properties:
                node.SetRenderMode(node.Orthographic if properties["renderMode"] == "orthographic" else node.Perspective)
    finally:
        node.EndModify(wasModifying)
    if kind == "slice":
        # The slice view's own state goes through the slice logic, as the view's bar does, so that
        # linked views follow.
        if "orientation" in properties:
            bridge.setSliceOrientation(layoutName, properties["orientation"])
        if "offset" in properties:
            bridge.setSliceOffset(layoutName, float(properties["offset"]))
        for layer, key in (("background", "backgroundVolumeID"), ("foreground", "foregroundVolumeID"), ("label", "labelVolumeID")):
            if key in properties:
                bridge.setSliceLayerVolume(layoutName, layer, properties[key] or None)
        if "sliceVisible" in properties:
            bridge.setSliceVisible(layoutName, bool(properties["sliceVisible"]))
        if "linked" in properties:
            bridge.setViewLinked(layoutName, bool(properties["linked"]))
        composite = slicer.app.layoutManager().sliceWidget(layoutName).sliceLogic().GetSliceCompositeNode()
        if "foregroundOpacity" in properties:
            composite.SetForegroundOpacity(float(properties["foregroundOpacity"]))
        if "labelOpacity" in properties:
            composite.SetLabelOpacity(float(properties["labelOpacity"]))
    return True


@method()
def fitView(layoutName):
    """Frame what the view shows: fit the slice, or reset the 3D camera."""
    lm = slicer.app.layoutManager()
    widget = lm.sliceWidget(layoutName)
    if widget is not None:
        widget.sliceLogic().FitSliceToAll()
        return True
    view = lm.view(layoutName) if hasattr(lm, "view") else None
    if view is not None:
        view.ResetCamera(-1)
    return view is not None


# ------------------------------------------------------------------------------ transforms

_EDITOR_FLAGS = {
    "handlesVisible": "EditorVisibility",
    "handlesIn3D": "EditorVisibility3D",
    "handlesInSlices": "EditorSliceIntersectionVisibility",
    "translation": "EditorTranslationEnabled",
    "rotation": "EditorRotationEnabled",
    "scaling": "EditorScalingEnabled",
}


def _displayNode(transformNodeID, create=False):
    """The transform's display node; made only when asked to, since making one changes the scene.

    A read that made one would fire scene-changed, and a panel that reads again on scene-changed
    would then read for ever.
    """
    from .bridge import _node

    node = _node(transformNodeID)
    display = node.GetDisplayNode()
    if display is None and create:
        node.CreateDefaultDisplayNodes()
        display = node.GetDisplayNode()
    return display


@method()
def transformDisplayInfo(transformNodeID):
    """The interaction handles of a transform, as vtkMRMLTransformDisplayNode keeps them.

    A transform without a display node has none showing: that is what is reported, without
    making one.
    """
    display = _displayNode(transformNodeID)
    if display is None:
        info = {key: False for key in _EDITOR_FLAGS}
        info.update({"handlesIn3D": True, "handlesInSlices": True, "translation": True, "rotation": True, "scaling": True})
        info["visible"] = False
        return info
    info = {key: bool(getattr(display, "Get" + attr)()) for key, attr in _EDITOR_FLAGS.items()}
    info["visible"] = bool(display.GetVisibility())
    return info


@method()
def setTransformDisplay(transformNodeID, properties):
    display = _displayNode(transformNodeID, create=True)
    if display is None:
        return False
    wasModifying = display.StartModify()
    try:
        for key, attr in _EDITOR_FLAGS.items():
            if key in properties:
                getattr(display, "Set" + attr)(bool(properties[key]))
        if "visible" in properties:
            display.SetVisibility(bool(properties["visible"]))
    finally:
        display.EndModify(wasModifying)
    return True


@method()
def transformableNodes(transformNodeID):
    """The nodes a transform can be applied to, and whether this one is: [{id, name, className, transformed}].

    Transforms themselves are among them (a transform can be under another), but not the one asked
    about, which cannot be its own parent.
    """
    out = []
    for node in slicer.util.getNodesByClass("vtkMRMLTransformableNode"):
        if node.GetHideFromEditors() or node.GetID() == transformNodeID:
            continue
        if node.IsA("vtkMRMLSliceNode") or node.IsA("vtkMRMLCameraNode") or node.IsA("vtkMRMLDisplayNode"):
            continue
        out.append({
            "id": node.GetID(),
            "name": node.GetName(),
            "className": node.GetClassName(),
            "transformed": node.GetTransformNodeID() == transformNodeID,
        })
    return out

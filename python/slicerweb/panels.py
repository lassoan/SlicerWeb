"""Bridge methods used by the web GUIs of Slicer's core modules.

Each function gathers the state shown by a module GUI in one call (instead of many small property
reads) and applies changes with the same MRML/logic calls as the desktop Qt module widgets.
"""

import logging

from .bridge import _node, method

logger = logging.getLogger("slicerweb.panels")


def _app():
    import slicer

    return slicer.app


def _logic(name):
    return _app().applicationLogic().GetModuleLogic(name)


def _color_hex(rgb):
    return "#%02x%02x%02x" % tuple(int(max(0, min(1, c)) * 255 + 0.5) for c in rgb[:3])


def _hex_color(value):
    value = value.lstrip("#")
    return [int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]


# --------------------------------------------------------------------------- Volumes
@method()
def volumeInfo(nodeID):
    node = _node(nodeID)
    image = node.GetImageData()
    display = node.GetDisplayNode()
    info = {
        "id": nodeID,
        "name": node.GetName(),
        "className": node.GetClassName(),
        "isLabelmap": node.IsA("vtkMRMLLabelMapVolumeNode"),
        "spacing": list(node.GetSpacing()),
        "origin": list(node.GetOrigin()),
        "dimensions": list(image.GetDimensions()) if image else [0, 0, 0],
        "scalarType": image.GetScalarTypeAsString() if image else "",
        "numberOfComponents": image.GetNumberOfScalarComponents() if image else 0,
        "scalarRange": list(image.GetScalarRange()) if image else [0, 1],
        "displayNodeID": display.GetID() if display else None,
    }
    if display is not None and display.IsA("vtkMRMLScalarVolumeDisplayNode"):
        info.update({
            "window": display.GetWindow(),
            "level": display.GetLevel(),
            "autoWindowLevel": bool(display.GetAutoWindowLevel()),
            "applyThreshold": bool(display.GetApplyThreshold()),
            "lowerThreshold": display.GetLowerThreshold(),
            "upperThreshold": display.GetUpperThreshold(),
            "interpolate": bool(display.GetInterpolate()),
            "colorNodeID": display.GetColorNodeID(),
        })
    if display is not None and display.IsA("vtkMRMLLabelMapVolumeDisplayNode"):
        info["colorNodeID"] = display.GetColorNodeID()
    return info


@method()
def setVolumeDisplay(nodeID, properties):
    node = _node(nodeID)
    display = node.GetDisplayNode()
    if display is None:
        return False
    wasModifying = display.StartModify()
    try:
        if "window" in properties or "level" in properties:
            display.SetAutoWindowLevel(False)
            display.SetWindowLevel(float(properties.get("window", display.GetWindow())),
                                   float(properties.get("level", display.GetLevel())))
        if "autoWindowLevel" in properties:
            display.SetAutoWindowLevel(bool(properties["autoWindowLevel"]))
        if "applyThreshold" in properties:
            display.SetApplyThreshold(bool(properties["applyThreshold"]))
        if "lowerThreshold" in properties or "upperThreshold" in properties:
            display.SetThreshold(float(properties.get("lowerThreshold", display.GetLowerThreshold())),
                                 float(properties.get("upperThreshold", display.GetUpperThreshold())))
        if "interpolate" in properties:
            display.SetInterpolate(bool(properties["interpolate"]))
        if "colorNodeID" in properties:
            display.SetAndObserveColorNodeID(properties["colorNodeID"])
    finally:
        display.EndModify(wasModifying)
    return True


@method()
def volumeDisplayPresets():
    logic = _logic("Volumes")
    result = []
    for presetId in logic.GetVolumeDisplayPresetIDs():
        preset = logic.GetVolumeDisplayPreset(presetId)
        result.append({"id": presetId, "name": preset.name, "window": preset.window, "level": preset.level})
    return result


@method()
def applyVolumeDisplayPreset(nodeID, presetId):
    node = _node(nodeID)
    _logic("Volumes").ApplyVolumeDisplayPreset(node.GetDisplayNode(), presetId)
    return True


@method()
def colorTables():
    import slicer

    scene = slicer.mrmlScene
    nodes = scene.GetNodesByClass("vtkMRMLColorNode")
    result = []
    for i in range(nodes.GetNumberOfItems()):
        n = nodes.GetItemAsObject(i)
        result.append({"id": n.GetID(), "name": n.GetName(), "category": n.GetAttribute("Category") or ""})
    return result


# --------------------------------------------------------------------------- Models
@method()
def modelInfo(nodeID):
    node = _node(nodeID)
    poly = node.GetPolyData()
    d = node.GetDisplayNode()
    return {
        "id": nodeID,
        "name": node.GetName(),
        "points": poly.GetNumberOfPoints() if poly else 0,
        "cells": poly.GetNumberOfCells() if poly else 0,
        "visible": bool(d.GetVisibility()) if d else False,
        "visible2D": bool(d.GetVisibility2D()) if d else False,
        "color": _color_hex(d.GetColor()) if d else "#ffffff",
        "opacity": d.GetOpacity() if d else 1.0,
        "representation": d.GetRepresentation() if d else 2,
        "edgeVisibility": bool(d.GetEdgeVisibility()) if d else False,
        "backfaceCulling": bool(d.GetBackfaceCulling()) if d else False,
        "sliceIntersectionThickness": d.GetSliceIntersectionThickness() if d else 1,
        "scalarVisibility": bool(d.GetScalarVisibility()) if d else False,
        "activeScalarName": d.GetActiveScalarName() if d else None,
        "scalars": [poly.GetPointData().GetArrayName(i) for i in range(poly.GetPointData().GetNumberOfArrays())] if poly else [],
    }


@method()
def setModelDisplay(nodeID, properties):
    node = _node(nodeID)
    d = node.GetDisplayNode()
    if d is None:
        node.CreateDefaultDisplayNodes()
        d = node.GetDisplayNode()
    setters = {
        "visible": lambda v: d.SetVisibility(bool(v)),
        "visible2D": lambda v: d.SetVisibility2D(bool(v)),
        "color": lambda v: d.SetColor(*_hex_color(v)),
        "opacity": lambda v: d.SetOpacity(float(v)),
        "representation": lambda v: d.SetRepresentation(int(v)),
        "edgeVisibility": lambda v: d.SetEdgeVisibility(bool(v)),
        "backfaceCulling": lambda v: d.SetBackfaceCulling(bool(v)),
        "sliceIntersectionThickness": lambda v: d.SetSliceIntersectionThickness(int(v)),
        "scalarVisibility": lambda v: d.SetScalarVisibility(bool(v)),
        "activeScalarName": lambda v: d.SetActiveScalarName(v),
    }
    wasModifying = d.StartModify()
    try:
        for k, v in properties.items():
            if k in setters:
                setters[k](v)
    finally:
        d.EndModify(wasModifying)
    return True


# --------------------------------------------------------------------------- Markups
@method()
def markupsInfo(nodeID):
    node = _node(nodeID)
    d = node.GetDisplayNode()
    points = []
    for i in range(node.GetNumberOfControlPoints()):
        pos = [0.0, 0.0, 0.0]
        node.GetNthControlPointPositionWorld(i, pos)
        points.append({
            "index": i,
            "label": node.GetNthControlPointLabel(i),
            "position": pos,
            "selected": bool(node.GetNthControlPointSelected(i)),
            "visible": bool(node.GetNthControlPointVisibility(i)),
            "locked": bool(node.GetNthControlPointLocked(i)),
        })
    measurements = []
    for i in range(node.GetNumberOfMeasurements()):
        m = node.GetNthMeasurement(i)
        if m.GetEnabled() and m.GetValueDefined():
            measurements.append({"name": m.GetName(), "value": m.GetValue(), "units": m.GetUnits(), "text": m.GetValueWithUnitsAsPrintableString()})
    return {
        "id": nodeID,
        "name": node.GetName(),
        "className": node.GetClassName(),
        "markupType": node.GetMarkupType(),
        "controlPoints": points,
        "measurements": measurements,
        "locked": bool(node.GetLocked()),
        "visible": bool(d.GetVisibility()) if d else False,
        "color": _color_hex(d.GetSelectedColor()) if d else "#ffffff",
        "glyphScale": d.GetGlyphScale() if d else 3.0,
        "textScale": d.GetTextScale() if d else 3.0,
        "fillOpacity": d.GetFillOpacity() if d else 0.5,
    }


@method()
def setMarkupsDisplay(nodeID, properties):
    node = _node(nodeID)
    d = node.GetDisplayNode()
    setters = {
        "visible": lambda v: d.SetVisibility(bool(v)),
        "color": lambda v: d.SetSelectedColor(*_hex_color(v)),
        "glyphScale": lambda v: d.SetGlyphScale(float(v)),
        "textScale": lambda v: d.SetTextScale(float(v)),
        "fillOpacity": lambda v: d.SetFillOpacity(float(v)),
        "locked": lambda v: node.SetLocked(bool(v)),
    }
    for k, v in properties.items():
        if k in setters:
            setters[k](v)
    return True


@method()
def markupsControlPoint(nodeID, index, action, value=None):
    node = _node(nodeID)
    index = int(index)
    if action == "delete":
        node.RemoveNthControlPoint(index)
    elif action == "label":
        node.SetNthControlPointLabel(index, str(value))
    elif action == "position":
        node.SetNthControlPointPositionWorld(index, *[float(v) for v in value])
    elif action == "visible":
        node.SetNthControlPointVisibility(index, bool(value))
    elif action == "locked":
        node.SetNthControlPointLocked(index, bool(value))
    elif action == "jump":
        import slicer

        pos = [0.0, 0.0, 0.0]
        node.GetNthControlPointPositionWorld(index, pos)
        slicer.vtkMRMLSliceNode.JumpAllSlices(slicer.mrmlScene, *pos, slicer.vtkMRMLSliceNode.CenteredJumpSlice)
    elif action == "clear":
        node.RemoveAllControlPoints()
    return True


# --------------------------------------------------------------------------- Segmentations
@method()
def segmentationInfo(nodeID):
    node = _node(nodeID)
    seg = node.GetSegmentation()
    d = node.GetDisplayNode()
    segments = []
    for i in range(seg.GetNumberOfSegments()):
        sid = seg.GetNthSegmentID(i)
        s = seg.GetSegment(sid)
        segments.append({
            "id": sid,
            "name": s.GetName(),
            "color": _color_hex(s.GetColor()),
            "visible": bool(d.GetSegmentVisibility(sid)) if d else True,
            "opacity": d.GetSegmentOpacity3D(sid) if d else 1.0,
        })
    return {
        "id": nodeID,
        "name": node.GetName(),
        "segments": segments,
        "sourceRepresentation": seg.GetSourceRepresentationName(),
        "hasClosedSurface": bool(seg.ContainsRepresentation("Closed surface")),
        "visible": bool(d.GetVisibility()) if d else False,
        "opacity2DFill": d.GetOpacity2DFill() if d else 0.5,
        "opacity3D": d.GetOpacity3D() if d else 1.0,
    }


@method()
def setSegment(nodeID, segmentID, properties):
    node = _node(nodeID)
    seg = node.GetSegmentation()
    s = seg.GetSegment(segmentID)
    d = node.GetDisplayNode()
    if "name" in properties:
        s.SetName(properties["name"])
    if "color" in properties:
        s.SetColor(*_hex_color(properties["color"]))
    if "visible" in properties and d:
        d.SetSegmentVisibility(segmentID, bool(properties["visible"]))
    if "opacity" in properties and d:
        d.SetSegmentOpacity3D(segmentID, float(properties["opacity"]))
    return True


@method()
def setSegmentationDisplay(nodeID, properties):
    node = _node(nodeID)
    d = node.GetDisplayNode()
    if "visible" in properties:
        d.SetVisibility(bool(properties["visible"]))
    if "opacity2DFill" in properties:
        d.SetOpacity2DFill(float(properties["opacity2DFill"]))
    if "opacity3D" in properties:
        d.SetOpacity3D(float(properties["opacity3D"]))
    if "showSurfaces" in properties:
        if properties["showSurfaces"]:
            node.CreateClosedSurfaceRepresentation()
        else:
            node.RemoveClosedSurfaceRepresentation()
    return True


@method()
def removeSegment(nodeID, segmentID):
    _node(nodeID).GetSegmentation().RemoveSegment(segmentID)
    return True


@method()
def createSegmentation(sourceVolumeID=None, name="Segmentation"):
    import slicer

    node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", name)
    node.CreateDefaultDisplayNodes()
    if sourceVolumeID:
        node.SetReferenceImageGeometryParameterFromVolumeNode(_node(sourceVolumeID))
    return node


# --------------------------------------------------------------------------- Volume rendering
@method()
def volumeRenderingInfo(volumeNodeID):
    import slicer

    logic = _logic("VolumeRendering")
    volume = _node(volumeNodeID)
    displayNode = logic.GetFirstVolumeRenderingDisplayNode(volume)
    presets = logic.GetPresetsScene().GetNodesByClass("vtkMRMLVolumePropertyNode")
    names = [presets.GetItemAsObject(i).GetName() for i in range(presets.GetNumberOfItems())]
    # How hard the views work at a volume is a property of the view, not of the volume, so it is
    # read from the first 3D view (they are all set together below).
    viewNodes = [slicer.mrmlScene.GetNthNodeByClass(i, "vtkMRMLViewNode")
                 for i in range(slicer.mrmlScene.GetNumberOfNodesByClass("vtkMRMLViewNode"))]
    info = {"visible": False, "presets": names, "preset": None, "shift": 0.0, "shiftRange": [-500.0, 500.0],
            "quality": viewNodes[0].GetVolumeRenderingQuality() if viewNodes else 0,
            "expectedFPS": viewNodes[0].GetExpectedFPS() if viewNodes else 8.0}
    if displayNode is not None:
        info["visible"] = bool(displayNode.GetVisibility())
        vp = displayNode.GetVolumePropertyNode()
        info["preset"] = vp.GetName() if vp else None
        info["shift"] = float(vp.GetAttribute("SlicerWeb.Shift") or 0.0) if vp else 0.0
        info["croppingEnabled"] = bool(displayNode.GetCroppingEnabled())
    return info


@method()
def setVolumeRendering(volumeNodeID, properties):
    import slicer

    logic = _logic("VolumeRendering")
    volume = _node(volumeNodeID)
    displayNode = logic.GetFirstVolumeRenderingDisplayNode(volume)
    if displayNode is None:
        # CreateDefaultVolumeRenderingNodes gives the volume the preset that suits what it holds -
        # MR-Default for the narrow range of an MR volume, a CT preset for the wide range of a CT.
        # UpdateDisplayNodeFromVolumeNode is deliberately not called after it: that replaces the
        # preset with a ramp made from the window and level, which for an MR volume renders as a
        # solid block, and it makes a cropping region before anyone has asked to crop anything.
        displayNode = logic.CreateDefaultVolumeRenderingNodes(volume)
    if "preset" in properties:
        preset = logic.GetPresetByName(properties["preset"])
        if preset:
            displayNode.GetVolumePropertyNode().Copy(preset)
    if "shift" in properties:
        # Same as the shift slider of qSlicerVolumeRenderingPresetComboBox: move all transfer
        # function points by the change of the shift value.
        vp = displayNode.GetVolumePropertyNode()
        previous = float(vp.GetAttribute("SlicerWeb.Shift") or 0.0)
        delta = float(properties["shift"]) - previous
        vp.SetAttribute("SlicerWeb.Shift", str(float(properties["shift"])))
        _shift_transfer_functions(vp.GetVolumeProperty(), delta)
    if "quality" in properties or "expectedFPS" in properties:
        # Adaptive quality takes coarser steps through the volume while the camera is moving and
        # goes back to full detail when it stops; the frame rate it aims for is what decides how
        # much detail it gives up (vtkMRMLVolumeRenderingDisplayableManager passes both to the
        # mapper). Normal and Maximum render the same whatever is happening.
        for i in range(slicer.mrmlScene.GetNumberOfNodesByClass("vtkMRMLViewNode")):
            viewNode = slicer.mrmlScene.GetNthNodeByClass(i, "vtkMRMLViewNode")
            if "quality" in properties:
                viewNode.SetVolumeRenderingQuality(int(properties["quality"]))
            if "expectedFPS" in properties:
                viewNode.SetExpectedFPS(float(properties["expectedFPS"]))
    if "croppingEnabled" in properties:
        # The region to crop to is made when cropping is first asked for, not before, and is shown
        # while cropping is on so that it can be moved and resized.
        cropping = bool(properties["croppingEnabled"])
        if cropping and displayNode.GetROINode() is None:
            logic.CreateROINode(displayNode)
            logic.FitROIToVolume(displayNode)
        roi = displayNode.GetROINode()
        if roi is not None:
            roi.CreateDefaultDisplayNodes()
            roi.GetDisplayNode().SetVisibility(cropping)
        displayNode.SetCroppingEnabled(cropping)
    if "visible" in properties:
        displayNode.SetVisibility(bool(properties["visible"]))
    return True


def _shift_transfer_functions(volumeProperty, delta):
    if not delta:
        return
    for tf in (volumeProperty.GetScalarOpacity(), volumeProperty.GetGradientOpacity()):
        values = [0.0] * 4
        for i in range(tf.GetSize()):
            tf.GetNodeValue(i, values)
            values[0] += delta
            tf.SetNodeValue(i, values)
    ctf = volumeProperty.GetRGBTransferFunction()
    values = [0.0] * 6
    for i in range(ctf.GetSize()):
        ctf.GetNodeValue(i, values)
        values[0] += delta
        ctf.SetNodeValue(i, values)


# --------------------------------------------------------------------------- Transforms
@method()
def transformInfo(nodeID):
    import vtk

    node = _node(nodeID)
    matrix = vtk.vtkMatrix4x4()
    linear = node.IsLinear()
    if linear:
        node.GetMatrixTransformToParent(matrix)
    return {
        "id": nodeID,
        "name": node.GetName(),
        "isLinear": bool(linear),
        "matrix": [[matrix.GetElement(r, c) for c in range(4)] for r in range(4)],
        "transformInfo": node.GetTransformInfo() if hasattr(node, "GetTransformInfo") else "",
    }


@method()
def setTransformMatrix(nodeID, matrix):
    import vtk

    node = _node(nodeID)
    m = vtk.vtkMatrix4x4()
    for r in range(4):
        for c in range(4):
            m.SetElement(r, c, float(matrix[r][c]))
    node.SetMatrixTransformToParent(m)
    return True


@method()
def applyTransformToNode(nodeID, transformNodeID, harden=False):
    node = _node(nodeID)
    node.SetAndObserveTransformNodeID(transformNodeID or None)
    if harden and transformNodeID:
        _logic("Transforms").hardenTransform(node) if hasattr(_logic("Transforms"), "hardenTransform") else node.HardenTransform()
    return True

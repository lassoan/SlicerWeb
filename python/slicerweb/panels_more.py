"""Bridge methods for the GUIs of the remaining core modules.

Same shape as :mod:`slicerweb.panels`: one call gathers what a module GUI shows, and changes are made
with the MRML nodes and module logic the desktop Qt widgets use.

Covers Texts, Colors, Terminologies, Scene Views, Tables, Plots, Sequences and Crop Volume.
"""

import logging
import os

import slicer
import vtk

from .bridge import _node, method

logger = logging.getLogger("slicerweb.panels")


def _color_hex(rgb):
    return "#%02x%02x%02x" % tuple(int(max(0, min(1, c)) * 255 + 0.5) for c in rgb[:3])


# ---------------------------------------------------------------------------------------- Texts
@method()
def textNodeInfo(nodeID):
    """Contents of a text node (Texts module)."""
    node = _node(nodeID)
    return {
        "name": node.GetName(),
        "text": node.GetText() or "",
        "encoding": node.GetEncoding(),
        "forceCreateStorageNode": bool(node.GetForceCreateStorageNode()),
    }


@method()
def setTextNodeText(nodeID, text):
    _node(nodeID).SetText(str(text))
    return True


# --------------------------------------------------------------------------------------- Colors
@method()
def colorNodeInfo(nodeID, maxColors=512):
    """Colours of a colour table or procedural colour node (Colors module)."""
    node = _node(nodeID)
    lookupTable = node.GetLookupTable()
    count = node.GetNumberOfColors() if hasattr(node, "GetNumberOfColors") else 0
    colors = []
    for index in range(min(count, maxColors)):
        rgba = [0.0, 0.0, 0.0, 0.0]
        if hasattr(node, "GetColor") and node.GetColor(index, rgba):
            colors.append({"index": index, "name": node.GetColorName(index), "color": _color_hex(rgba),
                           "opacity": round(rgba[3], 3)})
    valueRange = list(lookupTable.GetRange()) if lookupTable is not None else [0.0, 0.0]
    return {
        "name": node.GetName(),
        "type": node.GetTypeAsString() if hasattr(node, "GetTypeAsString") else node.GetClassName(),
        "category": node.GetAttribute("Category") or "",
        "count": count,
        "shown": len(colors),
        "range": valueRange,
        "colors": colors,
        "editable": bool(node.GetClassName() == "vtkMRMLColorTableNode" and node.GetType() == node.User),
    }


@method()
def setColorNodeColor(nodeID, index, color=None, name=None):
    """Change one entry of a user colour table (Colors module allows editing those)."""
    node = _node(nodeID)
    if color:
        value = color.lstrip("#")
        rgb = [int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
        node.SetColor(int(index), *rgb)
    if name is not None:
        node.SetColorName(int(index), str(name))
    return True


# -------------------------------------------------------------------------------- Terminologies
@method()
def terminologyContexts():
    """Terminology contexts loaded in the application (Terminologies module)."""
    logic = slicer.app.applicationLogic().GetModuleLogic("Terminologies")
    if logic is None:
        return {"terminologies": [], "anatomicContexts": []}
    terminologies = vtk.vtkStringArray()
    logic.GetLoadedTerminologyNames(terminologies)
    anatomic = vtk.vtkStringArray()
    logic.GetLoadedAnatomicContextNames(anatomic)
    return {
        "terminologies": [terminologies.GetValue(i) for i in range(terminologies.GetNumberOfValues())],
        "anatomicContexts": [anatomic.GetValue(i) for i in range(anatomic.GetNumberOfValues())],
    }


def _terminology_files():
    """The terminology files the application loaded (*.term.json of the Terminologies module)."""
    import glob
    import os

    from . import modules as module_manager

    share = module_manager.module_share_directory(slicer.app, "Terminologies")
    return sorted(glob.glob(os.path.join(share or "", "*.term.json")))


@method()
def terminologyCategories(terminologyName, search=""):
    """Categories of a terminology and the types in each.

    Read from the terminology files rather than from the module logic, whose category and type
    accessors take C++ vectors and are not available in Python.
    """
    import json

    search = (search or "").lower()
    for path in _terminology_files():
        try:
            with open(path, encoding="utf-8") as f:
                content = json.load(f)
        except (OSError, ValueError):
            logger.debug("Terminology file %s cannot be read", path, exc_info=True)
            continue
        if content.get("SegmentationCategoryTypeContextName") != terminologyName:
            continue
        result = []
        for category in content.get("SegmentationCodes", {}).get("Category", []):
            name = category.get("CodeMeaning", "")
            if search and search not in name.lower():
                continue
            types = [t.get("CodeMeaning", "") for t in category.get("Type", [])]
            result.append({"name": name, "typeCount": len(types), "types": types[:40]})
        return result
    return []


# ----------------------------------------------------------------------------------- Scene views
@method()
def sceneViews():
    """Scene views of the scene (Scene Views module)."""
    result = []
    for i in range(slicer.mrmlScene.GetNumberOfNodesByClass("vtkMRMLSceneViewNode")):
        node = slicer.mrmlScene.GetNthNodeByClass(i, "vtkMRMLSceneViewNode")
        result.append({"id": node.GetID(), "name": node.GetName(),
                       "description": node.GetSceneViewDescription() or "",
                       "screenshotType": node.GetScreenShotType(),
                       "thumbnail": _screenshot_data_url(node)})
    return result


def _screenshot_data_url(node):
    """The picture a scene view was stored with, as a data URL the page can show."""
    image = node.GetScreenShot()
    if image is None or image.GetNumberOfPoints() == 0:
        return None
    import base64
    import tempfile

    path = os.path.join(tempfile.gettempdir(), "sceneview-thumbnail.png")
    writer = vtk.vtkPNGWriter()
    writer.SetFileName(path)
    writer.SetInputData(image)
    writer.Write()
    with open(path, "rb") as handle:
        return "data:image/png;base64," + base64.b64encode(handle.read()).decode("ascii")


@method()
def createSceneView(name=None, description="", screenshot=None):
    """Store the scene as it is now, as the "Create scene view" button does.

    :param screenshot: a PNG of the views at that moment, base64 encoded, kept with the scene view
        and shown as its thumbnail. The page takes it: only the page can read a canvas.
    """
    node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSceneViewNode", name or "Scene view")
    node.SetSceneViewDescription(description or "")
    if screenshot:
        image = _image_from_png(screenshot)
        if image is not None:
            node.SetScreenShot(image)
            node.SetScreenShotType(0)   # what the layout looked like
    node.StoreScene()
    return node.GetID()


def _image_from_png(encoded):
    """A vtkImageData from base64-encoded PNG bytes (what the page captured)."""
    import base64
    import tempfile

    data = encoded.split(",", 1)[-1]
    path = os.path.join(tempfile.gettempdir(), "sceneview-input.png")
    try:
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(data))
        reader = vtk.vtkPNGReader()
        reader.SetFileName(path)
        reader.Update()
        image = vtk.vtkImageData()
        image.DeepCopy(reader.GetOutput())
        return image
    except Exception:
        logger.warning("The screenshot of the scene view could not be read", exc_info=True)
        return None


@method()
def restoreSceneView(nodeID):
    """Put the scene back as a scene view holds it."""
    _node(nodeID).RestoreScene()
    return True


# ---------------------------------------------------------------------------------------- Tables
@method()
def tableNodeInfo(nodeID):
    """Shape of a table and how it may be edited (Tables module)."""
    node = _node(nodeID)
    table = node.GetTable()
    return {
        "name": node.GetName(),
        "locked": bool(node.GetLocked()),
        "useColumnTitleAsColumnHeader": bool(node.GetUseColumnTitleAsColumnHeader()),
        "columns": [table.GetColumn(c).GetName() or f"Column {c + 1}" for c in range(table.GetNumberOfColumns())]
        if table is not None else [],
        "rowCount": table.GetNumberOfRows() if table is not None else 0,
    }


@method()
def editTable(nodeID, action, index=-1):
    """Add or remove a row or a column (the buttons of the Tables module)."""
    node = _node(nodeID)
    if node.GetLocked():
        return False
    if action == "addRow":
        node.AddEmptyRow()
    elif action == "removeRow":
        node.RemoveRow(int(index) if index >= 0 else node.GetTable().GetNumberOfRows() - 1)
    elif action == "addColumn":
        node.AddColumn()
    elif action == "removeColumn":
        node.RemoveColumn(int(index) if index >= 0 else node.GetTable().GetNumberOfColumns() - 1)
    else:
        return False
    return True


@method()
def setTableLocked(nodeID, locked):
    _node(nodeID).SetLocked(bool(locked))
    return True


# ----------------------------------------------------------------------------------------- Plots
@method()
def plotChartInfo(nodeID):
    """A chart and its series (Plots module)."""
    node = _node(nodeID)
    series = []
    for index in range(node.GetNumberOfPlotSeriesNodes()):
        seriesNode = node.GetNthPlotSeriesNode(index)
        if seriesNode is None:
            continue
        tableNode = seriesNode.GetTableNode()
        series.append({
            "id": seriesNode.GetID(),
            "name": seriesNode.GetName(),
            "tableNodeID": tableNode.GetID() if tableNode is not None else None,
            "xColumn": seriesNode.GetXColumnName() or "",
            "yColumn": seriesNode.GetYColumnName() or "",
            "type": seriesNode.GetPlotType(),
            "color": _color_hex(seriesNode.GetColor()),
        })
    return {
        "name": node.GetName(),
        "title": node.GetTitle() or "",
        "xAxisTitle": node.GetXAxisTitle() or "",
        "yAxisTitle": node.GetYAxisTitle() or "",
        "grid": bool(node.GetGridVisibility()),
        "legend": bool(node.GetLegendVisibility()),
        "series": series,
    }


@method()
def setPlotChartProperties(nodeID, properties):
    node = _node(nodeID)
    setters = {"title": node.SetTitle, "xAxisTitle": node.SetXAxisTitle, "yAxisTitle": node.SetYAxisTitle,
               "grid": node.SetGridVisibility, "legend": node.SetLegendVisibility}
    for name, value in (properties or {}).items():
        if name in setters:
            setters[name](value)
    return True


@method()
def setPlotSeriesProperties(nodeID, properties):
    node = _node(nodeID)
    for name, value in (properties or {}).items():
        if name == "xColumn":
            node.SetXColumnName(value)
        elif name == "yColumn":
            node.SetYColumnName(value)
        elif name == "type":
            node.SetPlotType(int(value))
        elif name == "color":
            value = value.lstrip("#")
            node.SetColor(*[int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])
        elif name == "tableNodeID":
            node.SetAndObserveTableNodeID(value)
        elif name == "name":
            node.SetName(value)
    return True


@method()
def addPlotSeries(chartNodeID, tableNodeID=None, name=None):
    """Add a series to a chart, over a table (the "Add series" button of the Plots module)."""
    chartNode = _node(chartNodeID)
    seriesNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLPlotSeriesNode", name or "Series")
    if tableNodeID:
        tableNode = _node(tableNodeID)
        seriesNode.SetAndObserveTableNodeID(tableNodeID)
        table = tableNode.GetTable()
        if table is not None and table.GetNumberOfColumns() >= 2:
            seriesNode.SetXColumnName(table.GetColumn(0).GetName())
            seriesNode.SetYColumnName(table.GetColumn(1).GetName())
    chartNode.AddAndObservePlotSeriesNodeID(seriesNode.GetID())
    return seriesNode.GetID()


@method()
def removePlotSeries(chartNodeID, seriesNodeID):
    _node(chartNodeID).RemovePlotSeriesNodeID(seriesNodeID)
    return True


# -------------------------------------------------------------------------------------- Sequences
@method()
def sequenceBrowserInfo(nodeID):
    """A sequence browser: where it is, how long, and what it plays (Sequences module)."""
    node = _node(nodeID)
    masterSequence = node.GetMasterSequenceNode()
    sequences = vtk.vtkCollection()
    node.GetSynchronizedSequenceNodes(sequences, True)
    synchronized = []
    for i in range(sequences.GetNumberOfItems()):
        sequenceNode = sequences.GetItemAsObject(i)
        proxyNode = node.GetProxyNode(sequenceNode)
        synchronized.append({
            "id": sequenceNode.GetID(),
            "name": sequenceNode.GetName(),
            "items": sequenceNode.GetNumberOfDataNodes(),
            "proxyNodeID": proxyNode.GetID() if proxyNode is not None else None,
            "proxyName": proxyNode.GetName() if proxyNode is not None else None,
            # Whether this sequence follows the browser, and whether what its proxy node does is
            # written back into it (the playback and recording columns of the desktop module).
            "playback": bool(node.GetPlayback(sequenceNode)),
            "recording": bool(node.GetRecording(sequenceNode)),
        })
    itemCount = masterSequence.GetNumberOfDataNodes() if masterSequence is not None else 0
    index = node.GetSelectedItemNumber()
    return {
        "name": node.GetName(),
        "masterSequenceID": masterSequence.GetID() if masterSequence is not None else None,
        "itemCount": itemCount,
        "selectedItem": index,
        "indexName": masterSequence.GetIndexName() if masterSequence is not None else "",
        "indexValue": masterSequence.GetNthIndexValue(index) if masterSequence is not None and 0 <= index < itemCount else "",
        "playing": bool(node.GetPlaybackActive()),
        "playbackRate": node.GetPlaybackRateFps(),
        "loop": bool(node.GetPlaybackLooped()),
        # Recording writes what the proxy nodes are doing back into the sequences, which is what
        # the record button and the snapshot button of the Sequences module do.
        "recording": bool(node.GetRecordingActive()),
        "recordMasterOnly": bool(node.GetRecordMasterOnly()),
        # As in desktop Slicer, recording is offered only where a sequence is set to record into
        "canRecord": bool(node.IsAnySequenceNodeRecording()),
        "sequences": synchronized,
    }


# Playback is driven here, as the Sequences module of desktop Slicer drives it with a timer: the
# browser node only says that it is playing and how fast.
_playback = {}   # browser node id -> (timer handle, callback), which keeps the callback alive


def _stop_playback(nodeID):
    from .qtcompat import dom

    entry = _playback.pop(nodeID, None)
    if entry is not None:
        dom.clear_interval(entry[0])


def _start_playback(node):
    from .qtcompat import dom

    nodeID = node.GetID()
    _stop_playback(nodeID)
    rate = max(0.5, node.GetPlaybackRateFps())

    def step():
        browser = slicer.mrmlScene.GetNodeByID(nodeID)
        if browser is None or not browser.GetPlaybackActive():
            _stop_playback(nodeID)
            return
        if not browser.GetPlaybackLooped() and browser.GetSelectedItemNumber() >= browser.GetNumberOfItems() - 1:
            browser.SetPlaybackActive(False)
            _stop_playback(nodeID)
            return
        browser.SelectNextItem(1)

    # the callback is kept with the handle: dropped, it is collected and the playback stops
    _playback[nodeID] = dom.set_interval(step, int(1000.0 / rate))


@method()
def setSequenceBrowser(nodeID, properties):
    """Move through a sequence, or change how it plays."""
    node = _node(nodeID)
    for name, value in (properties or {}).items():
        if name == "selectedItem":
            node.SetSelectedItemNumber(int(value))
        elif name == "playing":
            node.SetPlaybackActive(bool(value))
            if value:
                _start_playback(node)
            else:
                _stop_playback(node.GetID())
        elif name == "playbackRate":
            node.SetPlaybackRateFps(float(value))
            if node.GetPlaybackActive():
                _start_playback(node)
        elif name == "loop":
            node.SetPlaybackLooped(bool(value))
        elif name == "step":
            node.SelectNextItem(int(value))
        elif name == "selectFirst":
            node.SetSelectedItemNumber(0)
        elif name == "selectLast":
            node.SetSelectedItemNumber(max(0, node.GetNumberOfItems() - 1))
        elif name == "recording":
            node.SetRecordingActive(bool(value))
        elif name == "recordMasterOnly":
            node.SetRecordMasterOnly(bool(value))
        elif name == "sequenceRecording":
            sequenceNode = _node(value["id"])
            node.SetRecording(sequenceNode, bool(value["enabled"]))
        elif name == "sequencePlayback":
            sequenceNode = _node(value["id"])
            node.SetPlayback(sequenceNode, bool(value["enabled"]))
        elif name == "snapshot":
            # One item added from where the proxy nodes stand now, as the snapshot button does
            node.SaveProxyNodesState()
    return True


# ------------------------------------------------------------------------------------ CropVolume
@method()
def cropVolumeInfo(parameterNodeID=None):
    """Inputs and settings of Crop Volume, and what the result would be."""
    node = _node(parameterNodeID) if parameterNodeID else None
    if node is None:
        node = slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLCropVolumeParametersNode")
    if node is None:
        node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLCropVolumeParametersNode", "CropVolume")
        # Cropping without resampling is done here; resampling is a CLI module, which is a separate
        # program and cannot be run in the page (see interpolatedCropAvailable below).
        node.SetVoxelBased(True)
    inputVolume = node.GetInputVolumeNode()
    roi = node.GetROINode()
    logic = slicer.app.applicationLogic().GetModuleLogic("CropVolume")
    outputExtent = [0, 0, 0]
    spacing = [0.0, 0.0, 0.0]
    if logic is not None and inputVolume is not None and roi is not None:
        extent = [0] * 6
        try:
            logic.GetVoxelBasedCropOutputExtent(roi, inputVolume, extent, True)
            outputExtent = [extent[1] - extent[0] + 1, extent[3] - extent[2] + 1, extent[5] - extent[4] + 1]
        except Exception:
            logger.debug("Crop output extent could not be computed", exc_info=True)
        spacing = [round(s / max(node.GetSpacingScalingConst(), 1e-6), 3) for s in inputVolume.GetSpacing()]
    return {
        "parameterNodeID": node.GetID(),
        "interpolatedCropAvailable": False,
        "inputVolumeID": inputVolume.GetID() if inputVolume is not None else None,
        "outputVolumeID": node.GetOutputVolumeNode().GetID() if node.GetOutputVolumeNode() is not None else None,
        "roiID": roi.GetID() if roi is not None else None,
        "interpolationMode": node.GetInterpolationMode(),
        "voxelBased": bool(node.GetVoxelBased()),
        "isotropicResampling": bool(node.GetIsotropicResampling()),
        "spacingScale": node.GetSpacingScalingConst(),
        "fillValue": node.GetFillValue(),
        "outputDimensions": outputExtent,
        "outputSpacing": spacing,
    }


@method()
def setCropVolumeParameters(parameterNodeID, properties):
    node = _node(parameterNodeID)
    setters = {
        "inputVolumeID": node.SetInputVolumeNodeID,
        "outputVolumeID": node.SetOutputVolumeNodeID,
        "roiID": node.SetROINodeID,
        "interpolationMode": lambda v: node.SetInterpolationMode(int(v)),
        "voxelBased": lambda v: node.SetVoxelBased(bool(v)),
        "isotropicResampling": lambda v: node.SetIsotropicResampling(bool(v)),
        "spacingScale": lambda v: node.SetSpacingScalingConst(float(v)),
        "fillValue": lambda v: node.SetFillValue(float(v)),
    }
    for name, value in (properties or {}).items():
        if name in setters:
            setters[name](value)
    return True


@method()
def applyCropVolume(parameterNodeID):
    """Crop the volume, as the Apply button does; the output node is made if there is none."""
    node = _node(parameterNodeID)
    logic = slicer.app.applicationLogic().GetModuleLogic("CropVolume")
    if logic is None:
        raise RuntimeError("The Crop Volume module is not available")
    if node.GetInputVolumeNode() is None or node.GetROINode() is None:
        raise ValueError("Choose an input volume and a region of interest")
    if not node.GetVoxelBased():
        raise RuntimeError("Cropping with resampling uses the Resample Scalar/Vector/DWI Volume "
                           "module, which is a separate program and cannot be run in a web browser. "
                           "Use voxel based cropping instead.")
    if node.GetOutputVolumeNode() is None:
        output = slicer.mrmlScene.AddNewNodeByClass(node.GetInputVolumeNode().GetClassName(),
                                                    node.GetInputVolumeNode().GetName() + " cropped")
        node.SetOutputVolumeNodeID(output.GetID())
    logic.Apply(node)
    outputNode = node.GetOutputVolumeNode()
    return {"outputVolumeID": outputNode.GetID() if outputNode is not None else None,
            "dimensions": list(outputNode.GetImageData().GetDimensions()) if outputNode is not None and outputNode.GetImageData() else None}

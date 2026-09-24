"""Bridge methods of the Segmentations module GUI beyond the segment list and representations.

What qSlicerSegmentationsModuleWidget offers on the desktop: the display settings of the
segmentation and of one segment (qMRMLSegmentationDisplayNodeWidget), copying and moving segments
between segmentations, exporting segments to a labelmap or to models and importing them back,
exporting them to files, and the binary labelmap layers.
"""

import os
import shutil

import slicer
import vtk

from .bridge import _node, method

_SH_PREFIX = "sh:"


def _logic():
    return slicer.vtkSlicerSegmentationsModuleLogic


def _sh():
    return slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(slicer.mrmlScene)


def _segmentation(nodeID):
    node = _node(nodeID)
    if not node.IsA("vtkMRMLSegmentationNode"):
        raise ValueError(f"{nodeID} is not a segmentation")
    return node


def _viewNodes():
    """The slice and 3D views a segmentation can be shown in, in layout order."""
    views = []
    for className in ("vtkMRMLSliceNode", "vtkMRMLViewNode"):
        for view in slicer.util.getNodesByClass(className):
            views.append(view)
    return views


def _folderItem(itemID):
    sh = _sh()
    return itemID if sh is not None and itemID and sh.GetItemDataNode(itemID) is None and itemID != sh.GetSceneItemID() else 0


# ------------------------------------------------------------------------------ display
@method()
def segmentationModuleInfo(nodeID):
    """What the module shows besides the segments: the source geometry, the display settings of
    the whole segmentation, the views it is shown in, and the binary labelmap layers."""
    node = _segmentation(nodeID)
    segmentation = node.GetSegmentation()
    display = node.GetDisplayNode()
    reference = node.GetNodeReference(node.GetReferenceImageGeometryReferenceRole())
    contained = []
    segmentation.GetContainedRepresentationNames(contained)
    info = {
        "sourceGeometry": reference.GetName() if reference is not None else "",
        "layers": {
            "segmentCount": segmentation.GetNumberOfSegments(),
            "layerCount": segmentation.GetNumberOfLayers("Binary labelmap"),
        },
        "representations": list(contained),
        "display": None,
    }
    if display is None:
        return info
    viewIDs = [display.GetNthViewNodeID(i) for i in range(display.GetNumberOfViewNodeIDs())]
    info["display"] = {
        "visible": bool(display.GetVisibility()),
        "opacity": float(display.GetOpacity()),
        "opacity2DFill": float(display.GetOpacity2DFill()),
        "opacity2DOutline": float(display.GetOpacity2DOutline()),
        "opacity3D": float(display.GetOpacity3D()),
        "visibility2DFill": bool(display.GetVisibility2DFill()),
        "visibility2DOutline": bool(display.GetVisibility2DOutline()),
        "visibility3D": bool(display.GetVisibility3D()),
        "sliceIntersectionThickness": int(display.GetSliceIntersectionThickness()),
        "representation2D": display.GetPreferredDisplayRepresentationName2D() or "",
        "representation3D": display.GetPreferredDisplayRepresentationName3D() or "",
        # No view named means every view, as vtkMRMLDisplayNode takes it
        "allViews": not viewIDs,
        "views": [{"id": view.GetID(), "name": view.GetLayoutLabel() or view.GetLayoutName(),
                   "kind": "slice" if view.IsA("vtkMRMLSliceNode") else "threeD",
                   "checked": not viewIDs or view.GetID() in viewIDs} for view in _viewNodes()],
    }
    return info


@method()
def segmentDisplayInfo(nodeID, segmentID):
    """The display settings of one segment, as the "Selected segment" box of the desktop shows them."""
    node = _segmentation(nodeID)
    display = node.GetDisplayNode()
    if display is None or node.GetSegmentation().GetSegment(segmentID) is None:
        return None
    return {
        "visible": bool(display.GetSegmentVisibility(segmentID)),
        "visibility2DFill": bool(display.GetSegmentVisibility2DFill(segmentID)),
        "visibility2DOutline": bool(display.GetSegmentVisibility2DOutline(segmentID)),
        "visibility3D": bool(display.GetSegmentVisibility3D(segmentID)),
        "opacity2DFill": float(display.GetSegmentOpacity2DFill(segmentID)),
        "opacity2DOutline": float(display.GetSegmentOpacity2DOutline(segmentID)),
        "opacity3D": float(display.GetSegmentOpacity3D(segmentID)),
    }


@method()
def setSegmentationDisplayProperties(nodeID, properties):
    """The display settings of the whole segmentation (the desktop's display node widget)."""
    node = _segmentation(nodeID)
    if node.GetDisplayNode() is None:
        node.CreateDefaultDisplayNodes()
    display = node.GetDisplayNode()
    wasModified = display.StartModify()
    try:
        setters = {
            "visible": ("SetVisibility", bool), "opacity": ("SetOpacity", float),
            "opacity2DFill": ("SetOpacity2DFill", float), "opacity2DOutline": ("SetOpacity2DOutline", float),
            "opacity3D": ("SetOpacity3D", float), "visibility2DFill": ("SetVisibility2DFill", bool),
            "visibility2DOutline": ("SetVisibility2DOutline", bool), "visibility3D": ("SetVisibility3D", bool),
            "sliceIntersectionThickness": ("SetSliceIntersectionThickness", int),
            "representation2D": ("SetPreferredDisplayRepresentationName2D", str),
            "representation3D": ("SetPreferredDisplayRepresentationName3D", str),
        }
        for key, (setter, kind) in setters.items():
            if key in properties:
                getattr(display, setter)(kind(properties[key]))
        if "views" in properties:
            # None (or every view) means all views, as the display node takes an empty list
            display.RemoveAllViewNodeIDs()
            wanted = properties["views"]
            if wanted is not None and len(wanted) < len(_viewNodes()):
                for viewID in wanted:
                    display.AddViewNodeID(viewID)
    finally:
        display.EndModify(wasModified)
    return True


@method()
def setSegmentDisplayProperties(nodeID, segmentID, properties):
    """The display settings of one segment."""
    node = _segmentation(nodeID)
    display = node.GetDisplayNode()
    if display is None:
        return False
    setters = {
        "visible": ("SetSegmentVisibility", bool), "visibility2DFill": ("SetSegmentVisibility2DFill", bool),
        "visibility2DOutline": ("SetSegmentVisibility2DOutline", bool), "visibility3D": ("SetSegmentVisibility3D", bool),
        "opacity2DFill": ("SetSegmentOpacity2DFill", float), "opacity2DOutline": ("SetSegmentOpacity2DOutline", float),
        "opacity3D": ("SetSegmentOpacity3D", float),
    }
    for key, (setter, kind) in setters.items():
        if key in properties:
            getattr(display, setter)(segmentID, kind(properties[key]))
    return True


# ------------------------------------------------------------------------------ copy and move
@method()
def copySegments(fromNodeID, toNodeID, segmentIDs, remove=False, convert=False):
    """Copy (or move) segments from one segmentation to another, as the desktop's copy/move box.

    A segmentation whose source representation the segments cannot be converted to cannot take
    them: that is reported (the page asks whether to change its source representation, which is
    what *convert* then does, as the desktop asks).
    """
    fromNode = _segmentation(fromNodeID)
    toNode = _segmentation(toNodeID)
    if fromNode is toNode:
        raise ValueError("Choose two different segmentations")
    fromSegmentation = fromNode.GetSegmentation()
    toSegmentation = toNode.GetSegmentation()
    toNode.CreateDefaultDisplayNodes()
    if toSegmentation.GetNumberOfSegments() == 0:
        toSegmentation.SetSourceRepresentationName(fromSegmentation.GetSourceRepresentationName())
    for segmentID in segmentIDs:
        segment = fromSegmentation.GetSegment(segmentID)
        if segment is None:
            raise ValueError(f"No segment {segmentID} in {fromNode.GetName()}")
        if not toSegmentation.CanAcceptSegment(segment):
            if not convert:
                raise RuntimeError(
                    f"Cannot convert source representation '{fromSegmentation.GetSourceRepresentationName()}' into target "
                    f"source '{toSegmentation.GetSourceRepresentationName()}', thus unable to copy segment "
                    f"'{segment.GetName()}' from segmentation '{fromNode.GetName()}' to '{toNode.GetName()}'.\n\n"
                    f"Would you like to change the source representation of '{toNode.GetName()}' to "
                    f"'{fromSegmentation.GetSourceRepresentationName()}'?\n\nNote: This may result in unwanted data loss in {toNode.GetName()}.")
            if not toSegmentation.CreateRepresentation(fromSegmentation.GetSourceRepresentationName()):
                raise RuntimeError(f"Failed to convert {toNode.GetName()} to {fromSegmentation.GetSourceRepresentationName()}")
            toSegmentation.SetSourceRepresentationName(fromSegmentation.GetSourceRepresentationName())
        if not toSegmentation.CopySegmentFromSegmentation(fromSegmentation, segmentID, bool(remove)):
            raise RuntimeError(f"Failed to copy segment '{segment.GetName()}'")
    fromNode.Modified()
    toNode.Modified()
    return True


# ------------------------------------------------------------------------------ import and export
def _nodeAndFolder(target):
    """A target of an export or import: a node ("vtkMRML...") or a subject hierarchy folder ("sh:<id>")."""
    if not target:
        return None, 0
    if str(target).startswith(_SH_PREFIX):
        return None, _folderItem(int(str(target)[len(_SH_PREFIX):]))
    return _node(target), 0


@method()
def segmentationExportTargets():
    """What segments can be exported into: the labelmaps and the folders there are (or a new one)."""
    sh = _sh()
    targets = [{"id": n.GetID(), "name": n.GetName(), "kind": "labelmap"} for n in slicer.util.getNodesByClass("vtkMRMLLabelMapVolumeNode")
               if not n.GetHideFromEditors()]
    if sh is not None:
        children = vtk.vtkIdList()
        sh.GetItemChildren(sh.GetSceneItemID(), children, True)
        for i in range(children.GetNumberOfIds()):
            itemID = children.GetId(i)
            if sh.GetItemDataNode(itemID) is None and sh.GetItemLevel(itemID) in ("Folder", ""):
                targets.append({"id": f"{_SH_PREFIX}{itemID}", "name": sh.GetItemName(itemID), "kind": "folder"})
    return targets


@method()
def segmentationImportSources():
    """What can be imported: labelmaps, models, and folders of models."""
    sources = [{"id": n.GetID(), "name": n.GetName(), "kind": "labelmap"} for n in slicer.util.getNodesByClass("vtkMRMLLabelMapVolumeNode")
               if not n.GetHideFromEditors()]
    sources += [{"id": n.GetID(), "name": n.GetName(), "kind": "model"} for n in slicer.util.getNodesByClass("vtkMRMLModelNode")
                if not n.GetHideFromEditors()]
    sources += [t for t in segmentationExportTargets() if t["kind"] == "folder"]
    return sources


def _segmentIDs(node, which):
    ids = vtk.vtkStringArray()
    if which == "visible" and node.GetDisplayNode() is not None:
        node.GetDisplayNode().GetVisibleSegmentIDs(ids)
    else:
        node.GetSegmentation().GetSegmentIDs(ids)
    return ids


@method()
def exportSegmentation(nodeID, options):
    """Export segments to a labelmap or to models (the desktop's Export/import box, Export).

    options: {type: "labelmap"|"models", target: node ID | "sh:<folder item>" | None (a new one),
    segments: "all"|"visible", referenceVolumeID, colorTableID}. Returns what was exported into.
    """
    node = _segmentation(nodeID)
    sh = _sh()
    kind = options.get("type", "labelmap")
    targetNode, folderItem = _nodeAndFolder(options.get("target"))
    segmentIDs = _segmentIDs(node, options.get("segments", "all"))
    reference = _node(options["referenceVolumeID"]) if options.get("referenceVolumeID") else None
    colorTable = _node(options["colorTableID"]) if options.get("colorTableID") else None
    if kind == "labelmap":
        labelmap = targetNode if targetNode is not None and targetNode.IsA("vtkMRMLLabelMapVolumeNode") else None
        if labelmap is None:
            labelmap = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLabelMapVolumeNode",
                                                          slicer.mrmlScene.GetUniqueNameByString(node.GetName() + "-label"))
            labelmap.CreateDefaultDisplayNodes()
            if folderItem and sh is not None:
                sh.SetItemParent(sh.GetItemByDataNode(labelmap), folderItem)
        if not _logic().ExportSegmentsToLabelmapNode(node, segmentIDs, labelmap, reference,
                                                     slicer.vtkSegmentation.EXTENT_UNION_OF_EFFECTIVE_SEGMENTS_AND_REFERENCE_GEOMETRY,
                                                     colorTable):
            raise RuntimeError(f"Failed to export segments from segmentation {node.GetName()} to labelmap node {labelmap.GetName()}. "
                               "Most probably the segment cannot be converted into binary labelmap representation.")
        return {"id": labelmap.GetID(), "name": labelmap.GetName(), "kind": "labelmap"}
    if sh is None:
        raise RuntimeError("No subject hierarchy")
    if not folderItem:
        folderItem = sh.CreateFolderItem(sh.GetSceneItemID(), sh.GenerateUniqueItemName(node.GetName() + "-models"))
    if not _logic().ExportSegmentsToModels(node, segmentIDs, folderItem):
        raise RuntimeError(f"Failed to export segments from segmentation {node.GetName()} to models in folder {sh.GetItemName(folderItem)}")
    return {"id": f"{_SH_PREFIX}{folderItem}", "name": sh.GetItemName(folderItem), "kind": "folder"}


@method()
def importToSegmentation(nodeID, source, terminologyContext=""):
    """Import a labelmap, a model or a folder of models into the segmentation (the desktop's Import)."""
    node = _segmentation(nodeID)
    sourceNode, folderItem = _nodeAndFolder(source)
    if sourceNode is not None and sourceNode.IsA("vtkMRMLLabelMapVolumeNode"):
        logic = slicer.app.applicationLogic().GetModuleLogic("Segmentations")
        ok = logic.ImportLabelmapToSegmentationNodeWithTerminology(sourceNode, node, terminologyContext or "") if logic is not None \
            else _logic().ImportLabelmapToSegmentationNode(sourceNode, node)
        if not ok:
            raise RuntimeError(f"Failed to copy labels from labelmap volume node {sourceNode.GetName()}")
    elif sourceNode is not None and sourceNode.IsA("vtkMRMLModelNode"):
        if not _logic().ImportModelToSegmentationNode(sourceNode, node):
            raise RuntimeError(f"Failed to copy polydata from model node {sourceNode.GetName()}")
    elif folderItem:
        if not _logic().ImportModelsToSegmentationNode(folderItem, node):
            raise RuntimeError(f"Failed to copy polydata from models under folder {_sh().GetItemName(folderItem)}")
    else:
        raise ValueError("Choose a labelmap, a model or a folder of models to import")
    node.Modified()
    return True


@method()
def exportSegmentationToFiles(nodeID, options):
    """Write the segments to files - STL, OBJ, NRRD or NIfTI - as the desktop's "Export to files"
    does, into a folder of the virtual file system; returns the file to offer: the one file, or a
    zip of them all.

    options: {format, visibleOnly, merge, sizeScale, lps, compression, referenceVolumeID, colorTableID}
    """
    node = _segmentation(nodeID)
    fileFormat = str(options.get("format", "STL")).upper()
    segmentIDs = _segmentIDs(node, "visible" if options.get("visibleOnly") else "all")
    base = os.path.join(slicer.app.temporaryPath, "SegmentationExport")
    folder = os.path.join(base, node.GetName().replace("/", "_"))
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder, exist_ok=True)
    if fileFormat in ("STL", "OBJ"):
        ok = _logic().ExportSegmentsClosedSurfaceRepresentationToFiles(
            folder, node, segmentIDs, fileFormat, bool(options.get("lps", True)), float(options.get("sizeScale", 1.0)),
            bool(options.get("merge", False)) or fileFormat == "OBJ")
    else:
        extension = "nii.gz" if fileFormat == "NIFTI" and options.get("compression") else ("nii" if fileFormat == "NIFTI" else "nrrd")
        reference = _node(options["referenceVolumeID"]) if options.get("referenceVolumeID") else None
        colorTable = _node(options["colorTableID"]) if options.get("colorTableID") else None
        ok = _logic().ExportSegmentsBinaryLabelmapRepresentationToFiles(
            folder, node, segmentIDs, extension, bool(options.get("compression", False)), reference,
            slicer.vtkSegmentation.EXTENT_REFERENCE_GEOMETRY, colorTable)
    if not ok:
        raise RuntimeError(f"Failed to export segments of {node.GetName()} to {fileFormat} files")
    files = sorted(os.listdir(folder))
    if not files:
        raise RuntimeError("Nothing was exported")
    if len(files) == 1:
        return {"path": os.path.join(folder, files[0]), "files": files}
    archive = shutil.make_archive(folder, "zip", folder)
    return {"path": archive, "files": files}


# ------------------------------------------------------------------------------ layers
@method()
def collapseSegmentationLayers(nodeID, force=False):
    """Move segments to shared binary labelmap layers, to a single one if forced (overlaps then go
    to the segment nearest the end of the list)."""
    node = _segmentation(nodeID)
    _logic().CollapseBinaryLabelmaps(node, bool(force))
    node.Modified()
    return True

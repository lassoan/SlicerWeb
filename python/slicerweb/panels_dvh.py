"""Bridge methods of the web GUI of the Dose Volume Histogram module (SlicerRT extension).

The desktop GUI (qSlicerDoseVolumeHistogramModuleWidget) is a Qt C++ widget; the web GUI
(web/src/app/modules/DoseVolumeHistogramPanel.vue) uses the same parameter node
(vtkMRMLDoseVolumeHistogramNode) and module logic (vtkSlicerDoseVolumeHistogramModuleLogic): the
DVH of each chosen segment goes into a table of its own, drawn in the plot view, and the metrics
(volume, mean, minimum and maximum dose, and the V and D metrics asked for) into the metrics table.
"""

import os

import slicer

from .bridge import method

# What the DICOM-RT importer puts on a dose volume (vtkSlicerRtCommon), by which one is told
DOSE_VOLUME_ATTRIBUTE = "DicomRtImport.DoseVolume"
DOSE_UNIT_ATTRIBUTE = "DicomRtImport.DoseUnitName"

_PROPERTIES = {
    "vDoseValues": ("GetVDoseValues", "SetVDoseValues", str),
    "showVMetricsCc": ("GetShowVMetricsCc", "SetShowVMetricsCc", bool),
    "showVMetricsPercent": ("GetShowVMetricsPercent", "SetShowVMetricsPercent", bool),
    "dVolumeValuesCc": ("GetDVolumeValuesCc", "SetDVolumeValuesCc", str),
    "dVolumeValuesPercent": ("GetDVolumeValuesPercent", "SetDVolumeValuesPercent", str),
    "showDMetrics": ("GetShowDMetrics", "SetShowDMetrics", bool),
    "showDoseVolumesOnly": ("GetShowDoseVolumesOnly", "SetShowDoseVolumesOnly", bool),
    "automaticOversampling": ("GetAutomaticOversampling", "SetAutomaticOversampling", bool),
    "doseSurfaceHistogram": ("GetDoseSurfaceHistogram", "SetDoseSurfaceHistogram", bool),
    "useInsideDoseSurface": ("GetUseInsideDoseSurface", "SetUseInsideDoseSurface", bool),
    "useFractionalLabelmap": ("GetUseFractionalLabelmap", "SetUseFractionalLabelmap", bool),
}
_V_METRIC_PROPERTIES = ("vDoseValues", "showVMetricsCc", "showVMetricsPercent")
_D_METRIC_PROPERTIES = ("dVolumeValuesCc", "dVolumeValuesPercent", "showDMetrics")


def _node(nodeID):
    node = slicer.mrmlScene.GetNodeByID(nodeID)
    if node is None or not node.IsA("vtkMRMLDoseVolumeHistogramNode"):
        raise ValueError(f"{nodeID} is not a Dose Volume Histogram parameter node")
    return node


def _logic():
    logic = slicer.app.applicationLogic().GetModuleLogic("DoseVolumeHistogram")
    if logic is None:
        raise RuntimeError("The Dose Volume Histogram module (SlicerRT extension) is not loaded")
    return logic


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(round(max(0.0, min(1.0, c)) * 255)) for c in rgb)


def _metrics(node):
    """The metrics table: its "Show" column as a flag of each row, the other columns as text."""
    tableNode = node.GetMetricsTableNode()
    table = tableNode.GetTable() if tableNode is not None else None
    if table is None or table.GetNumberOfColumns() == 0:
        return {"columns": [], "rows": []}
    visibleColumn = node.MetricColumnVisible
    columns = [table.GetColumn(c).GetName() or "" for c in range(table.GetNumberOfColumns()) if c != visibleColumn]
    rows = []
    for r in range(table.GetNumberOfRows()):
        rows.append({
            "visible": bool(table.GetValue(r, visibleColumn).ToInt()),
            "cells": [table.GetValue(r, c).ToString() for c in range(table.GetNumberOfColumns()) if c != visibleColumn],
        })
    return {"columns": columns, "rows": rows}


@method()
def doseVolumeHistogramInfo(nodeID):
    node = _node(nodeID)
    info = {name: prop[2](getattr(node, prop[0])() or ("" if prop[2] is str else 0)) for name, prop in _PROPERTIES.items()}
    dose = node.GetDoseVolumeNode()
    segmentation = node.GetSegmentationNode()
    info["doseVolumeID"] = dose.GetID() if dose else None
    info["isDoseVolume"] = bool(dose is not None and dose.GetAttribute(DOSE_VOLUME_ATTRIBUTE))
    info["doseUnit"] = (dose.GetAttribute(DOSE_UNIT_ATTRIBUTE) if dose else None) or "Gy"
    info["segmentationID"] = segmentation.GetID() if segmentation else None
    # No segment chosen means every segment, as the logic takes it. (The IDs come back in the
    # list passed in: the method fills a vector given by reference.)
    selected = []
    node.GetSelectedSegmentIDs(selected)
    info["selectedSegmentIDs"] = selected
    segments = []
    if segmentation is not None:
        seg = segmentation.GetSegmentation()
        for i in range(seg.GetNumberOfSegments()):
            segmentID = seg.GetNthSegmentID(i)
            segment = seg.GetSegment(segmentID)
            segments.append({"id": segmentID, "name": segment.GetName(), "color": _hex(segment.GetColor()),
                             "selected": not selected or segmentID in selected})
    info["segments"] = segments
    info["metrics"] = _metrics(node)
    chart = node.GetChartNode()
    info["legendVisible"] = bool(chart.GetLegendVisibility()) if chart is not None else True
    return info


@method()
def setDoseVolumeHistogram(nodeID, properties):
    node = _node(nodeID)
    wasModified = node.StartModify()
    try:
        for name, value in properties.items():
            if name in _PROPERTIES:
                getattr(node, _PROPERTIES[name][1])(_PROPERTIES[name][2](value))
            elif name == "doseVolumeID":
                node.SetAndObserveDoseVolumeNode(slicer.mrmlScene.GetNodeByID(value) if value else None)
            elif name == "segmentationID":
                node.SetAndObserveSegmentationNode(slicer.mrmlScene.GetNodeByID(value) if value else None)
                node.SetSelectedSegmentIDs([])
            elif name == "selectedSegmentIDs":
                node.SetSelectedSegmentIDs([str(segmentID) for segmentID in (value or [])])
            elif name == "legendVisible":
                chart = node.GetChartNode()
                if chart is not None:
                    chart.SetLegendVisibility(bool(value))
    finally:
        node.EndModify(wasModified)
    # The metrics asked for are computed as soon as they are asked for, as the desktop widget does
    if node.GetMetricsTableNode() is not None and node.GetMetricsTableNode().GetNumberOfRows():
        if any(name in _V_METRIC_PROPERTIES for name in properties):
            _logic().ComputeVMetrics(node)
        if any(name in _D_METRIC_PROPERTIES for name in properties):
            _logic().ComputeDMetrics(node)
    return True


@method()
def computeDoseVolumeHistogram(nodeID):
    """Compute the DVH of the chosen segments, and show them.

    The desktop module leaves the new DVHs unshown until their boxes are ticked; here they are
    shown at once (what is done next, nearly always): the logic then brings a plot layout and
    draws them.
    """
    node = _node(nodeID)
    if node.GetDoseVolumeNode() is None or node.GetSegmentationNode() is None:
        raise ValueError("Select a dose volume and a segmentation")
    error = _logic().ComputeDvh(node)
    if error:
        raise RuntimeError(error)
    setDoseVolumeHistogramVisibility(nodeID, True)
    return True


@method()
def setDoseVolumeHistogramVisibility(nodeID, visible, rows=None):
    """Show or hide DVHs in the chart: the rows of the metrics table given, or all of them.

    The logic watches the table's Show column and adds the DVH to the chart or takes it out.
    """
    node = _node(nodeID)
    tableNode = node.GetMetricsTableNode()
    if tableNode is None or tableNode.GetTable() is None:
        return False
    column = tableNode.GetTable().GetColumn(node.MetricColumnVisible)
    for row in (range(tableNode.GetNumberOfRows()) if rows is None else rows):
        column.SetValue(int(row), 1 if visible else 0)
    column.Modified()
    tableNode.Modified()
    return True


@method()
def exportDoseVolumeHistogram(nodeID, what="dvh", comma=True):
    """Write the DVH values or the metrics to a CSV (TSV) file; returns the path, for the page to offer."""
    node = _node(nodeID)
    directory = slicer.app.temporaryPath
    os.makedirs(directory, exist_ok=True)
    name = (node.GetDoseVolumeNode().GetName() if node.GetDoseVolumeNode() else "DVH").replace("/", "_")
    path = os.path.join(directory, f"{name}_{'metrics' if what == 'metrics' else 'dvh'}.{'csv' if comma else 'tsv'}")
    export = _logic().ExportDvhMetricsToCsv if what == "metrics" else _logic().ExportDvhToCsv
    if not export(node, path, bool(comma)):
        raise RuntimeError(f"The {'metrics' if what == 'metrics' else 'DVH values'} could not be exported")
    return path

"""Table and plot views: what the layout shows in a table or plot view cell.

Desktop Slicer draws these with Qt widgets (qMRMLTableView) and VTK charts (qMRMLPlotView). In the
browser the page draws them - a table as a table, a chart as a drawing - so what is provided here is
the contents of the view: which node it shows (the table view node and the plot view node say so,
as in desktop Slicer) and the values to put on the screen.
"""

import logging

import slicer

from .bridge import _node, method

logger = logging.getLogger("slicerweb.views")

MAX_ROWS = 2000  # a table view shows the start of a very long table rather than choking the page


def _view_node(layoutName, className):
    """The table/plot view node of a view cell of the layout."""
    for i in range(slicer.mrmlScene.GetNumberOfNodesByClass(className)):
        node = slicer.mrmlScene.GetNthNodeByClass(i, className)
        if node.GetLayoutName() == layoutName:
            return node
    return None


def _table_contents(tableNode, maxRows=MAX_ROWS):
    table = tableNode.GetTable() if tableNode else None
    if table is None:
        return {"columns": [], "rows": [], "rowCount": 0}
    columns = [table.GetColumn(c).GetName() or f"Column {c + 1}" for c in range(table.GetNumberOfColumns())]
    rowCount = table.GetNumberOfRows()
    rows = []
    for r in range(min(rowCount, maxRows)):
        rows.append([str(table.GetValue(r, c).ToString()) for c in range(table.GetNumberOfColumns())])
    return {"columns": columns, "rows": rows, "rowCount": rowCount}


def _last_node(className):
    count = slicer.mrmlScene.GetNumberOfNodesByClass(className)
    return slicer.mrmlScene.GetNthNodeByClass(count - 1, className) if count else None


@method()
def tableViewState(layoutName):
    """Table shown in a table view of the layout, with its values.

    A view that has not been told which table to show takes the last one in the scene, so that a
    table layout shows the table that was just computed rather than an empty view (desktop Slicer
    shows the table of the Tables module there).
    """
    viewNode = _view_node(layoutName, "vtkMRMLTableViewNode")
    tableNode = viewNode.GetTableNode() if viewNode is not None else None
    if viewNode is not None and tableNode is None:
        tableNode = _last_node("vtkMRMLTableNode")
        if tableNode is not None:
            viewNode.SetTableNodeID(tableNode.GetID())
    state = {
        "viewNodeID": viewNode.GetID() if viewNode is not None else None,
        "tableNodeID": tableNode.GetID() if tableNode is not None else None,
        "name": tableNode.GetName() if tableNode is not None else None,
        "locked": bool(tableNode.GetLocked()) if tableNode is not None else True,
        "maxRows": MAX_ROWS,
    }
    state.update(_table_contents(tableNode))
    return state


@method()
def setTableViewNode(layoutName, tableNodeID):
    """Show a table in a table view of the layout (the view's own node holds the choice)."""
    viewNode = _view_node(layoutName, "vtkMRMLTableViewNode")
    if viewNode is None:
        return False
    viewNode.SetTableNodeID(tableNodeID or None)
    return True


@method()
def setTableCell(tableNodeID, row, column, value):
    """Edit a cell of a table, as the table view of desktop Slicer allows when it is not locked."""
    tableNode = _node(tableNodeID)
    if tableNode.GetLocked():
        return False
    table = tableNode.GetTable()
    if not (0 <= row < table.GetNumberOfRows() and 0 <= column < table.GetNumberOfColumns()):
        return False
    tableNode.SetCellText(row, column, str(value))
    return True


def _series_values(seriesNode):
    """Points of one plot series, from the columns of its table (vtkMRMLPlotSeriesNode)."""
    tableNode = seriesNode.GetTableNode()
    table = tableNode.GetTable() if tableNode is not None else None
    if table is None:
        return []
    yName = seriesNode.GetYColumnName()
    xName = seriesNode.GetXColumnName()
    yColumn = table.GetColumnByName(yName) if yName else None
    if yColumn is None:
        return []
    xColumn = table.GetColumnByName(xName) if xName else None
    points = []
    for r in range(yColumn.GetNumberOfTuples()):
        x = xColumn.GetTuple1(r) if xColumn is not None and r < xColumn.GetNumberOfTuples() else float(r)
        points.append([float(x), float(yColumn.GetTuple1(r))])
    return points


@method()
def plotViewState(layoutName):
    """Chart shown in a plot view of the layout: its series, their points and how to draw them."""
    viewNode = _view_node(layoutName, "vtkMRMLPlotViewNode")
    chartNode = viewNode.GetPlotChartNode() if viewNode is not None else None
    if viewNode is not None and chartNode is None:
        chartNode = _last_node("vtkMRMLPlotChartNode")
        if chartNode is not None:
            viewNode.SetPlotChartNodeID(chartNode.GetID())
    state = {
        "viewNodeID": viewNode.GetID() if viewNode is not None else None,
        "chartNodeID": chartNode.GetID() if chartNode is not None else None,
        "title": "",
        "xAxisTitle": "",
        "yAxisTitle": "",
        "grid": True,
        "legend": True,
        "series": [],
    }
    if chartNode is None:
        return state
    state["title"] = chartNode.GetTitle() or chartNode.GetName() or ""
    state["xAxisTitle"] = chartNode.GetXAxisTitle() or ""
    state["yAxisTitle"] = chartNode.GetYAxisTitle() or ""
    state["grid"] = bool(chartNode.GetGridVisibility())
    state["legend"] = bool(chartNode.GetLegendVisibility())
    for index in range(chartNode.GetNumberOfPlotSeriesNodes()):
        seriesNode = chartNode.GetNthPlotSeriesNode(index)
        if seriesNode is None:
            continue
        color = seriesNode.GetColor()
        state["series"].append({
            "nodeID": seriesNode.GetID(),
            "name": seriesNode.GetName(),
            "type": seriesNode.GetPlotType(),   # 0 line, 1 bar, 2 scatter, 3 scatter bar
            "color": "#%02x%02x%02x" % tuple(int(c * 255 + 0.5) for c in color),
            "lineWidth": seriesNode.GetLineWidth(),
            "markerSize": seriesNode.GetMarkerSize(),
            "markerStyle": seriesNode.GetMarkerStyle(),
            "points": _series_values(seriesNode),
        })
    return state


@method()
def setPlotViewChart(layoutName, chartNodeID):
    """Show a chart in a plot view of the layout."""
    viewNode = _view_node(layoutName, "vtkMRMLPlotViewNode")
    if viewNode is None:
        return False
    viewNode.SetPlotChartNodeID(chartNodeID or None)
    return True

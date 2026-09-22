"""Bridge methods for the panel of a CLI module.

There is one panel for all of them, built from the description each module ships (see
:mod:`slicerweb.cli_modules`), as Slicer builds a CLI module's GUI from the same XML.
"""

import logging
import time

import slicer

from . import cli_modules
from .bridge import _node, method

logger = logging.getLogger("slicerweb.panels")


@method()
def cliModuleDescription(name):
    """What a CLI module is called, what it does, and the parameters its panel offers."""
    description = cli_modules.description(name)
    if description is None:
        return None
    return {**description, "values": cli_modules.defaultValues(description)}


class _Named:
    """Stands for the module when it is not one the module manager knows (a test, say)."""

    def __init__(self, name):
        self.name = name


def _parameters_of(description):
    for group in description["groups"]:
        yield from group["parameters"]


@method()
def runCliModule(name, values):
    """Run a CLI module with what its panel holds, making the output nodes that are not chosen yet.

    Returns the output nodes so that the panel can show what was made and select it.
    """
    description = cli_modules.description(name)
    if description is None:
        raise ValueError(f"{name} is not a CLI module of this application")
    values = dict(values or {})
    outputs = {}
    for parameter in _parameters_of(description):
        if not parameter["nodeType"]:
            continue
        chosen = values.get(parameter["name"]) or None
        if chosen is None and parameter["channel"] == "output":
            node = slicer.mrmlScene.AddNewNodeByClass(
                parameter["nodeType"], slicer.mrmlScene.GetUniqueNameByString(description["title"]))
            chosen = node.GetID()
        values[parameter["name"]] = chosen
        if parameter["channel"] == "output" and chosen:
            outputs[parameter["name"]] = chosen

    module = getattr(slicer.modules, name.lower(), None) or _Named(name)
    # The node a CLI module reports its progress through is of no use once it has run
    cliNode = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLCommandLineModuleNode", description["title"])
    started = time.time()
    try:
        cli_modules.run(module, node=cliNode, parameters=values)
    finally:
        slicer.mrmlScene.RemoveNode(cliNode)
    seconds = round(time.time() - started, 2)
    logger.info("%s finished in %.1f s", description["title"], seconds)
    return {"outputs": outputs, "seconds": seconds}


@method()
def cliOutputSummary(nodeID):
    """One line about what a CLI module produced, for the panel to show."""
    node = _node(nodeID)
    if node is None:
        return ""
    if node.IsA("vtkMRMLVolumeNode") and node.GetImageData():
        dimensions = "x".join(str(d) for d in node.GetImageData().GetDimensions())
        spacing = ", ".join(f"{s:.2f}" for s in node.GetSpacing())
        return f"{node.GetName()}: {dimensions} voxels of {spacing} mm"
    if node.IsA("vtkMRMLModelNode") and node.GetPolyData():
        mesh = node.GetPolyData()
        return f"{node.GetName()}: {mesh.GetNumberOfPoints()} points, {mesh.GetNumberOfCells()} cells"
    return node.GetName()

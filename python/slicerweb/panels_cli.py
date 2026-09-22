"""Bridge methods for the panel of a CLI module.

There is one panel for all of them, built from the description each module ships (see
:mod:`slicerweb.cli_modules`), as Slicer builds a CLI module's GUI from the same XML.

A module runs in a worker, the way desktop Slicer runs one in a separate program: the chosen nodes
are written to files, the work happens away from the page, and the files it writes are read back
into the output nodes. The page stays live while it runs, and the panel can stop it. When no worker
can be had (in a test outside the browser), the same implementation runs in the page instead.
"""

import logging
import os
import tempfile
import time

import slicer

from . import cli_job, cli_modules, host, jobs
from .bridge import _node, method

logger = logging.getLogger("slicerweb.panels")

#: The job that is running, so that the panel can be told what became of it.
_running = None

_JOB_CODE = """
from slicerweb import cli_job

result = cli_job.runInWorker(name, values, inputs, outputs)
"""


@method()
def cliModuleDescription(name):
    """What a CLI module is called, what it does, and the parameters its panel offers."""
    description = cli_modules.description(name)
    if description is None:
        return None
    return {**description, "values": cli_modules.defaultValues(description),
            "runsInWorker": jobs.available()}


class _Named:
    """Stands for the module when it is not one the module manager knows (a test, say)."""

    def __init__(self, name):
        self.name = name


def _parameters_of(description):
    for group in description["groups"]:
        yield from group["parameters"]


def _resolve_nodes(description, values):
    """Sort the node parameters into what goes in and what comes out, making the missing outputs."""
    inputs, outputs = {}, {}
    for parameter in _parameters_of(description):
        if not parameter["nodeType"]:
            continue
        name, nodeType = parameter["name"], parameter["nodeType"]
        chosen = values.get(name) or None
        if chosen is None and parameter["channel"] == "output":
            chosen = slicer.mrmlScene.AddNewNodeByClass(
                nodeType, slicer.mrmlScene.GetUniqueNameByString(description["title"])).GetID()
        values[name] = chosen
        if not chosen:
            continue
        if parameter["channel"] == "output":
            outputs[name] = (chosen, nodeType)
        else:
            inputs[name] = (chosen, nodeType)
    return inputs, outputs


def _plain_values(description, values):
    """The parameters that are not nodes, which travel to the worker as they are written."""
    nodeParameters = {p["name"] for p in _parameters_of(description) if p["nodeType"]}
    return {name: value for name, value in values.items() if name not in nodeParameters}


@method()
def runCliModule(name, values, background=True):
    """Run a CLI module with what its panel holds, in a worker unless there is none.

    Returns at once when it runs in a worker: the panel hears how it went in a ``cli-module``
    event. The output nodes are made before it starts, so that the panel can show them.
    """
    global _running

    description = cli_modules.description(name)
    if description is None:
        raise ValueError(f"{name} is not a CLI module of this application")
    if cli_modules.implementation(name) is None:
        # Refused here rather than in the worker, so that nothing is made for a module that a run
        # would only fail on (every CLI module of Slicer is described, few are implemented)
        raise RuntimeError(f"CLI module {description['name']} is not available in the web browser")
    if _running is not None:
        raise RuntimeError(f"{_running['title']} is still running")
    values = dict(values or {})
    inputs, outputs = _resolve_nodes(description, values)
    outputIDs = {parameter: nodeID for parameter, (nodeID, _) in outputs.items()}

    if not background or not jobs.available():
        seconds = _run_here(name, description, values)
        return {"outputs": outputIDs, "seconds": seconds, "worker": False}

    workDirectory = tempfile.mkdtemp(prefix="cli-")
    files = {}
    for parameter, (nodeID, nodeType) in inputs.items():
        path = cli_job.fileNameFor(parameter, nodeType)
        here = os.path.join(workDirectory, os.path.basename(path))
        cli_job.writeNode(_node(nodeID), here)
        with open(here, "rb") as f:
            files[path] = f.read()

    wanted = {parameter: [cli_job.fileNameFor(parameter, nodeType), nodeType]
              for parameter, (_, nodeType) in outputs.items()}
    _running = {"name": name, "title": description["title"], "outputs": outputs,
                "directory": workDirectory, "started": time.time()}

    jobs.run(
        _JOB_CODE,
        globals={"name": name, "values": _plain_values(description, values),
                 "inputs": {p: [cli_job.fileNameFor(p, t), t] for p, (_, t) in inputs.items()},
                 "outputs": wanted},
        files=files,
        outputs=[path for path, _ in wanted.values()],
        onDone=_finished,
        onFailed=_failed,
        onProgress=lambda message, fraction: host.emit(
            "cli-module", {"state": "running", "name": name, "message": message, "fraction": fraction}),
    )
    host.emit("cli-module", {"state": "started", "name": name, "title": description["title"]})
    return {"outputs": outputIDs, "worker": True}


def _run_here(name, description, values):
    """The module in the page, for when there is no worker to run it in."""
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
    return seconds


def _finished(result, files):
    """The worker is done: read what it wrote into the nodes the panel is holding."""
    global _running

    job, _running = _running, None
    if job is None:
        return
    read = {}
    try:
        for parameter, (nodeID, _) in job["outputs"].items():
            path = (result or {}).get(parameter)
            data = files.get(path) if path else None
            if data is None:
                raise RuntimeError(f"{job['title']} did not write {parameter}")
            here = os.path.join(job["directory"], os.path.basename(path))
            with open(here, "wb") as f:
                f.write(data)
            cli_job.readInto(_node(nodeID), here)
            read[parameter] = nodeID
    except Exception as e:
        logger.exception("What %s made could not be read back", job["title"])
        host.emit("cli-module", {"state": "failed", "name": job["name"], "message": str(e)})
        return
    seconds = round(time.time() - job["started"], 2)
    logger.info("%s finished in %.1f s", job["title"], seconds)
    host.emit("cli-module", {"state": "finished", "name": job["name"], "outputs": read, "seconds": seconds})


def _failed(message):
    global _running

    job, _running = _running, None
    if job is None:
        return  # the job was cancelled, which was reported when it was stopped
    host.emit("cli-module", {"state": "failed", "name": job["name"], "message": str(message)})


@method()
def cancelCliModule():
    """Stop the module that is running: the worker is ended and a new one starts for the next."""
    global _running

    job, _running = _running, None
    jobs.cancel()
    host.emit("cli-module", {"state": "cancelled", "name": job["name"] if job else None})
    return True


@method()
def prepareCliWorker():
    """Start the worker before it is needed, so that Apply does not pay for starting it.

    Called when a CLI module's panel is opened: loading Python and the wheels into a worker takes a
    few seconds, and doing it while the parameters are being chosen hides that wait.
    """
    return jobs.start()


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

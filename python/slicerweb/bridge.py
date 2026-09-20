"""SlicerBridge: JSON API used by the web user interface (module panels, widgets, viewers).

The same API is served in two environments:

- in the browser, the web page calls :func:`call` directly through Pyodide
  (``pyodide.globals.get("slicerweb").bridge.call(method, argsJson)``);
- in desktop Slicer, the ``SlicerWebWidgets`` extension serves it through ``QWebChannel`` so that the
  same web widgets can be used as module GUIs inside the Qt application.

Requests and responses are JSON strings. VTK objects are returned as references
``{"__vtk__": className, "id": <MRML node ID or null>}``. Notifications are sent with
:func:`slicerweb.host.emit`: ``scene-changed``, ``node-modified``, ``layout-changed`` ...
"""

import json
import logging
import traceback

import vtk

from . import host

logger = logging.getLogger("slicerweb.bridge")

_methods = {}
_observed = {}  # nodeID -> (node, [observer tags])
_scene_observers = []


def method(name=None):
    def decorator(fn):
        _methods[name or fn.__name__] = fn
        return fn

    return decorator


def call(methodName, argsJson="[]"):
    """Invoke a bridge method. Returns a JSON string {"result": ...} or {"error": ...}."""
    try:
        args = json.loads(argsJson) if argsJson else []
        fn = _methods.get(methodName)
        if fn is None:
            raise KeyError(f"Unknown bridge method: {methodName}")
        result = fn(**args) if isinstance(args, dict) else fn(*args)
        return json.dumps({"result": to_json(result)})
    except Exception as e:
        logger.debug("Bridge call %s failed: %s", methodName, traceback.format_exc())
        return json.dumps({"error": str(e), "type": type(e).__name__})


def methods():
    return sorted(_methods)


# --------------------------------------------------------------------------- serialization
def to_json(value):
    import vtk

    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_json(v) for v in value]
    if isinstance(value, vtk.vtkObjectBase):
        ref = {"__vtk__": value.GetClassName(), "id": None}
        if hasattr(value, "GetID") and callable(getattr(value, "GetID")) and value.IsA("vtkMRMLNode"):
            ref["id"] = value.GetID()
            ref["name"] = value.GetName()
        return ref
    try:
        return [to_json(v) for v in value]
    except TypeError:
        return str(value)


def _scene():
    import slicer

    return slicer.mrmlScene


def _node(nodeID):
    node = _scene().GetNodeByID(nodeID)
    if node is None:
        raise KeyError(f"Node not found: {nodeID}")
    return node


def _resolve_target(target):
    """Resolve a call target: 'app', 'layout', 'io', 'scene', 'appLogic', 'node:<id>', 'logic:<module>'."""
    import slicer

    app = slicer.app
    if target == "app":
        return app
    if target == "layout":
        return app.layoutManager()
    if target == "io":
        return app.coreIOManager()
    if target == "scene":
        return app.mrmlScene()
    if target == "appLogic":
        return app.applicationLogic()
    if target.startswith("node:"):
        return _node(target[5:])
    if target.startswith("logic:"):
        logic = app.applicationLogic().GetModuleLogic(target[6:])
        if logic is None:
            module = app.moduleManager().module(target[6:])
            logic = module.logic() if module else None
        if logic is None:
            raise KeyError(f"No logic for module {target[6:]}")
        return logic
    if target.startswith("module:"):
        return app.moduleManager().module(target[7:])
    if target.startswith("class:"):
        return getattr(slicer, target[6:])
    raise KeyError(f"Unknown target: {target}")


def _resolve_args(args):
    """Convert {"__node__": id} references in arguments to MRML nodes."""
    out = []
    for a in args or []:
        if isinstance(a, dict) and "__node__" in a:
            out.append(_node(a["__node__"]) if a["__node__"] else None)
        else:
            out.append(a)
    return out


# --------------------------------------------------------------------------- generic calls
@method()
def invoke(target, name, args=None):
    """Call ``target.name(*args)``. Example: invoke("node:vtkMRMLScalarVolumeNode1", "SetName", ["CT"])."""
    obj = _resolve_target(target)
    fn = getattr(obj, name)
    return fn(*_resolve_args(args))


@method()
def invokeMany(calls):
    """Batch of invoke calls: [[target, name, args], ...]; returns list of results."""
    return [invoke(*c) for c in calls]


@method()
def evalPython(code, mode="exec"):
    """Execute Python code in the __main__ namespace (Python console, desktop proxy parity)."""
    import __main__

    namespace = __main__.__dict__
    if mode == "eval":
        return repr(eval(code, namespace))
    exec(compile(code, "<console>", "exec"), namespace)
    return None


@method()
def completePython(text, cursor=None, limit=200):
    """Completions for the Python console at the cursor position (like the desktop Python console).

    Returns {"start": index where the completed word starts, "items": [{"text", "callable"}]}.
    """
    import __main__
    import re
    import rlcompleter

    if cursor is None:
        cursor = len(text)
    before = text[:cursor]
    namespace = __main__.__dict__

    # Expression ending at the cursor: names, dots, and bracketed call/index arguments
    i = cursor
    depth = 0
    while i > 0:
        c = before[i - 1]
        if c in ")]":
            depth += 1
        elif c in "([":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and not (c.isalnum() or c in "_."):
            break
        i -= 1
    expression = before[i:]
    base, dot, prefix = expression.rpartition(".")
    if dot and re.fullmatch(r"\w*", prefix) and re.search(r"[)\]]$", base):
        # Attribute of a call or index result, e.g. getNode("CT").GetIm (desktop console does the same:
        # the expression is evaluated)
        try:
            obj = eval(base, namespace)
        except Exception:
            return {"start": cursor, "items": []}
        items = []
        for name in sorted(dir(obj), key=str.lower):
            if not name.startswith(prefix) or (name.startswith("_") and not prefix.startswith("_")):
                continue
            try:
                isCallable = callable(getattr(obj, name))
            except Exception:
                isCallable = False
            items.append({"text": name, "callable": isCallable})
            if len(items) >= limit:
                break
        return {"start": cursor - len(prefix), "items": items}

    match = re.search(r"[A-Za-z_][\w.]*$|(?<=\.)$", before)
    word = match.group(0) if match else ""
    if not word:
        return {"start": cursor, "items": []}
    completer = rlcompleter.Completer(namespace)
    items, seen = [], set()
    state = 0
    while len(items) < limit:
        try:
            candidate = completer.complete(word, state)
        except Exception:
            break
        state += 1
        if candidate is None:
            break
        isCallable = candidate.endswith("(") or candidate.endswith("()")
        name = candidate[:-2] if candidate.endswith("()") else candidate.rstrip("(")
        # hide private members unless the user started typing an underscore
        last = name.rsplit(".", 1)[-1]
        if last.startswith("_") and not word.rsplit(".", 1)[-1].startswith("_"):
            continue
        if name in seen:
            continue
        seen.add(name)
        items.append({"text": name, "callable": isCallable})
    items.sort(key=lambda i: i["text"].lower())
    return {"start": cursor - len(word), "items": items}


@method()
def getMissingPythonModules():
    """{package: [module names]} of scripted modules that could not be imported yet (see loadModules)."""
    import slicer

    return dict(slicer.app.moduleManager().missingPythonModules)


@method()
def loadModules():
    """Load newly available modules (installed extensions, modules whose Python packages were installed)."""
    import slicer

    manager = slicer.app.moduleManager()
    manager.missingPythonModules.clear()
    manager.loadModules()
    return manager.moduleSummaries()


# --------------------------------------------------------------------------- nodes
def _node_summary(node):
    info = {"id": node.GetID(), "name": node.GetName(), "className": node.GetClassName(),
            "hidden": bool(node.GetHideFromEditors())}
    if node.IsA("vtkMRMLDisplayableNode"):
        d = node.GetDisplayNode()
        info["visible"] = bool(d.GetVisibility()) if d else False
        info["displayNodeID"] = d.GetID() if d else None
        if d is not None and hasattr(d, "GetColor"):
            info["color"] = list(d.GetColor())
    return info


@method()
def getNodes(className="vtkMRMLNode", includeHidden=False):
    nodes = _scene().GetNodesByClass(className)
    result = []
    for i in range(nodes.GetNumberOfItems()):
        n = nodes.GetItemAsObject(i)
        if includeHidden or not n.GetHideFromEditors():
            result.append(_node_summary(n))
    return result


@method()
def getNode(nodeID):
    return _node_summary(_node(nodeID))


@method()
def getNodeProperties(nodeID, names):
    """Read properties with Get<Name>() (e.g. names=["Name", "Visibility", "Color"])."""
    node = _node(nodeID)
    result = {}
    for name in names:
        getter = getattr(node, "Get" + name, None) or getattr(node, name, None)
        result[name] = getter() if callable(getter) else None
    return result


@method()
def setNodeProperties(nodeID, properties):
    """Set properties with Set<Name>(value); values that are lists are expanded."""
    node = _node(nodeID)
    wasModifying = node.StartModify()
    try:
        for name, value in properties.items():
            setter = getattr(node, "Set" + name)
            if isinstance(value, dict) and "__node__" in value:
                setter(_node(value["__node__"]).GetID() if value["__node__"] else None)
            elif isinstance(value, list):
                setter(*value)
            else:
                setter(value)
    finally:
        node.EndModify(wasModifying)
    return True


@method()
def removeNode(nodeID):
    _scene().RemoveNode(_node(nodeID))
    return True


@method()
def setDisplayVisibility(nodeID, visible):
    node = _node(nodeID)
    if hasattr(node, "SetDisplayVisibility"):
        node.SetDisplayVisibility(bool(visible))
    return True


@method()
def observeNode(nodeID, enable=True):
    """Send ``node-modified`` events for a node (and its display node) while observed."""
    import slicer

    if not enable:
        entry = _observed.pop(nodeID, None)
        if entry:
            for obj, tag in entry:
                obj.RemoveObserver(tag)
        return True
    if nodeID in _observed:
        return True
    node = _node(nodeID)

    def onModified(caller, event, nodeID=nodeID):
        host.emit("node-modified", {"id": nodeID})

    tags = [(node, node.AddObserver(vtk.vtkCommand.ModifiedEvent, onModified))]
    if hasattr(node, "GetDisplayNode") and node.GetDisplayNode() is not None:
        d = node.GetDisplayNode()
        tags.append((d, d.AddObserver(vtk.vtkCommand.ModifiedEvent, onModified)))
    _observed[nodeID] = tags
    return True


def install_scene_observers():
    """Notify the web page when nodes are added or removed (for node lists and trees)."""
    import slicer

    scene = slicer.mrmlScene

    def nodeEvent(kind):
        def callback(caller, event, callData=None):
            payload = {"event": kind}
            if callData is not None:
                payload.update({"id": callData.GetID(), "className": callData.GetClassName(),
                                "name": callData.GetName()})
            host.emit("scene-changed", payload)

        callback.CallDataType = vtk.VTK_OBJECT
        return callback

    for event, kind in ((slicer.vtkMRMLScene.NodeAddedEvent, "added"),
                        (slicer.vtkMRMLScene.NodeRemovedEvent, "removed")):
        _scene_observers.append(scene.AddObserver(event, nodeEvent(kind)))
    for event, kind in ((slicer.vtkMRMLScene.EndCloseEvent, "closed"),
                        (slicer.vtkMRMLScene.EndImportEvent, "imported"),
                        (slicer.vtkMRMLScene.EndBatchProcessEvent, "batch")):
        _scene_observers.append(scene.AddObserver(event, lambda c, e, kind=kind: host.emit("scene-changed", {"event": kind})))


# --------------------------------------------------------------------------- subject hierarchy
@method()
def getSubjectHierarchy():
    """Tree of subject hierarchy items: [{id, name, nodeID, className, visible, children:[...]}]."""
    import slicer

    shNode = slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(_scene())
    if shNode is None:
        return []
    import vtk

    def build(itemID):
        children = vtk.vtkIdList()
        shNode.GetItemChildren(itemID, children, False)
        result = []
        for i in range(children.GetNumberOfIds()):
            child = children.GetId(i)
            dataNode = shNode.GetItemDataNode(child)
            if dataNode is not None and dataNode.GetHideFromEditors():
                continue
            entry = {
                "id": int(child),
                "name": shNode.GetItemName(child),
                "nodeID": dataNode.GetID() if dataNode else None,
                "className": dataNode.GetClassName() if dataNode else shNode.GetItemLevel(child),
                "level": shNode.GetItemLevel(child),
                "visible": bool(shNode.GetItemDisplayVisibility(child)),
                "children": build(child),
            }
            result.append(entry)
        return result

    return build(shNode.GetSceneItemID())


@method()
def setSubjectHierarchyItemVisibility(itemID, visible):
    import slicer

    shNode = slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(_scene())
    shNode.SetItemDisplayVisibility(int(itemID), bool(visible))
    return True


# --------------------------------------------------------------------------- layout and views
@method()
def setLayout(layout):
    import slicer

    slicer.app.layoutManager().setLayout(layout)
    return slicer.app.layoutManager().layout()


@method()
def getLayoutDescription():
    import slicer

    lm = slicer.app.layoutManager()
    maximized = lm.maximizedViewNode()
    return {"layout": lm.layout(), "description": lm.layoutDescription(), "available": lm.availableLayouts(),
            "maximized": maximized.GetLayoutName() if maximized is not None else None}


@method()
def attachView(layoutName, canvasSelector, width=0, height=0):
    import slicer

    return slicer.app.layoutManager().attachView(layoutName, canvasSelector, width, height)


@method()
def detachView(layoutName):
    import slicer

    slicer.app.layoutManager().detachView(layoutName)
    return True


@method()
def resizeView(layoutName, width, height):
    import slicer

    slicer.app.layoutManager().resizeView(layoutName, width, height)
    return True


@method()
def getSliceViewState(layoutName):
    """State shown in the slice view controller bar and corner annotations."""
    import slicer

    widget = slicer.app.layoutManager().sliceWidget(layoutName)
    if widget is None:
        return None
    logic = widget.sliceLogic()
    sliceNode = widget.mrmlSliceNode()
    composite = logic.GetSliceCompositeNode()
    # Same as qMRMLSliceControllerWidget: slider range and step from the slice logic
    offsetRange = [-100.0, 100.0]
    resolution = vtk.reference(1.0)
    logic.GetSliceOffsetRangeResolution(offsetRange, resolution)
    return {
        "orientation": sliceNode.GetOrientation(),
        "offset": logic.GetSliceOffset(),
        "offsetRange": list(offsetRange),
        "offsetResolution": float(resolution),
        "backgroundVolumeID": composite.GetBackgroundVolumeID(),
        "foregroundVolumeID": composite.GetForegroundVolumeID(),
        "labelVolumeID": composite.GetLabelVolumeID(),
        "foregroundOpacity": composite.GetForegroundOpacity(),
        "labelOpacity": composite.GetLabelOpacity(),
        "sliceVisible": bool(sliceNode.GetSliceVisible()),
        "linked": bool(composite.GetLinkedControl()),
        "fieldOfView": list(sliceNode.GetFieldOfView()),
    }


@method()
def setSliceOffset(layoutName, offset):
    import slicer

    slicer.app.layoutManager().sliceWidget(layoutName).sliceLogic().SetSliceOffset(float(offset))
    return True


@method()
def setSliceOrientation(layoutName, orientation):
    import slicer

    slicer.app.layoutManager().sliceWidget(layoutName).mrmlSliceNode().SetOrientation(orientation)
    return True


@method()
def setSliceLayerVolume(layoutName, layer, volumeNodeID):
    import slicer

    composite = slicer.app.layoutManager().sliceWidget(layoutName).mrmlSliceCompositeNode()
    {"background": composite.SetBackgroundVolumeID, "foreground": composite.SetForegroundVolumeID,
     "label": composite.SetLabelVolumeID}[layer](volumeNodeID or None)
    return True


@method()
def fitSliceViews():
    import slicer

    slicer.app.layoutManager().resetSliceViews()
    return True


@method()
def renderView(layoutName):
    """Render a view immediately (the magnifier reads the pixels of the rendered image)."""
    import slicer

    view = slicer.app.layoutManager().view(layoutName)
    if view is None:
        return False
    view.Render()
    return True


@method()
def markupsInteractionActive():
    """True while control points are placed or one is being moved (the touch magnifier is shown then)."""
    import slicer

    interaction = slicer.app.applicationLogic().GetInteractionNode()
    if interaction is not None and interaction.GetCurrentInteractionMode() == interaction.Place:
        return True
    nodes = slicer.mrmlScene.GetNodesByClass("vtkMRMLMarkupsDisplayNode")
    try:
        for i in range(nodes.GetNumberOfItems()):
            display = nodes.GetItemAsObject(i)
            if display.GetActiveComponentType() == display.ComponentControlPoint:
                return True
    finally:
        nodes.UnRegister(None)
    return False


@method()
def viewDoubleClick(layoutName, x, y):
    """Deliver a double click at a position of a view (device pixels, origin top left).

    Touch screens have no double click: the web page detects a double tap and calls this, so that
    the same Slicer widgets handle it as for a mouse (maximizing the view, by default).
    """
    import slicer

    view = slicer.app.layoutManager().view(layoutName)
    if view is None:
        return False
    interactor = view.GetInteractor()
    # Process the queued browser events first (the taps): the widgets act on a double click only
    # when they are not interacting (e.g. the camera widget of a 3D view).
    interactor.ProcessEvents()
    interactor.SetEventPositionFlipY(int(x), int(y))
    interactor.InvokeEvent(vtk.vtkCommand.LeftButtonDoubleClickEvent)
    return True


@method()
def maximizeView(layoutName):
    """Show the view alone, or restore the layout if it is already maximized (toggle)."""
    import slicer

    manager = slicer.app.layoutManager()
    view = manager.viewNode(layoutName) if hasattr(manager, "viewNode") else None
    manager.maximizeView(view)
    return manager.maximizedViewNode() is not None


@method()
def resetThreeDViews():
    import slicer

    slicer.app.layoutManager().resetThreeDViews()
    return True


@method()
def setInteractionMode(mode, placeNodeClassName=None, persistent=False):
    """Mouse mode: "ViewTransform", "Place", "AdjustWindowLevel" (toolbar)."""
    import slicer

    appLogic = slicer.app.applicationLogic()
    interaction = appLogic.GetInteractionNode()
    if mode == "Place" and placeNodeClassName:
        selection = appLogic.GetSelectionNode()
        selection.SetReferenceActivePlaceNodeClassName(placeNodeClassName)
    interaction.SetPlaceModePersistence(1 if persistent else 0)
    interaction.SetCurrentInteractionMode(getattr(slicer.vtkMRMLInteractionNode, mode))
    return True


@method()
def placeMarkup(className, name=None, persistent=False):
    """Create a markups node and enter place mode (Markups toolbar buttons)."""
    import slicer

    scene = _scene()
    node = scene.AddNewNodeByClass(className, name or "")
    node.CreateDefaultDisplayNodes()
    selection = slicer.app.applicationLogic().GetSelectionNode()
    selection.SetReferenceActivePlaceNodeClassName(className)
    selection.SetActivePlaceNodeID(node.GetID())
    interaction = slicer.app.applicationLogic().GetInteractionNode()
    interaction.SetPlaceModePersistence(1 if persistent else 0)
    interaction.SetCurrentInteractionMode(slicer.vtkMRMLInteractionNode.Place)
    return node


# --------------------------------------------------------------------------- data
@method()
def loadFiles(fileNames, properties=None):
    import slicer

    return slicer.app.coreIOManager().loadFiles(fileNames, properties or {})


@method()
def saveNode(nodeID, fileName, properties=None):
    import slicer

    io = slicer.app.coreIOManager()
    node = _node(nodeID)
    props = dict(properties or {}, nodeID=nodeID, fileName=fileName)
    return io.saveNodes(io.fileWriterFileType(node), props)


@method()
def saveScene(fileName):
    import slicer

    return slicer.app.coreIOManager().saveNodes("SceneFile", {"fileName": fileName})


@method()
def closeScene():
    _scene().Clear(False)
    return True


@method()
def showScriptedModuleWidget(moduleName, containerSelector):
    from .modules import show_scripted_module_widget

    return show_scripted_module_widget(moduleName, containerSelector)


@method()
def reloadScriptedModule(moduleName):
    """Developer tools: reload the module's Python file and rebuild its GUI."""
    from .modules import reload_scripted_module

    return reload_scripted_module(moduleName)


@method()
def runScriptedModuleTest(moduleName, reload=False):
    """Developer tools: run the module's self test (optionally after reloading it)."""
    from .modules import reload_scripted_module, run_scripted_module_test

    if reload:
        reload_scripted_module(moduleName)
    return run_scripted_module_test(moduleName)


@method()
def hideScriptedModuleWidget(moduleName):
    from .modules import hide_scripted_module_widget

    return hide_scripted_module_widget(moduleName)


@method()
def getModules():
    import slicer

    return slicer.app.moduleManager().moduleSummaries()


@method()
def getVolumeDisplayPresets():
    import slicer

    logic = slicer.app.applicationLogic().GetModuleLogic("Volumes")
    presets = []
    for i in range(logic.GetNumberOfVolumeDisplayPresets() if hasattr(logic, "GetNumberOfVolumeDisplayPresets") else 0):
        presets.append(logic.GetVolumeDisplayPresetIDs()[i] if hasattr(logic, "GetVolumeDisplayPresetIDs") else i)
    ids = logic.GetVolumeDisplayPresetIDs() if hasattr(logic, "GetVolumeDisplayPresetIDs") else []
    result = []
    for presetId in ids:
        preset = logic.GetVolumeDisplayPreset(presetId)
        result.append({"id": presetId, "name": preset.name, "window": preset.window, "level": preset.level})
    return result

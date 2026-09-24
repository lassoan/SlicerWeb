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
def errorLogEntries(limit=500, levels=None):
    """Messages of the application log (the error log model of desktop Slicer).

    The page is sent each message as it happens; this is what a log window opened later shows.
    """
    from .logging_handler import error_log

    entries = error_log().entries
    if levels:
        wanted = {str(level).upper() for level in levels}
        entries = [e for e in entries if str(e["level"]).upper() in wanted]
    return entries[-int(limit):]


@method()
def logMessage(level, message, origin="Web"):
    """Put a message from the web page into the application log (the log window shows it)."""
    from .logging_handler import error_log

    error_log().add(str(level).upper(), str(message), str(origin))
    return True


@method()
def setLogLevel(level):
    """How much is logged ("DEBUG", "INFO", "WARNING", "ERROR").

    Debug messages are not kept unless they are asked for: every message is sent to the page, and
    the debug ones are many.
    """
    import logging

    logging.getLogger().setLevel(getattr(logging, str(level).upper(), logging.INFO))
    return logging.getLogger().level


@method()
def clearErrorLog():
    from .logging_handler import error_log

    error_log().clear()
    return True


@method()
def getNodes(className="vtkMRMLNode", includeHidden=False, attributes=None):
    """Nodes of a class, optionally only those with the given attributes.

    attributes is {name: value} as qMRMLNodeComboBox::addAttribute() takes them: a value of None
    matches any node that has the attribute (e.g. parameter nodes of one module).
    """
    nodes = _scene().GetNodesByClass(className)
    result = []
    for i in range(nodes.GetNumberOfItems()):
        n = nodes.GetItemAsObject(i)
        if not includeHidden and n.GetHideFromEditors():
            continue
        if attributes and not all(
                n.GetAttribute(name) is not None and (value is None or n.GetAttribute(name) == str(value))
                for name, value in attributes.items()):
            continue
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

    # What each view shows - the volumes of the slice views' layers, the volumes rendered in the 3D
    # views - is what the eyes of volumes in the Data tree show for the selected view. It changes
    # from the slice controllers, the Volume Rendering module and Python alike: the page is told
    # whenever it has changed.
    shown = {}

    def watchShown(node):
        def state(n):
            if n.IsA("vtkMRMLSliceCompositeNode"):
                return (n.GetBackgroundVolumeID(), n.GetLabelVolumeID())
            return (n.GetVisibility(), tuple(n.GetViewNodeIDs()))

        shown[node.GetID()] = state(node)

        def onModified(caller, event):
            now = state(caller)
            if shown.get(caller.GetID()) != now:
                shown[caller.GetID()] = now
                host.emit("views-shown-changed", {})

        node.AddObserver(vtk.vtkCommand.ModifiedEvent, onModified)

    def onNodeAdded(caller, event, node=None):
        if node is not None and (node.IsA("vtkMRMLSliceCompositeNode") or node.IsA("vtkMRMLVolumeRenderingDisplayNode")):
            watchShown(node)

    onNodeAdded.CallDataType = vtk.VTK_OBJECT
    _scene_observers.append(scene.AddObserver(slicer.vtkMRMLScene.NodeAddedEvent, onNodeAdded))
    for className in ("vtkMRMLSliceCompositeNode", "vtkMRMLVolumeRenderingDisplayNode"):
        for node in _nodesByClass(className):
            watchShown(node)

    # What a click in a view does is the scene's to say, not the toolbar's: it is also set by
    # modules and by Python, and it ends by itself once a markup that is not placed for ever has
    # been placed. The toolbar follows what the interaction node says rather than what it asked for.
    interaction = slicer.app.applicationLogic().GetInteractionNode()
    if interaction is not None:
        for event in (slicer.vtkMRMLInteractionNode.InteractionModeChangedEvent,
                      slicer.vtkMRMLInteractionNode.EndPlacementEvent):
            _scene_observers.append(interaction.AddObserver(event, lambda c, e: host.emit("interaction-mode", interactionMode())))


@method()
def applicationSettings():
    """The application settings (slicer.app.userSettings()), by their Qt key."""
    import slicer

    settings = slicer.app.userSettings()
    return {key: settings.value(key) for key in settings.allKeys()}


@method()
def setApplicationSettings(values):
    """Set application settings by their Qt key, as the Application settings dialog does."""
    import slicer

    slicer.app.userSettings().update(values)
    if any(key.startswith("Developer/ShowRenderingFPS") for key in values or {}):
        slicer.app.layoutManager().applyViewSettings()
    return True


@method()
def interactionMode():
    """What a click in a view does: {mode, placeNodeClassName, persistent}.

    *mode* is what vtkMRMLInteractionNode calls it ("ViewTransform", "Place", "AdjustWindowLevel",
    "Scroll"), and while placing, *placeNodeClassName* is the kind of markup that a click would add to.
    """
    import slicer

    appLogic = slicer.app.applicationLogic()
    interaction = appLogic.GetInteractionNode()
    selection = appLogic.GetSelectionNode()
    if interaction is None:
        return {"mode": "ViewTransform", "placeNodeClassName": "", "persistent": False}
    # Named here rather than with GetInteractionModeAsString, which answers "(unknown)" for
    # AdjustWindowLevel in this build; the class constants are right whatever they are numbered.
    names = {slicer.vtkMRMLInteractionNode.Place: "Place",
             slicer.vtkMRMLInteractionNode.ViewTransform: "ViewTransform",
             slicer.vtkMRMLInteractionNode.AdjustWindowLevel: "AdjustWindowLevel"}
    # Scroll (browse the slices by dragging) is newer than some builds of the interaction node
    if hasattr(slicer.vtkMRMLInteractionNode, "Scroll"):
        names[slicer.vtkMRMLInteractionNode.Scroll] = "Scroll"
    mode = interaction.GetCurrentInteractionMode()
    return {
        "mode": names.get(mode, interaction.GetInteractionModeAsString(mode)),
        "placeNodeClassName": selection.GetActivePlaceNodeClassName() if selection is not None else "",
        "persistent": bool(interaction.GetPlaceModePersistence()),
    }


# --------------------------------------------------------------------------- subject hierarchy
def _volumeRenderingLogic():
    import slicer

    return slicer.app.applicationLogic().GetModuleLogic("VolumeRendering")


def _viewNodeByLayoutName(layoutName):
    """The slice or 3D view node of a view of the layout (None for other views, or none given)."""
    import slicer

    if not layoutName:
        return None
    for className in ("vtkMRMLSliceNode", "vtkMRMLViewNode"):
        nodes = _scene().GetNodesByClass(className)
        for i in range(nodes.GetNumberOfItems()):
            node = nodes.GetItemAsObject(i)
            if node.GetLayoutName() == layoutName:
                return node
    return None


def _volumeVisibleInView(volume, viewNode):
    """Whether a volume is shown in a view: as the background of a slice view (the label layer for a
    labelmap), or volume rendered in a 3D view."""
    import slicer

    if viewNode.IsA("vtkMRMLSliceNode"):
        composite = slicer.app.applicationLogic().GetSliceLogic(viewNode).GetSliceCompositeNode()
        if volume.IsA("vtkMRMLLabelMapVolumeNode"):
            return composite.GetLabelVolumeID() == volume.GetID()
        return composite.GetBackgroundVolumeID() == volume.GetID()
    displayNode = _volumeRenderingLogic().GetFirstVolumeRenderingDisplayNode(volume)
    return bool(displayNode is not None and displayNode.GetVisibility()
                and displayNode.IsDisplayableInView(viewNode.GetID()))


def _setVolumeVisibleInView(volume, viewNode, visible):
    """Show or hide a volume in one view, as its eye in the Data tree does for the selected view.

    In a slice view the volume becomes (or stops being) the background - a labelmap the label
    layer - and slice views linked to it follow, as they follow the slice controller. In a 3D view
    it is volume rendered, the volume rendering made first if there is none; hiding it in the last
    view that shows it hides it (the view's AutoReleaseGraphicsResources then lets go of what it
    had on the graphics card).
    """
    import slicer

    if viewNode.IsA("vtkMRMLSliceNode"):
        logic = slicer.app.applicationLogic().GetSliceLogic(viewNode)
        composite = logic.GetSliceCompositeNode()
        label = volume.IsA("vtkMRMLLabelMapVolumeNode")
        flag = (slicer.vtkMRMLSliceCompositeNode.LabelVolumeFlag if label
                else slicer.vtkMRMLSliceCompositeNode.BackgroundVolumeFlag)
        volumeID = volume.GetID() if visible else None
        # Through the slice logic's interaction, so that linked slice views are given the same
        logic.StartSliceCompositeNodeInteraction(flag)
        if label:
            composite.SetLabelVolumeID(volumeID)
        else:
            composite.SetBackgroundVolumeID(volumeID)
        logic.EndSliceCompositeNodeInteraction()
        return

    vrLogic = _volumeRenderingLogic()
    displayNode = vrLogic.GetFirstVolumeRenderingDisplayNode(volume)
    viewID = viewNode.GetID()
    threeDViews = [n.GetID() for n in _nodesByClass("vtkMRMLViewNode")]
    if visible:
        if displayNode is None:
            # the preset that suits the volume (see setVolumeRendering)
            displayNode = vrLogic.CreateDefaultVolumeRenderingNodes(volume)
            displayNode.SetVisibility(False)
        if not displayNode.GetVisibility():
            # shown here only (all views, when this is the only one)
            displayNode.RemoveAllViewNodeIDs()
            if len(threeDViews) > 1:
                displayNode.AddViewNodeID(viewID)
            displayNode.SetVisibility(True)
        elif not displayNode.IsDisplayableInView(viewID):
            displayNode.AddViewNodeID(viewID)
        return
    if displayNode is None or not _volumeVisibleInView(volume, viewNode):
        return
    others = [i for i in threeDViews if i != viewID and displayNode.IsDisplayableInView(i)]
    if not others:
        displayNode.SetVisibility(False)
    else:
        displayNode.RemoveAllViewNodeIDs()
        for i in others:
            displayNode.AddViewNodeID(i)


def _nodesByClass(className):
    nodes = _scene().GetNodesByClass(className)
    return [nodes.GetItemAsObject(i) for i in range(nodes.GetNumberOfItems())]


@method()
def getSubjectHierarchy(layoutName=None):
    """Tree of subject hierarchy items: [{id, name, nodeID, className, visible, children:[...]}].

    With *layoutName* (the selected view) a volume is visible if it is shown in that view (see
    _volumeVisibleInView), as its eye in the Data tree shows.
    """
    import slicer

    shNode = slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(_scene())
    if shNode is None:
        return []
    import vtk

    viewNode = _viewNodeByLayoutName(layoutName)

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
                "visible": (_volumeVisibleInView(dataNode, viewNode)
                            if viewNode is not None and dataNode is not None and dataNode.IsA("vtkMRMLVolumeNode")
                            else bool(shNode.GetItemDisplayVisibility(child))),
                "children": build(child),
            }
            result.append(entry)
        return result

    return build(shNode.GetSceneItemID())


@method()
def setSubjectHierarchyItemVisibility(itemID, visible, layoutName=None):
    """Show or hide an item; a volume in the selected view (*layoutName*) only."""
    import slicer

    shNode = slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(_scene())
    dataNode = shNode.GetItemDataNode(int(itemID))
    viewNode = _viewNodeByLayoutName(layoutName)
    if viewNode is not None and dataNode is not None and dataNode.IsA("vtkMRMLVolumeNode"):
        _setVolumeVisibleInView(dataNode, viewNode, bool(visible))
        return True
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
def attachView(layoutName, canvasSelector, width=0, height=0, rect=None):
    import slicer

    return slicer.app.layoutManager().attachView(layoutName, canvasSelector, width, height, None, rect)


@method()
def attachSharedCanvas(canvasSelector, width, height):
    """The canvas whose one WebGL context the views share (see slicerweb.layout)."""
    import slicer

    return slicer.app.layoutManager().attachSharedCanvas(canvasSelector, width, height)


@method()
def detachSharedCanvas():
    import slicer

    return slicer.app.layoutManager().detachSharedCanvas()


@method()
def setViewRect(layoutName, x, y, width, height):
    """Where a view sits on the shared canvas, in device pixels from its top left corner."""
    import slicer

    return slicer.app.layoutManager().setViewRect(layoutName, x, y, width, height)


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
        "fieldOfView": list(sliceNode.GetFieldOfView()),
    }


@method()
def setSliceOffset(layoutName, offset):
    """Move the slice, taking the parallel slices of linked views with it.

    The change is wrapped in the slice logic's interaction, as qMRMLSliceControllerWidget does:
    vtkMRMLSliceLinkLogic passes a change on to the other views only while the node it came from
    says it is being interacted with.
    """
    import slicer

    logic = slicer.app.layoutManager().sliceWidget(layoutName).sliceLogic()
    logic.StartSliceOffsetInteraction()
    logic.SetSliceOffset(float(offset))
    logic.EndSliceOffsetInteraction()
    return True


@method()
def setSliceOrientation(layoutName, orientation):
    import slicer

    widget = slicer.app.layoutManager().sliceWidget(layoutName)
    logic = widget.sliceLogic()
    logic.StartSliceNodeInteraction(slicer.vtkMRMLSliceNode.OrientationFlag)
    widget.mrmlSliceNode().SetOrientation(orientation)
    logic.EndSliceNodeInteraction()
    return True


@method()
def setSliceVisible(layoutName, visible):
    """Show or hide the slice in the 3D views (the image button of Slicer's slice controller).

    The change is made between StartSliceNodeInteraction and EndSliceNodeInteraction, as
    qMRMLSliceControllerWidget::setSliceVisible does, so that slice views linked to this one are
    shown and hidden with it.
    """
    import slicer

    widget = slicer.app.layoutManager().sliceWidget(layoutName)
    if widget is None:
        return False
    logic = widget.sliceLogic()
    logic.StartSliceNodeInteraction(slicer.vtkMRMLSliceNode.SliceVisibleFlag)
    widget.mrmlSliceNode().SetSliceVisible(bool(visible))
    logic.EndSliceNodeInteraction()
    return True


@method()
def getViewLinked(layoutName):
    """Whether this view moves the other views of its kind with it."""
    import slicer

    node = slicer.app.layoutManager().viewNode(layoutName)
    if node is None:
        return False
    if node.IsA("vtkMRMLSliceNode"):
        widget = slicer.app.layoutManager().sliceWidget(layoutName)
        return widget is not None and bool(widget.mrmlSliceCompositeNode().GetLinkedControl())
    return bool(node.GetLinkedControl())


@method()
def setViewLinked(layoutName, linked):
    """Link or unlink all the views of this one's kind.

    Linking is a property of each view, but Slicer's link buttons set it on all of them at once, so
    that the chain is never half closed: slice views through their composite nodes
    (qMRMLSliceControllerWidget::setSliceLink), 3D views through their view nodes
    (qMRMLThreeDViewControllerWidget::setViewLink). vtkMRMLApplicationLogic owns the logics that do
    the propagating, so there is nothing else to set up.
    """
    import slicer

    node = slicer.app.layoutManager().viewNode(layoutName)
    if node is None:
        return False
    className = "vtkMRMLSliceCompositeNode" if node.IsA("vtkMRMLSliceNode") else "vtkMRMLViewNode"
    for other in slicer.util.getNodesByClass(className):
        other.SetLinkedControl(bool(linked))
    return True


@method()
def setSliceLayerVolume(layoutName, layer, volumeNodeID):
    """Choose what a slice view shows, in linked views as well."""
    import slicer

    widget = slicer.app.layoutManager().sliceWidget(layoutName)
    composite = widget.mrmlSliceCompositeNode()
    setter, flag = {
        "background": (composite.SetBackgroundVolumeID, slicer.vtkMRMLSliceCompositeNode.BackgroundVolumeFlag),
        "foreground": (composite.SetForegroundVolumeID, slicer.vtkMRMLSliceCompositeNode.ForegroundVolumeFlag),
        "label": (composite.SetLabelVolumeID, slicer.vtkMRMLSliceCompositeNode.LabelVolumeFlag),
    }[layer]
    logic = widget.sliceLogic()
    logic.StartSliceCompositeNodeInteraction(flag)
    setter(volumeNodeID or None)
    logic.EndSliceCompositeNodeInteraction()
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
    """Mouse mode: "ViewTransform", "Place", "AdjustWindowLevel", "Scroll" (toolbar)."""
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
def getExtensionPythonPackages():
    """Pyodide packages the installed extensions ask for (SciPy, for one); the page loads them."""
    import slicer

    from .modules import extension_python_packages

    return extension_python_packages(slicer.app)


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

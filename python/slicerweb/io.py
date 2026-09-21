"""Qt-free equivalent of qSlicerCoreIOManager and the qSlicer*Reader / qSlicerNodeWriter classes.

``slicer.util.loadVolume()``, ``loadModel()``, ``loadSegmentation()``, ``saveNode()``,
``saveScene()`` ... call ``slicer.app.coreIOManager()``; this class implements the methods they use
with the same file types (``"VolumeFile"``, ``"ModelFile"``, ...) and IO properties, and the same
module logic calls as the desktop readers.

Files are read from the Emscripten virtual file system. The web page copies files selected or
dropped by the user (or downloaded from a URL) into ``/data`` and then calls :meth:`loadFiles`.
"""

import logging
import os

import vtk

from . import host

logger = logging.getLogger("slicerweb.io")


def _lower_ext(filename):
    name = os.path.basename(filename).lower()
    for compound in (".seg.nrrd", ".seg.nhdr", ".seg.vtm", ".seq.nrrd", ".seq.nhdr", ".seq.mrb", ".mrk.json",
                     ".nii.gz", ".img.gz", ".vtk.gz", ".tar.gz", ".mrml.gz"):
        if name.endswith(compound):
            return compound
    return os.path.splitext(name)[1]


# File type -> extensions (first match wins in the order of FILE_TYPES)
FILE_TYPES = [
    ("SceneFile", [".mrml", ".mrb", ".zip"]),
    ("SegmentationFile", [".seg.nrrd", ".seg.nhdr", ".seg.vtm"]),
    ("SequenceFile", [".seq.nrrd", ".seq.nhdr", ".seq.mrb"]),
    ("MarkupsFile", [".mrk.json", ".fcsv"]),
    ("TransformFile", [".h5", ".tfm", ".mat"]),
    ("VolumeFile", [".nrrd", ".nhdr", ".nii", ".nii.gz", ".mha", ".mhd", ".hdr", ".img", ".img.gz", ".gipl",
                    ".dcm", ".ima", ".tif", ".tiff", ".png", ".jpg", ".jpeg", ".bmp", ".mgz", ".mgh", ".mrc",
                    ".rec", ".pic", ".lsm", ".spr", ".vti"]),
    ("ModelFile", [".vtk", ".vtp", ".vtu", ".stl", ".obj", ".ply", ".ucd", ".byu", ".g", ".tri", ".vtk.gz"]),
    ("ColorTableFile", [".ctbl", ".cjson"]),
    ("TableFile", [".tsv", ".csv", ".txt.tsv"]),
    ("TextFile", [".txt", ".xml", ".json"]),
]

# File type -> (node class used to determine default writer, description) for writing
WRITER_DESCRIPTIONS = {
    "VolumeFile": "Volume",
    "ModelFile": "Model",
    "SegmentationFile": "Segmentation",
    "MarkupsFile": "Markups",
    "TransformFile": "Transform",
    "ColorTableFile": "Color table",
    "TableFile": "Table",
    "TextFile": "Text",
    "SequenceFile": "Sequence",
    "SceneFile": "Scene",
}


class IOManager:
    def __init__(self, app):
        self._app = app
        self._defaultSceneFileType = "MRML Scene (.mrml)"

    # ------------------------------------------------------------------ helpers
    def _scene(self):
        return self._app.mrmlScene()

    def _logic(self, moduleName):
        return self._app.applicationLogic().GetModuleLogic(moduleName)

    def _appLogic(self):
        return self._app.applicationLogic()

    # ------------------------------------------------------------------ file types
    #
    # Which readers and writers there are is kept by vtkSlicerFileIOManager (see io_registry): the
    # application registers its own at startup and a module adds the ones it brings. These methods
    # ask it, so that a module's reader counts wherever a file type is looked up.

    def readerForFile(self, fileName):
        """The reader that is to read this file, or None.

        Every reader that knows the extension is asked how sure it is (a module's reader may look
        inside the file); the surest one wins, as qSlicerCoreIOManager does it.
        """
        from . import io_registry, io_scripted

        best, bestConfidence = None, 0.0
        for reader in io_registry.readers_for_file(fileName):
            confidence = (io_scripted.confidence_for_file(reader, fileName) if reader.GetOwner()
                          else reader.CanLoadFileConfidence(str(fileName)))
            if confidence > bestConfidence:
                best, bestConfidence = reader, confidence
        return best

    def fileType(self, fileName):
        reader = self.readerForFile(fileName)
        return reader.GetFileType() if reader is not None else "NoFile"

    def fileTypesFromFileName(self, fileName):
        from . import io_registry

        return [reader.GetFileType() for reader in io_registry.readers_for_file(fileName)]

    def fileDescriptions(self, fileType):
        from . import io_registry

        description = io_registry.description_for_file_type(fileType)
        return [description or WRITER_DESCRIPTIONS.get(fileType, fileType)]

    def registeredFileReaderCount(self, fileType=None):
        from . import io_registry

        types = io_registry.file_types()
        return len(types) if fileType is None else types.count(fileType)

    def readerFileTypes(self):
        from . import io_registry

        return io_registry.file_types()

    def fileExtensions(self, fileType):
        from . import io_registry

        return io_registry.extensions_for_file_type(fileType)

    def allReadableFileExtensions(self):
        from . import io_registry

        extensions = []
        for fileType in io_registry.file_types():
            for extension in io_registry.extensions_for_file_type(fileType):
                if extension not in extensions:
                    extensions.append(extension)
        return extensions

    # ------------------------------------------------------------------ loading
    def loadNodes(self, fileType, properties, loadedNodes=None, userMessages=None):
        """Same signature as qSlicerCoreIOManager::loadNodes. Returns True on success."""
        properties = dict(properties)
        fileName = str(properties.get("fileName", ""))
        if not fileName or not os.path.exists(fileName):
            self._addMessage(userMessages, f"File not found: {fileName}")
            return False
        scripted = self._scriptedReader(fileType, fileName)
        if scripted is not None:
            return self._loadWithScriptedReader(scripted, properties, loadedNodes, userMessages)

        reader = getattr(self, "_read" + fileType, None)
        if reader is None:
            self._addMessage(userMessages, f"No reader for file type {fileType}")
            return False
        scene = self._scene()
        try:
            nodes = reader(fileName, properties, userMessages) or []
        except Exception as e:
            logger.exception("Failed to load %s", fileName)
            self._addMessage(userMessages, f"Failed to load {fileName}: {e}")
            return False
        for node in nodes:
            if loadedNodes is not None:
                loadedNodes.AddItem(node)
            node.SetAttribute("SlicerWeb.SourceFile", fileName) if hasattr(node, "SetAttribute") else None
        host.emit("nodes-loaded", {"fileName": fileName, "nodeIDs": [n.GetID() for n in nodes]})
        return len(nodes) > 0 or fileType == "SceneFile"

    def loadNodesAndGetFirst(self, fileType, properties):
        import vtk

        nodes = vtk.vtkCollection()
        self.loadNodes(fileType, properties, nodes)
        return nodes.GetItemAsObject(0) if nodes.GetNumberOfItems() else None

    def loadFiles(self, fileNames, properties=None):
        """Load files selected in the web page (fileType is determined from the extension).

        DICOM files (.dcm) given together are loaded as one series. Returns loaded node IDs.
        """
        import vtk

        properties = properties or {}
        fileNames = [str(f) for f in fileNames]
        dicom = [f for f in fileNames if _lower_ext(f) in (".dcm", ".ima", "")]
        others = [f for f in fileNames if f not in dicom]
        loadedIDs = []
        if dicom:
            nodes = vtk.vtkCollection()
            props = dict(properties, fileName=dicom[0], fileNames=dicom, singleFile=False)
            self.loadNodes("VolumeFile", props, nodes)
            loadedIDs += [nodes.GetItemAsObject(i).GetID() for i in range(nodes.GetNumberOfItems())]
        for fileName in others:
            fileType = self.fileType(fileName)
            if fileType == "NoFile":
                logger.warning("Nothing reads %s", fileName)
                continue
            nodes = vtk.vtkCollection()
            self.loadNodes(fileType, dict(properties, fileName=fileName), nodes)
            loadedIDs += [nodes.GetItemAsObject(i).GetID() for i in range(nodes.GetNumberOfItems())]
        return loadedIDs

    def _scriptedReader(self, fileType, fileName):
        """The reader a module registered for this file type, where it can read this file."""
        from . import io_registry, io_scripted

        for reader in io_registry.readers_for_file(fileName):
            if (reader.GetOwner() and reader.GetFileType() == fileType
                    and io_scripted.confidence_for_file(reader, fileName) > 0.0):
                return reader
        return None

    def _loadWithScriptedReader(self, reader, properties, loadedNodes, userMessages):
        """Let a module's reader read the file, and collect what it put in the scene."""
        from . import io_scripted

        fileName = str(properties.get("fileName", ""))
        try:
            nodeIDs = io_scripted.load(reader, properties)
        except ModuleNotFoundError:
            raise   # the page installs the package and tries again (see slicerweb.packages)
        except Exception as e:
            logger.exception("The reader of %s failed on %s", reader.GetOwner(), fileName)
            self._addMessage(userMessages, f"Failed to load {fileName}: {e}")
            return False
        if userMessages is not None:
            userMessages.AddMessages(reader.GetUserMessages())
        scene = self._scene()
        for nodeID in nodeIDs:
            node = scene.GetNodeByID(nodeID)
            if node is not None and loadedNodes is not None:
                loadedNodes.AddItem(node)
        host.emit("nodes-loaded", {"fileName": fileName, "nodeIDs": list(nodeIDs)})
        return bool(nodeIDs)

    @staticmethod
    def _addMessage(userMessages, text, error=True):
        logger.error(text) if error else logger.warning(text)
        if userMessages is not None:
            try:
                import slicer

                userMessages.AddMessage(vtk.vtkCommand.ErrorEvent if error else vtk.vtkCommand.WarningEvent, text)
            except Exception:
                pass

    # --- readers (same logic calls as the desktop qSlicer*Reader classes)
    def _readVolumeFile(self, fileName, properties, userMessages):
        import slicer
        import vtk

        logic = self._logic("Volumes")
        name = properties.get("name") or os.path.basename(fileName).split(".")[0]
        options = 0
        options |= 0x1 if properties.get("labelmap") else 0
        options |= 0x2 if properties.get("center") else 0
        options |= 0x4 if properties.get("singleFile") else 0
        options |= 0x8 if properties.get("autoWindowLevel", True) else 0
        options |= 0x10 if properties.get("discardOrientation") else 0
        fileList = None
        if properties.get("fileNames"):
            fileList = vtk.vtkStringArray()
            for f in properties["fileNames"]:
                fileList.InsertNextValue(str(f))
        node = logic.AddArchetypeVolume(fileName, name, options, fileList)
        if node is None:
            return []
        colorNodeID = properties.get("colorNodeID")
        if colorNodeID and node.GetVolumeDisplayNode():
            node.GetVolumeDisplayNode().SetAndObserveColorNodeID(colorNodeID)
        if properties.get("show", True):
            appLogic = self._app.applicationLogic()
            selectionNode = appLogic.GetSelectionNode()
            if node.IsA("vtkMRMLLabelMapVolumeNode"):
                selectionNode.SetActiveLabelVolumeID(node.GetID())
            else:
                selectionNode.SetActiveVolumeID(node.GetID())
            appLogic.PropagateVolumeSelection()
        return [node]

    def _readModelFile(self, fileName, properties, userMessages):
        import slicer

        logic = self._logic("Models")
        coordinateSystem = int(properties.get("coordinateSystem", slicer.vtkMRMLStorageNode.CoordinateSystemLPS))
        node = logic.AddModel(fileName, coordinateSystem, userMessages)
        if node is None:
            return []
        if properties.get("name"):
            node.SetName(self._scene().GetUniqueNameByString(properties["name"]))
        otherVisible = False
        displayNodes = self._scene().GetNodesByClass("vtkMRMLDisplayNode")
        for i in range(displayNodes.GetNumberOfItems()):
            d = displayNodes.GetItemAsObject(i)
            if d.GetDisplayableNode() and d.GetVisibility() and d.GetDisplayableNode() != node:
                otherVisible = True
                break
        if not otherVisible and self._app.layoutManager():
            self._app.layoutManager().resetThreeDViews()
        return [node]

    def _readSegmentationFile(self, fileName, properties, userMessages):
        import slicer

        logic = self._logic("Segmentations")
        name = properties.get("name", "")
        ext = _lower_ext(fileName)
        scene = self._scene()
        if ext in (".stl", ".obj"):
            storage = slicer.vtkMRMLModelStorageNode()
            storage.SetFileName(fileName)
            model = slicer.vtkMRMLModelNode()
            if not storage.ReadData(model):
                return []
            polyData = model.GetPolyData()
            pointData = polyData.GetPointData()
            while pointData.GetNumberOfArrays() > 0:
                pointData.RemoveArray(0)
            name = name or os.path.basename(fileName).rsplit(".", 1)[0]
            segment = slicer.vtkSegment()
            segment.SetName(name)
            segment.AddRepresentation(slicer.vtkSegmentationConverter.GetSegmentationClosedSurfaceRepresentationName(), polyData)
            node = scene.AddNewNodeByClass("vtkMRMLSegmentationNode", scene.GetUniqueNameByString(name))
            node.SetSourceRepresentationToClosedSurface()
            node.CreateDefaultDisplayNodes()
            node.GetDisplayNode().SetPreferredDisplayRepresentationName2D(
                slicer.vtkSegmentationConverter.GetSegmentationClosedSurfaceRepresentationName())
            node.GetSegmentation().AddSegment(segment)
            return [node]
        colorTableNode = None
        if properties.get("colorNodeID"):
            colorTableNode = scene.GetNodeByID(properties["colorNodeID"])
        node = logic.LoadSegmentationFromFile(fileName, bool(properties.get("autoOpacities", True)), name,
                                              colorTableNode, userMessages)
        return [node] if node else []

    def _readMarkupsFile(self, fileName, properties, userMessages):
        logic = self._logic("Markups")
        nodeIDs = logic.LoadMarkups(fileName, properties.get("name", ""), userMessages)
        if not nodeIDs:
            return []
        scene = self._scene()
        return [scene.GetNodeByID(i) for i in str(nodeIDs).split(",") if scene.GetNodeByID(i)]

    def _readTransformFile(self, fileName, properties, userMessages):
        logic = self._logic("Transforms")
        node = logic.AddTransform(fileName, self._scene(), userMessages)
        return [node] if node else []

    def _readColorTableFile(self, fileName, properties, userMessages):
        logic = self._logic("Colors")
        node = logic.LoadColorFile(fileName, None, userMessages)
        return [node] if node else []

    def _readTableFile(self, fileName, properties, userMessages):
        logic = self._logic("Tables")
        name = self._scene().GetUniqueNameByString(properties.get("name") or os.path.basename(fileName).rsplit(".", 1)[0])
        node = logic.AddTable(fileName, name, True, properties.get("password", ""), userMessages)
        return [node] if node else []

    def _readTextFile(self, fileName, properties, userMessages):
        import slicer

        scene = self._scene()
        name = properties.get("name") or os.path.basename(fileName)
        node = scene.AddNewNodeByClass("vtkMRMLTextNode", scene.GetUniqueNameByString(name))
        storage = scene.AddNewNodeByClass("vtkMRMLTextStorageNode")
        storage.SetFileName(fileName)
        node.SetAndObserveStorageNodeID(storage.GetID())
        if not storage.ReadData(node):
            scene.RemoveNode(node)
            scene.RemoveNode(storage)
            return []
        return [node]

    def _readSequenceFile(self, fileName, properties, userMessages):
        """A sequence, and the browser that plays it (as qSlicerSequencesReader does).

        A sequence on its own shows nothing: what is seen in the views is the proxy node that the
        browser keeps at the current item. So one is made for it, unless the caller asked for the
        sequence alone (show=False), and the proxy volume becomes the volume the slices show.
        """
        logic = self._logic("Sequences")
        node = logic.AddSequence(fileName, userMessages)
        if not node:
            return []
        if properties.get("name"):
            node.SetName(self._scene().GetUniqueNameByString(str(properties["name"])))
        if not properties.get("show", True):
            return [node]

        scene = self._scene()
        browser = scene.AddNewNodeByClass("vtkMRMLSequenceBrowserNode", node.GetName() + " browser")
        if browser is None:
            return [node]
        browser.SetAndObserveMasterSequenceNodeID(node.GetID())
        if logic is not None:
            logic.UpdateProxyNodesFromSequences(browser)
        proxy = browser.GetProxyNode(node)

        # What the proxy is decides what is shown: a volume becomes the one the slice views show.
        if proxy is not None and proxy.IsA("vtkMRMLVolumeNode"):
            appLogic = self._appLogic()
            selection = appLogic.GetSelectionNode() if appLogic else None
            if selection is not None:
                if proxy.IsA("vtkMRMLLabelMapVolumeNode"):
                    selection.SetActiveLabelVolumeID(proxy.GetID())
                else:
                    selection.SetActiveVolumeID(proxy.GetID())
                appLogic.PropagateVolumeSelection(1)
        return [node, browser] + ([proxy] if proxy is not None else [])

    def _readSceneFile(self, fileName, properties, userMessages):
        scene = self._scene()
        clear = bool(properties.get("clear", False))
        before = set(scene.GetNodes().GetItemAsObject(i).GetID() for i in range(scene.GetNumberOfNodes()))
        ext = _lower_ext(fileName)
        if ext in (".mrb", ".zip"):
            ok = scene.ReadFromMRB(fileName, clear, userMessages)
        else:
            scene.SetURL(fileName)
            ok = scene.Connect(userMessages) if clear else scene.Import(userMessages)
        if not ok:
            return []
        nodes = [scene.GetNodes().GetItemAsObject(i) for i in range(scene.GetNumberOfNodes())]
        loaded = [n for n in nodes if n and n.GetID() and n.GetID() not in before]
        from . import transforms_hdf5

        transforms_hdf5.read_scene_transforms(loaded)
        return loaded

    # ------------------------------------------------------------------ saving
    def writerForNode(self, node, fileName=None):
        """The writer that is to write this node, or None.

        A writer a module brought is asked how sure it is (it may look at what the node holds);
        one of the application answers by the node's class. The surest one wins, as
        qSlicerCoreIOManager does it. Where a file name is given, a writer whose extensions do not
        cover it is passed over.
        """
        from . import io_registry, io_scripted

        best, bestConfidence = None, 0.0
        for writer in io_registry.writers_for_node(node):
            confidence = (io_scripted.confidence_for_node(writer, node) if writer.GetOwner()
                          else writer.CanWriteObjectConfidence(node))
            if fileName and writer.GetExtensions() and not writer.MatchesExtension(str(fileName)):
                continue
            if confidence > bestConfidence:
                best, bestConfidence = writer, confidence
        return best

    def fileWriterFileType(self, node):
        writer = self.writerForNode(node)
        if writer is not None and writer.GetOwner():
            return writer.GetFileType()
        for fileType, cls in (("SegmentationFile", "vtkMRMLSegmentationNode"),
                              ("VolumeFile", "vtkMRMLVolumeNode"),
                              ("ModelFile", "vtkMRMLModelNode"),
                              ("MarkupsFile", "vtkMRMLMarkupsNode"),
                              ("TransformFile", "vtkMRMLTransformNode"),
                              ("ColorTableFile", "vtkMRMLColorTableNode"),
                              ("TableFile", "vtkMRMLTableNode"),
                              ("TextFile", "vtkMRMLTextNode"),
                              ("SequenceFile", "vtkMRMLSequenceNode")):
            if node.IsA(cls):
                return fileType
        return "NoFile"

    def fileWriterExtensions(self, node):
        storage = node.GetStorageNode() or node.CreateDefaultStorageNode()
        if storage is None:
            return []
        exts = []
        types = storage.GetSupportedWriteFileTypes()
        for i in range(types.GetNumberOfValues()):
            desc = types.GetValue(i)
            if "(" in desc:
                exts.append(desc[desc.rfind("(") + 1:desc.rfind(")")].replace("*", ""))
        return exts

    def extractKnownExtension(self, fileName, node):
        lower = fileName.lower()
        for ext in sorted(self.fileWriterExtensions(node), key=len, reverse=True):
            if ext and lower.endswith(ext.lower()):
                return ext
        return ""

    def saveNodes(self, fileType, properties, userMessages=None, hardenTransform=False):
        properties = dict(properties)
        fileName = str(properties.get("fileName", ""))
        if fileType == "SceneFile":
            return self._writeScene(fileName, properties, userMessages)
        node = self._scene().GetNodeByID(properties.get("nodeID", ""))
        if node is None:
            self._addMessage(userMessages, f"Node not found: {properties.get('nodeID')}")
            return False
        scripted = self._scriptedWriter(node, fileName, fileType)
        if scripted is not None:
            return self._writeWithScriptedWriter(scripted, node, properties, userMessages)
        return self._writeNode(node, fileName, properties, userMessages)

    def _scriptedWriter(self, node, fileName, fileType=None):
        """The writer a module registered for this node, where it is the one to use."""
        from . import io_scripted

        writer = self.writerForNode(node, fileName)
        if writer is None or not writer.GetOwner():
            return None
        if fileType and fileType not in ("NoFile", writer.GetFileType()):
            return None
        return writer if io_scripted.confidence_for_node(writer, node) > 0.0 else None

    def _writeWithScriptedWriter(self, writer, node, properties, userMessages):
        """Let a module's writer write the file."""
        from . import io_scripted

        properties = dict(properties)
        properties.setdefault("nodeID", node.GetID())
        try:
            io_scripted.write(writer, properties)
        except ModuleNotFoundError:
            raise
        except Exception as e:
            logger.exception("The writer of %s failed", writer.GetOwner())
            self._addMessage(userMessages, f"Failed to write {properties.get('fileName')}: {e}")
            return False
        if userMessages is not None:
            userMessages.AddMessages(writer.GetUserMessages())
        return True

    def exportNodes(self, nodeIDs, fileNames, properties, hardenTransform=False, userMessages=None):
        ok = True
        scene = self._scene()
        for nodeID, fileName in zip(nodeIDs, fileNames):
            node = scene.GetNodeByID(nodeID)
            if node is None:
                ok = False
                continue
            storage = node.CreateDefaultStorageNode()
            storage.SetFileName(str(fileName))
            if "useCompression" in properties:
                storage.SetUseCompression(bool(properties["useCompression"]))
            ok = bool(storage.WriteData(node)) and ok
        return ok

    def _writeNode(self, node, fileName, properties, userMessages):
        """Same as qSlicerNodeWriter::write."""
        if not node.AddDefaultStorageNode():
            self._addMessage(userMessages, f"Cannot create storage node for {node.GetName()}")
            return False
        storage = node.GetStorageNode()
        storage.SetFileName(fileName)
        if "useCompression" in properties:
            storage.SetUseCompression(bool(properties["useCompression"]))
        if "compressionParameter" in properties:
            storage.SetCompressionParameter(str(properties["compressionParameter"]))
        ok = bool(storage.WriteData(node))
        if ok:
            node.StorableModifiedTimeUpdate() if hasattr(node, "StorableModifiedTimeUpdate") else None
            host.emit("file-written", {"fileName": fileName, "nodeID": node.GetID()})
        else:
            self._addMessage(userMessages, f"Failed to write {node.GetName()} to {fileName}")
        return ok

    def _writeScene(self, fileName, properties, userMessages):
        scene = self._scene()
        ext = _lower_ext(fileName)
        if ext in (".mrb", ".zip"):
            ok = scene.WriteToMRB(fileName, None, userMessages)
        else:
            scene.SetURL(fileName)
            scene.SetRootDirectory(os.path.dirname(fileName))
            ok = scene.Commit(fileName)
        if ok:
            host.emit("file-written", {"fileName": fileName})
        return bool(ok)

    def setDefaultSceneFileType(self, fileType):
        self._defaultSceneFileType = fileType

    def defaultSceneFileType(self):
        return self._defaultSceneFileType

    # Dialogs are provided by the web page
    def openAddDataDialog(self):
        host.emit("open-dialog", {"dialog": "addData"})
        return True

    def openSaveDataDialog(self):
        host.emit("open-dialog", {"dialog": "saveData"})
        return True

    def openDialog(self, fileType, action, properties=None):
        host.emit("open-dialog", {"dialog": "file", "fileType": fileType, "action": str(action)})
        return True

    def __getattr__(self, name):
        if name.startswith("openAdd") and name.endswith("Dialog"):
            return self.openAddDataDialog
        raise AttributeError(name)

"""qSlicerCoreIOManager without Qt: the Python face of Slicer's file IO manager.

``slicer.util.loadVolume()``, ``loadModel()``, ``loadSegmentation()``, ``saveNode()``,
``saveScene()`` ... call ``slicer.app.coreIOManager()``. On the desktop that is
qSlicerCoreIOManager, which forwards the calls to vtkMRMLFileIOManager, the file IO manager of the
application logic (``slicer.app.applicationLogic().GetFileIOManager()``). This class does the same,
taking Python dictionaries as IO properties where the desktop takes a QVariantMap.

The readers and writers are those of Slicer core: each module logic registers its own when it is
set in the application logic, and the readers and writers of scripted modules are registered when
the module is loaded (:mod:`slicerweb.io_scripted`).

Files are read from the Emscripten virtual file system. The web page copies files selected or
dropped by the user (or downloaded from a URL) into ``/data`` and then calls :meth:`loadFiles`.
"""

import logging
import os

import vtk

from . import host, io_scripted

logger = logging.getLogger("slicerweb.io")


def _lower_ext(filename):
    name = os.path.basename(filename).lower()
    for compound in (".seg.nrrd", ".seg.nhdr", ".seg.vtm", ".seq.nrrd", ".seq.nhdr", ".seq.mrb", ".mrk.json",
                     ".nii.gz", ".img.gz", ".vtk.gz", ".tar.gz", ".mrml.gz"):
        if name.endswith(compound):
            return compound
    return os.path.splitext(name)[1]


def archiveHoldsScene(fileName):
    """Whether this zip is a scene saved as one file (a .mrb is one under another name).

    What makes it one is a scene file inside; an archive of a module's data has none.
    """
    import zipfile

    try:
        with zipfile.ZipFile(fileName) as archive:
            return any(name.lower().endswith(".mrml") for name in archive.namelist())
    except Exception:
        logger.debug("%s could not be read as an archive", fileName, exc_info=True)
        return False


def _properties(values):
    """IO properties (vtkMRMLIOProperties) from a Python dictionary, keeping the types of the values."""
    import slicer

    properties = slicer.vtkMRMLIOProperties()
    slicer.vtkSlicerScriptedFileReader.UpdatePropertiesFromDict(properties, dict(values or {}))
    return properties


def _dictionary(properties):
    import slicer

    return slicer.vtkSlicerScriptedFileReader.PropertiesToDict(properties)


class IOManager:
    def __init__(self, app):
        self._app = app
        manager = self.fileIOManager()
        manager.AddObserver(manager.NewFileLoadedEvent, self._onNewFileLoaded)
        manager.AddObserver(manager.FileSavedEvent, self._onFileSaved)

    def fileIOManager(self):
        """The file IO manager of the application logic (vtkMRMLFileIOManager)."""
        return self._app.applicationLogic().GetFileIOManager()

    def _scene(self):
        return self._app.mrmlScene()

    # ------------------------------------------------------------------ events
    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onNewFileLoaded(self, caller, event, properties):
        values = _dictionary(properties) if properties is not None else {}
        host.emit("nodes-loaded", {"fileName": values.get("fileName", ""), "nodeIDs": list(values.get("nodeIDs") or [])})

    @vtk.calldata_type(vtk.VTK_OBJECT)
    def _onFileSaved(self, caller, event, properties):
        values = _dictionary(properties) if properties is not None else {}
        written = {"fileName": values.get("fileName", "")}
        if values.get("nodeID"):
            written["nodeID"] = values["nodeID"]
        host.emit("file-written", written)

    # ------------------------------------------------------------------ file types
    def fileType(self, fileName):
        return self.fileIOManager().GetFileTypeForFile(str(fileName)) or "NoFile"

    def fileTypes(self, fileName):
        return list(self.fileIOManager().GetFileTypesForFile(str(fileName)))

    fileTypesFromFileName = fileTypes

    def fileTypeFromDescription(self, description):
        return self.fileIOManager().GetFileTypeFromDescription(str(description)) or "NoFile"

    def fileDescriptions(self, fileName):
        return list(self.fileIOManager().GetFileDescriptionsForFile(str(fileName)))

    def fileDescriptionsByType(self, fileType):
        return list(self.fileIOManager().GetFileDescriptionsByType(str(fileType)))

    def readerForFile(self, fileName):
        """The reader that is surest it can read this file (vtkMRMLFileReader), or None."""
        return self.fileIOManager().GetReaderForFile(str(fileName))

    def readers(self, fileType=None):
        manager = self.fileIOManager()
        if fileType is not None:
            return list(manager.GetReadersForFileType(str(fileType)))
        return [manager.GetNthReader(i) for i in range(manager.GetNumberOfReaders())]

    def writers(self, fileType=None):
        manager = self.fileIOManager()
        if fileType is not None:
            return list(manager.GetWritersForFileType(str(fileType)))
        return [manager.GetNthWriter(i) for i in range(manager.GetNumberOfWriters())]

    def registeredFileReaderCount(self, fileType):
        return len(self.fileIOManager().GetReadersForFileType(str(fileType)))

    def registeredFileWriterCount(self, fileType):
        return len(self.fileIOManager().GetWritersForFileType(str(fileType)))

    def readerFileTypes(self):
        return list(self.fileIOManager().GetReaderFileTypes())

    def fileExtensions(self, fileType):
        return list(self.fileIOManager().GetExtensionsForFileType(str(fileType), False))

    def allReadableFileExtensions(self):
        return list(self.fileIOManager().GetAllReadableFileExtensions())

    def allWritableFileExtensions(self):
        return list(self.fileIOManager().GetAllWritableFileExtensions())

    # ------------------------------------------------------------------ loading
    def loadNodes(self, fileType, properties, loadedNodes=None, userMessages=None):
        """qSlicerCoreIOManager::loadNodes. Returns True on success.

        Raises ModuleNotFoundError where a reader needs a package that is not installed yet: the
        page installs it and calls this again (see slicerweb.packages).
        """
        if not isinstance(fileType, str):
            # loadNodes(filesProperties, loadedNodes, userMessages): a list of properties, each with its "fileType"
            return self._loadNodesFromList(fileType, properties, loadedNodes)
        properties = dict(properties)
        fileName = properties.get("fileName", "")
        fileNames = fileName if isinstance(fileName, (list, tuple)) else [fileName]
        missing = [str(f) for f in fileNames if not f or not os.path.exists(str(f))]
        if missing:
            self._addMessage(userMessages, f"File not found: {', '.join(missing) or fileName}")
            return False
        if fileType == "SceneFile" and isinstance(fileName, str):
            return self._loadScene(properties, loadedNodes, userMessages)
        io_scripted.clear_missing_module()
        success = self.fileIOManager().LoadNodes(fileType, _properties(properties), loadedNodes, userMessages)
        io_scripted.raise_missing_module()
        return success

    def _loadNodesFromList(self, filesProperties, loadedNodes, userMessages):
        success = True
        for fileProperties in filesProperties:
            fileProperties = dict(fileProperties)
            fileType = fileProperties.pop("fileType", None) or self.fileType(fileProperties.get("fileName", ""))
            success = self.loadNodes(fileType, fileProperties, loadedNodes, userMessages) and success
        return success

    def _loadScene(self, properties, loadedNodes, userMessages):
        """Load a scene. A zip that holds no scene is unpacked, and transforms kept in HDF5 files are read."""
        fileName = str(properties["fileName"])
        if _lower_ext(fileName) == ".zip" and not archiveHoldsScene(fileName):
            self._unpackArchive(fileName, userMessages)
            return True
        nodes = vtk.vtkCollection()
        io_scripted.clear_missing_module()
        success = self.fileIOManager().LoadNodes("SceneFile", _properties(properties), nodes, userMessages)
        io_scripted.raise_missing_module()
        loaded = [nodes.GetItemAsObject(i) for i in range(nodes.GetNumberOfItems())]
        from . import transforms_hdf5

        transforms_hdf5.read_scene_transforms(loaded)
        if loadedNodes is not None:
            for node in loaded:
                loadedNodes.AddItem(node)
        return success

    def loadNodesAndGetFirst(self, fileType, properties, userMessages=None):
        nodes = vtk.vtkCollection()
        self.loadNodes(fileType, properties, nodes, userMessages)
        return nodes.GetItemAsObject(0) if nodes.GetNumberOfItems() else None

    def loadScene(self, fileName, clear=True, userMessages=None):
        return self.loadNodes("SceneFile", {"fileName": str(fileName), "clear": bool(clear)}, None, userMessages)

    def loadFile(self, fileName, userMessages=None):
        return self.loadNodes(self.fileType(fileName), {"fileName": str(fileName)}, None, userMessages)

    def loadFiles(self, fileNames, properties=None):
        """Load files selected in the web page (fileType is determined from the extension).

        DICOM files (.dcm) given together are loaded as one series. Returns loaded node IDs.
        """
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

    @staticmethod
    def _addMessage(userMessages, text, error=True):
        logger.error(text) if error else logger.warning(text)
        if userMessages is not None:
            userMessages.AddMessage(vtk.vtkCommand.ErrorEvent if error else vtk.vtkCommand.WarningEvent, text)

    def _unpackArchive(self, fileName, userMessages):
        """Unpack an archive that holds no scene, and say where its files went.

        A zip is usually a scene saved as one file, but not always: a module's sample data set can
        be a zip of files the module reads itself - tables of measurements, for instance. There is
        nothing in such an archive to put in a scene, so unpacking it and saying where is all that
        can be done, which is what desktop Slicer does with one as well.
        """
        import zipfile

        directory = os.path.splitext(fileName)[0]
        os.makedirs(directory, exist_ok=True)
        with zipfile.ZipFile(fileName) as archive:
            names = [n for n in archive.namelist() if not n.endswith("/")]
            archive.extractall(directory)
        message = (f"{os.path.basename(fileName)} holds no scene. Its {len(names)} file"
                   f"{'' if len(names) == 1 else 's'} went into {directory}, for whatever reads them.")
        logger.info(message)
        self._addMessage(userMessages, message)
        return directory

    # ------------------------------------------------------------------ saving
    def writerForNode(self, node, fileName=None):
        """The writer that is to write this node (vtkMRMLFileWriter), or None.

        Where a file name is given, the writer is the surest one among those whose name filters
        cover it.
        """
        manager = self.fileIOManager()
        if fileName:
            for writer in manager.GetWritersForObject(node):
                if writer.MatchesExtension(str(fileName)):
                    return writer
        return manager.GetWriterForObject(node)

    def writer(self, obj, extension=""):
        return self.fileIOManager().GetWriterForObject(obj, str(extension or ""))

    def fileWriterFileType(self, obj, extension=""):
        return self.fileIOManager().GetFileWriterFileType(obj, str(extension or "")) or "NoFile"

    def fileWriterDescriptions(self, fileType):
        return list(self.fileIOManager().GetFileWriterDescriptions(str(fileType)))

    def fileWriterExtensions(self, obj):
        return list(self.fileIOManager().GetFileWriterExtensions(obj))

    def extractKnownExtension(self, fileName, obj):
        return self.fileIOManager().ExtractKnownExtension(str(fileName), obj)

    def stripKnownExtension(self, fileName, obj):
        return self.fileIOManager().StripKnownExtension(str(fileName), obj)

    def completeSlicerWritableFileNameSuffix(self, node):
        return self.fileIOManager().GetCompleteSlicerWritableFileNameSuffix(node)

    def forceFileNameValidCharacters(self, fileName):
        import slicer

        return slicer.vtkMRMLFileIOManager.ForceFileNameValidCharacters(str(fileName))

    def forceFileNameMaxLength(self, fileName, extensionLength, maxLength=-1):
        return self.fileIOManager().ForceFileNameMaxLength(str(fileName), int(extensionLength), int(maxLength))

    def saveNodes(self, fileType, properties, userMessages=None, scene=None):
        """qSlicerCoreIOManager::saveNodes. Returns True on success."""
        properties = dict(properties)
        fileName = str(properties.get("fileName", ""))
        if fileType == "SceneFile" and _lower_ext(fileName) == ".zip":
            # A scene saved as .zip is a bundle, as a .mrb is (the scene writer takes it for a directory)
            return self._writeBundle(fileName, properties, userMessages)
        io_scripted.clear_missing_module()
        success = self.fileIOManager().SaveNodes(fileType, _properties(properties), userMessages, scene)
        io_scripted.raise_missing_module()
        return success

    def _writeBundle(self, fileName, properties, userMessages):
        scene = self._scene()
        success = bool(scene.WriteToMRB(fileName, properties.get("screenShot"), userMessages))
        if success:
            scene.SetStorableNodesModifiedSinceRead()
            self.fileIOManager().InvokeFileSavedEvent(_properties(properties))
        return success

    def saveScene(self, fileName, screenShot=None, userMessages=None):
        properties = {"fileName": str(fileName)}
        if screenShot is not None:
            properties["screenShot"] = screenShot
        return self.saveNodes("SceneFile", properties, userMessages)

    def exportNodes(self, nodeIDs, fileNames=None, properties=None, hardenTransform=False, userMessages=None):
        """qSlicerCoreIOManager::exportNodes: (nodeIDs, fileNames, properties, hardenTransforms, userMessages)
        or (propertiesList, hardenTransforms, userMessages)."""
        manager = self.fileIOManager()
        io_scripted.clear_missing_module()
        if fileNames is None or isinstance(fileNames, bool):
            propertiesList = vtk.vtkCollection()
            for itemProperties in nodeIDs:
                propertiesList.AddItem(_properties(itemProperties))
            hardenTransform = bool(fileNames)
            if isinstance(properties, bool):
                hardenTransform = properties
            success = manager.ExportNodes(propertiesList, hardenTransform, userMessages)
        else:
            success = manager.ExportNodes([str(i) for i in nodeIDs], [str(f) for f in fileNames],
                                          _properties(properties), bool(hardenTransform), userMessages)
        io_scripted.raise_missing_module()
        return success

    def addDefaultStorageNodes(self):
        self.fileIOManager().AddDefaultStorageNodes()

    def setDefaultSceneFileType(self, fileType):
        self.fileIOManager().SetDefaultSceneFileType(str(fileType))

    def defaultSceneFileType(self):
        return self.fileIOManager().GetDefaultSceneFileType()

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

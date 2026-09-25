"""slicer.app.extensionsManagerModel(): the extensions a module can ask for, as on the desktop.

Modules check whether an extension is installed and install one they need
(qSlicerExtensionsManagerModel::installExtensionFromServer). Here the extensions are those of
SlicerWeb's extension index - the ones the Extensions Manager offers - and installing one installs
its wheel, with what it depends on, as the Extensions Manager does, then loads its modules; the
page has no restart to wait for. An extension that the index does not have cannot be installed:
it is reported as such (a desktop extension with no SlicerWeb build, say), and the module is told.
"""

import json
import logging

from . import host

logger = logging.getLogger("slicerweb.extensions")


class qSlicerExtensionsManagerModel:
    """The subset of qSlicerExtensionsManagerModel that modules use."""

    def __init__(self):
        #: whether to ask the user (on the desktop: confirmation popups); nothing is asked here
        self.interactive = False

    def _state(self):
        try:
            return json.loads(host.call("extensionState") or "{}")
        except (TypeError, ValueError):
            return {}

    def _names(self, key):
        return [str(name) for name in self._state().get(key, [])]

    # --- what is there
    def installedExtensions(self):
        return self._names("installed")

    def enabledExtensions(self):
        return self._names("installed")

    def availableExtensions(self):
        """The extensions SlicerWeb's extension index offers (not a desktop Slicer method)."""
        return self._names("available")

    def isExtensionInstalled(self, extensionName):
        return any(name.lower() == str(extensionName).lower() for name in self.installedExtensions())

    def isExtensionEnabled(self, extensionName):
        return self.isExtensionInstalled(extensionName)

    @property
    def numberOfInstalledExtensions(self):
        return len(self.installedExtensions())

    def updateExtensionsMetadataFromServer(self, force=False, waitForCompletion=False):
        return True

    # --- installing
    def installExtensionFromServer(self, extensionName, restart=True, update=False):
        """Install an extension of SlicerWeb's index; True if it is (or is being) installed.

        Where the code may be suspended (see yielding.py) the installation is waited for and its
        result returned; elsewhere it goes on in the page, and its modules appear once loaded
        (on the desktop the application restarts for them). *restart* and *update* change nothing.
        """
        name = str(extensionName)
        if self.isExtensionInstalled(name):
            return True
        state = self._state()
        if not state.get("indexLoaded"):
            logger.warning("Cannot install the %s extension: the extension index is not loaded yet", name)
            return False
        if not any(n.lower() == name.lower() for n in state.get("available", [])):
            logger.warning("The %s extension is not available in SlicerWeb (it is not in its extension index), "
                           "so it cannot be installed: features that need it will not work here", name)
            return False
        from . import yielding

        promise = host.call("installExtension", name)
        if promise is None:
            return False
        if yielding.can_yield():
            from pyodide.ffi import run_sync

            try:
                return bool(run_sync(promise))
            except Exception:
                logger.exception("Installing the %s extension failed", name)
                return False
        logger.info("Installing the %s extension: its modules appear once it is loaded", name)
        return True

    def downloadAndInstallExtensionByName(self, extensionName, installDependencies=True, waitForCompletion=False):
        return self.installExtensionFromServer(extensionName)


_model = None


def model():
    global _model
    if _model is None:
        _model = qSlicerExtensionsManagerModel()
    return _model

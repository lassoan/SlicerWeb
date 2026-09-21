"""Python package installation in the browser.

Desktop Slicer modules install Python packages with slicer.util.pip_install (``pip install``). In the
browser, packages come from the Pyodide distribution or PyPI (micropip), which can only be installed
asynchronously by the web page. pip_install therefore raises ModuleNotFoundError for the first missing
package: the page (SlicerBridge) installs the package and runs the operation again.
"""

import importlib.util
import re


def _requirement_names(requirements):
    if isinstance(requirements, str):
        requirements = requirements.split()
    names = []
    for r in requirements:
        r = r.strip()
        if not r or r.startswith("-"):
            continue
        names.append(re.split(r"[<>=!~\[;@ ]", r, maxsplit=1)[0])
    return names


def pip_install(requirements, *args, **kwargs):
    """slicer.util.pip_install / slicer.packaging.pip_install replacement."""
    names = _requirement_names(requirements)
    for name in names:
        module = name.replace("-", "_").lower()
        if importlib.util.find_spec(module) is None:
            raise ModuleNotFoundError(f"No module named '{name}'", name=name)
    completed = kwargs.get("completedCallback")
    if completed:
        completed(0)
    return None


#: Packages the page has already been asked for, so that it is asked once.
_requested = set()


def ensure_in_background(name):
    """Ask the page to install a package that will be wanted shortly.

    Installing is the page's to do and takes as long as a download; this does not wait for it. It
    is for a package that is not needed yet but is about to be - h5py when a transform turns up in
    the scene, which may be saved as .h5 - so that the call that needs it finds it there. A call
    that finds it missing anyway raises ModuleNotFoundError, which the page answers by installing
    the package and running the call again.
    """
    module = name.replace("-", "_").lower()
    if name in _requested or importlib.util.find_spec(module) is not None:
        return False
    _requested.add(name)
    try:
        import slicerweb_host

        slicerweb_host.installPackage(name)
    except Exception:
        return False
    return True


def install():
    import slicer
    import slicer.util

    slicer.util.pip_install = pip_install
    try:
        import slicer.packaging

        slicer.packaging.pip_install = pip_install
    except ImportError:
        pass

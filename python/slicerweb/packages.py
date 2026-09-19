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


def install():
    import slicer
    import slicer.util

    slicer.util.pip_install = pip_install
    try:
        import slicer.packaging

        slicer.packaging.pip_install = pip_install
    except ImportError:
        pass

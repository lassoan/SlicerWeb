"""Locations of the native libraries and resources shipped in the SlicerWeb wheels."""

import glob
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))


def slicer_home():
    """Directory that contains lib/Slicer-X.Y and share/Slicer-X.Y."""
    candidates = [
        os.environ.get("SLICER_HOME", ""),
        os.path.join(os.path.dirname(_here), "slicer_home"),
        "/opt/slicer",
    ]
    for c in candidates:
        if c and os.path.isdir(os.path.join(c, "lib")):
            return c
    return candidates[1]


def _version_dir(kind):
    home = slicer_home()
    dirs = sorted(glob.glob(os.path.join(home, kind, "Slicer-*")))
    return dirs[-1] if dirs else None


def slicer_version():
    d = _version_dir("lib") or _version_dir("share")
    return os.path.basename(d).split("-", 1)[1] if d else "5.13"


def slicer_version_full():
    try:
        from slicerweb_build_info import SLICER_VERSION_FULL  # written by scripts/make_wheels.py

        return SLICER_VERSION_FULL
    except ImportError:
        return slicer_version() + ".0"


def slicer_lib_dir():
    return _version_dir("lib")


def loadable_modules_lib_dir():
    d = slicer_lib_dir()
    return os.path.join(d, "qt-loadable-modules") if d else None


def scripted_modules_lib_dir():
    d = slicer_lib_dir()
    return os.path.join(d, "qt-scripted-modules") if d else None


def library_dirs():
    dirs = []
    for d in (slicer_lib_dir(), loadable_modules_lib_dir()):
        if d and os.path.isdir(d):
            dirs.append(d)
    return dirs


def ensure_library_path(extra_dirs=()):
    """Make Slicer's native libraries and Python extension modules loadable.

    When installed from wheels, Pyodide already loaded all shared libraries of the wheels.
    During development (install trees mounted in the virtual file system) the dynamic loader
    needs LD_LIBRARY_PATH, and the extension modules need to be on sys.path.
    """
    dirs = library_dirs() + [d for d in extra_dirs if os.path.isdir(d)]
    current = os.environ.get("LD_LIBRARY_PATH", "")
    missing = [d for d in dirs if d not in current.split(":")]
    if missing:
        os.environ["LD_LIBRARY_PATH"] = ":".join(missing + ([current] if current else []))
    for d in dirs:
        if d not in sys.path:
            sys.path.append(d)

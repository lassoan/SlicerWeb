"""Rebuild only the pure-Python slicerweb wheel (fast iteration on the Python runtime).

Usage: python scripts/make_python_wheel.py [wheels dir]
"""
import datetime
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import make_wheels  # noqa: E402

out = sys.argv[1] if len(sys.argv) > 1 else "D:/SlicerWeb-build/dist/wheels"
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for old in glob.glob(os.path.join(out, "slicerweb-0*.whl")):
    os.remove(old)
w = make_wheels.Wheel("slicerweb", "0.1.0", pure=True, summary="3D Slicer application services for the web browser")
w.add_tree(os.path.join(root, "python"), "", exclude=lambda rel: rel.endswith(".pyc") or rel.startswith("tests"))
# When this was built: the wheel keeps its name from build to build, so this is what tells which
# Python code a page is actually running (it is logged at startup and shown in the Python console).
stamp = datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
w.add_bytes("BUILD_TIME = " + repr(stamp) + chr(10), "slicerweb/_build.py")
w.write(out)

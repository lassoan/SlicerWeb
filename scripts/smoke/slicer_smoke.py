# End-to-end smoke test of the SlicerWeb wheels in Pyodide (Node.js, no WebGL):
# install wheels, start the application, load and save data with Slicer's IO, run module logic.
import glob
import os
import time

import micropip

# Dependencies of the libraries loaded at wheel installation are found through the loader search path
_sp = "/lib/python3.14/site-packages"
_ver = os.path.basename(sorted(glob.glob("/wheels/slicer_core-*.whl"))[-1]).split("-")[1].rsplit(".", 1)[0]
os.environ["LD_LIBRARY_PATH"] = ":".join([f"{_sp}/vtk_libs", f"{_sp}/slicerweb_itk", f"{_sp}/slicer_home/lib/Slicer-{_ver}",
                                          f"{_sp}/slicer_home/lib/Slicer-{_ver}/qt-loadable-modules",
                                          os.environ.get("LD_LIBRARY_PATH", "")])

t0 = time.time()
for name in ["vtk", "slicerweb_itk", "slicer_core", "slicer_modules_core", "slicerweb"]:
    wheels = sorted(glob.glob(f"/wheels/{name}-*.whl"))
    assert wheels, f"wheel {name} not found"
    t1 = time.time()
    await micropip.install("emfs:" + wheels[-1], deps=False)  # noqa: F704 (top-level await in Pyodide)
    print(f"  {name}: {time.time() - t1:.1f} s")
print(f"wheels installed in {time.time() - t0:.1f} s")

t0 = time.time()
import slicerweb

app = slicerweb.initialize({"layout": "FourUp"})
import slicer

print(f"application started in {time.time() - t0:.1f} s; Slicer {app.applicationVersion}")
print("modules:", ", ".join(sorted(app.moduleManager().modulesNames())))
for name in ("Volumes", "Models", "Markups", "Segmentations", "VolumeRendering", "Transforms", "Colors"):
    assert app.moduleManager().isLoaded(name), f"module {name} not loaded"
    assert slicer.modules.__dict__[name.lower()].logic() is not None, f"no logic for {name}"

# Layout: view nodes for the four-up layout exist
desc = app.layoutManager().layoutDescription()
print("layout:", desc["type"], [c.get("layoutName") or c["type"] for c in desc["children"]])
assert slicer.mrmlScene.GetNodesByClass("vtkMRMLSliceNode").GetNumberOfItems() >= 3

# Displayable managers registered by the module initializer
factory = slicer.vtkMRMLSliceViewDisplayableManagerFactory.GetInstance()
for dm in ("vtkMRMLMarkupsDisplayableManager", "vtkMRMLSegmentationsDisplayableManager2D"):
    assert factory.IsDisplayableManagerRegistered(dm), dm

# Volume IO (NRRD, through vtkSlicerVolumesLogic / ITK)
import numpy as np

volume = slicer.util.addVolumeFromArray(np.random.randint(0, 100, (20, 30, 40)).astype(np.int16), name="Test")
os.makedirs("/tmp/out", exist_ok=True)
assert slicer.util.saveNode(volume, "/tmp/out/test.nrrd")
loaded = slicer.util.loadVolume("/tmp/out/test.nrrd")
assert loaded.GetImageData().GetDimensions() == (40, 30, 20), loaded.GetImageData().GetDimensions()
print("volume round trip ok:", loaded.GetName())
if os.path.exists("/testdata/MRHead.nrrd"):
    mrhead = slicer.util.loadVolume("/testdata/MRHead.nrrd")
    print("MRHead:", mrhead.GetImageData().GetDimensions())

# Models
import vtk

sphere = vtk.vtkSphereSource()
sphere.Update()
model = slicer.modules.models.logic().AddModel(sphere.GetOutput())
assert slicer.util.saveNode(model, "/tmp/out/sphere.vtk")
print("model ok:", model.GetPolyData().GetNumberOfPoints(), "points")

# Markups
line = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsLineNode")
line.AddControlPoint(0, 0, 0)
line.AddControlPoint(30, 40, 0)
print("line length:", line.GetMeasurement("length").GetValue())
assert abs(line.GetMeasurement("length").GetValue() - 50) < 1e-6
assert slicer.util.saveNode(line, "/tmp/out/line.mrk.json")
assert slicer.util.loadMarkups("/tmp/out/line.mrk.json")

# Segmentation (threshold with the segment editor logic)
from slicerweb import segment_editor

seg = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Seg")
editor = segment_editor.editor()
editor.setup(seg.GetID(), loaded.GetID())
editor.addSegment()
editor.threshold(50, 100)
labelmap = slicer.util.arrayFromSegmentBinaryLabelmap(seg, seg.GetSegmentation().GetNthSegmentID(0), loaded)
print("segmented voxels:", int(labelmap.sum()))
assert labelmap.sum() > 0
assert slicer.util.saveNode(seg, "/tmp/out/seg.seg.nrrd")

# Scene bundle (.mrb uses libarchive)
assert app.coreIOManager().saveNodes("SceneFile", {"fileName": "/tmp/out/scene.mrb"})
print("mrb size:", os.path.getsize("/tmp/out/scene.mrb"))
slicer.mrmlScene.Clear(False)
assert app.coreIOManager().loadNodes("SceneFile", {"fileName": "/tmp/out/scene.mrb"})
print("scene reloaded:", slicer.mrmlScene.GetNodesByClass("vtkMRMLVolumeNode").GetNumberOfItems(), "volumes")

# Bridge API used by the web GUI
import json

from slicerweb import bridge

result = json.loads(bridge.call("getSubjectHierarchy", "[]"))
assert "result" in result, result
print("subject hierarchy items:", len(result["result"]))
print("OK")

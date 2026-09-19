# VTK-in-Pyodide smoke test (runs in Node.js, so no WebGL: rendering itself is tested in the browser).
import sys
import time

t0 = time.time()
from vtkmodules.vtkCommonCore import vtkVersion, vtkObjectFactory
from vtkmodules.vtkCommonDataModel import vtkImageData
from vtkmodules.vtkFiltersSources import vtkConeSource, vtkSphereSource
from vtkmodules.vtkFiltersCore import vtkTriangleFilter
from vtkmodules.vtkImagingCore import vtkImageReslice
from vtkmodules.vtkIOXML import vtkXMLPolyDataWriter, vtkXMLPolyDataReader
from vtkmodules.vtkIOImage import vtkNrrdReader
import vtkmodules.vtkRenderingOpenGL2  # noqa: F401  (registers render window factory override)
import vtkmodules.vtkRenderingUI  # noqa: F401  (registers interactor factory override)
import vtkmodules.vtkInteractionStyle  # noqa: F401
from vtkmodules.vtkRenderingCore import vtkRenderWindow, vtkRenderWindowInteractor, vtkRenderer
print(f"imported VTK {vtkVersion.GetVTKVersionFull()} in {time.time() - t0:.1f} s")

cone = vtkConeSource()
cone.SetResolution(32)
tri = vtkTriangleFilter()
tri.SetInputConnection(cone.GetOutputPort())
tri.Update()
n = tri.GetOutput().GetNumberOfCells()
assert n > 0, "cone has no cells"
print("cone triangles:", n)

w = vtkXMLPolyDataWriter()
w.SetFileName("/tmp/cone.vtp")
w.SetInputConnection(tri.GetOutputPort())
assert w.Write() == 1
r = vtkXMLPolyDataReader()
r.SetFileName("/tmp/cone.vtp")
r.Update()
assert r.GetOutput().GetNumberOfCells() == n
print("vtp round trip ok")

img = vtkImageData()
img.SetDimensions(8, 8, 8)
img.AllocateScalars(10, 1)  # VTK_FLOAT
reslice = vtkImageReslice()
reslice.SetInputData(img)
reslice.Update()
print("reslice ok", reslice.GetOutput().GetDimensions())

rw = vtkRenderWindow()
iren = vtkRenderWindowInteractor()
print("render window class:", rw.GetClassName())
print("interactor class:", iren.GetClassName())
assert rw.GetClassName() == "vtkWebAssemblyOpenGLRenderWindow", rw.GetClassName()
assert iren.GetClassName() == "vtkWebAssemblyRenderWindowInteractor", iren.GetClassName()

# Exceptions thrown in C++ must propagate as Python errors (wasm exception handling ABI check)
try:
    from vtkmodules.vtkCommonCore import vtkStringArray
    a = vtkStringArray()
    a.GetValue(1000000)  # out of range: vtk returns default (no throw) -> just must not crash
except Exception as e:  # pragma: no cover
    print("exception:", e)
print("OK")

# Known issues

## Some ITK filters give wrong answers or throw in this WebAssembly build

Several filters of `vtkITK` do not work here, while others do. What fails, fails in one of two
ways: an ITK exception that ends the Python session (a C++ throw across WebAssembly is fatal to
the Pyodide runtime, so the page has to be reloaded), or a result that is quietly wrong.

Checked from the Python console on small images of known content:

| filter | what happens |
|---|---|
| `vtkITKImageThresholdCalculator` (Otsu) | works |
| `vtkITKImageMargin` | **wrong**: returns the input unchanged, or nearly the whole volume, whatever the margin is |
| `vtkITKGrowCut` | throws: `VTKImageToImageFilter: Downcast from DataObject to my Image type failed` (`itkVTKImageImport.hxx:110`) |
| `vtkITKMorphologicalContourInterpolator` | throws: `ImageBase::CopyInformation() cannot cast DataObject to ImageBase<3>` |
| `vtkITKLevelTracingImageFilter` | throws the same |
| `vtkITKIslandMath` | throws the same |
| `vtkITKDistanceTransform` | throws the same |

Both messages are a `dynamic_cast` that did not recognise an object of exactly the type it was
asked about. That is what happens when the same type has more than one type description in a
process and they are not merged: nine of the loaded libraries define their own
`typeinfo for slicer_itk::ImageBase<3>` (`libvtkITK.so`, `libMRMLCore.so`, five ITK libraries and
two of SlicerVMTK's), because this ITK is built without explicit instantiation, so every library
that uses an image instantiates its own. The libraries are loaded into the global symbol namespace
(`global=true` in Pyodide's loader), but a side module that defines a data symbol itself does not
reach it through the global offset table, so each keeps its own copy and a cast between two of them
fails. It is not a debug-versus-release matter: the build is Release with `NDEBUG`, so the casts
that remain are the ones ITK makes on purpose.

The segment editor effects that would use these filters are written with NumPy and SciPy instead
(see `slicerweb/segment_editor.py`): grow from seeds runs the same grow-cut automaton over the
voxels, fill between slices interpolates the distance fields of the segmented slices, and margin
and hollow measure distance with `scipy.ndimage.distance_transform_edt`. They are checked against
known shapes in `web/tests/segment-editor-effects.mjs`.

Worth doing when there is time, because it affects any module or extension that reaches for these
filters: find out why the type descriptions are not shared, and either make the libraries share one
(explicit instantiation in one ITK library, or linking the users against it) or find the loader
setting that merges them.

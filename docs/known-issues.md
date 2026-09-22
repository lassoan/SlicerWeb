# Known issues

## ITK filters that failed because their types were described twice (fixed)

Several filters of `vtkITK` used to fail here, in one of two ways: an ITK exception that ended the
Python session (a C++ throw across WebAssembly is fatal to the Pyodide runtime, so the page had to
be reloaded), or a result that was quietly wrong.

| filter | before | now |
|---|---|---|
| `vtkITKImageThresholdCalculator` (Otsu) | worked | works |
| `vtkITKImageMargin` | returned the input unchanged, or nearly the whole volume | grows a 64-voxel cube to 312 |
| `vtkITKGrowCut` | threw `Downcast from DataObject to my Image type failed` | grows both seeds |
| `vtkITKMorphologicalContourInterpolator` | threw `ImageBase::CopyInformation() cannot cast DataObject to ImageBase<2>` | fills between slices |
| `vtkITKIslandMath` | threw the same | counts islands |
| `vtkITKDistanceTransform` | threw the same | measures distance |
| `vtkITKLevelTracingImageFilter` | threw the same | no longer throws, but traces nothing (see below) |

### What was wrong

ITK's classes are templates whose code is in the headers, so every library that uses them compiles
its own copy of each one it touches, and each copy brings its own description of the type - the
thing `dynamic_cast` compares. Nine of the loaded libraries had their own
`typeinfo for slicer_itk::ImageBase<3>`.

Duplicate descriptions are not a problem by themselves: the loader shares one copy of each symbol
between libraries, and a small test of two side modules doing exactly this passes. The problem is
that the sharing is settled name by name, while a description's pointer to the base it derives from
is fixed when its own library is linked. So code reaches a description through the table the loader
fills in, but that description can point at a base description in the library it was compiled into.
Measured from one library:

    ImageBase<2> as this library's code uses it: 0x28224d4
    Image<unsigned char,2> says its base is     0x28224d4   the same
    Image<float,2>         says its base is     0x28224d4   the same
    Image<bool,2>          says its base is     0x2324018   a different one
    Image<unsigned short,2> says its base is    0x2324018   a different one

`dynamic_cast` compares descriptions by address - the names carry no mark that would make the
runtime compare them as text - so a cast of an `Image<bool,2>` to `ImageBase<2>` failed. Which
types came out wrong depended on which library each description was taken from, which is why some
filters worked and others did not. The interpolator slices images into `Image<bool,2>`, which is
why it was one of the ones that failed.

### What was done

The libraries whose ITK use is entirely their own - `vtkITK` and `SlicerWebCore` - compile the ITK
templates hidden, with `ITK_TEMPLATE_EXPORT` defined as a hidden visibility attribute (see the
comment in the top-level `CMakeLists.txt`). Each library's copies are then its own, and every
description it casts against agrees with the others it holds. ITK's plain classes (`DataObject`,
`ProcessObject`, the IO factories) are not templates and stay shared, one copy for everyone.

`MRMLCore` is deliberately left as it was: it reads transforms, and the transform objects are made
by ITK's factory in another library, so its casts are between descriptions that do have to be
shared. The same care applies to any library that passes ITK objects to another one.

Covered by `web/tests/itk-filters.mjs`, which runs each filter on an input whose answer is known.

### Still open

- `vtkITKLevelTracingImageFilter` no longer throws but returns an empty contour, for every plane
  and seed tried, with the same calls that Slicer's Level Tracing effect makes. Nothing uses it yet.
- The extension libraries (SlicerVMTK's `vtkvmtkITK` and `vtkvmtkSegmentation`) also compile ITK
  templates of their own and have not been given the same treatment; if a filter of theirs fails
  the same way, that is where to look.
- The segment editor's grow from seeds, fill between slices, margin and hollow are written with
  NumPy and SciPy, from when these filters could not be used. They work and are tested, but the
  ITK filters are what desktop Slicer uses and are faster; switching back is worth doing.

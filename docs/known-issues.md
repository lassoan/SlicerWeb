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

## 16 bit volumes did not reach the graphics card (fixed)

Volume rendering showed a solid block the size of the volume, whatever the preset. The console
said why: `glTexImage3D: Invalid combination of format, type and internalFormat`. WebGL 2 has no
normalized 16 bit texture format, so VTK's table leaves `GL_R16` and `GL_R16_SNORM` out and offers
the float format instead - but `GetDefaultDataType` still said `GL_SHORT` for a texture whose
internal format had become `GL_R32F`, which OpenGL refuses, and unsigned short had no float format
at all. The volume texture was never uploaded, and what was drawn was an empty box.

`patches/VTK/0007-BUG-Upload-16-bit-textures-as-float-on-OpenGL-ES.patch` uploads 16 bit data as
float where that is the format in use, divided the way a normalized 16 bit texture divides it so
that shaders read the same values, and gives unsigned short the float internal format as well.
Current VTK master fixes this the same way; the pin here is older than that work. Covered by
`web/tests/volume-rendering.mjs`, which reads the pixels of the 3D view.

## A coarsely rendered volume kept the first picture (fixed)

With adaptive quality the volume mapper renders into a smaller buffer while the camera moves and
stretches the result over the view. Here that buffer was filled once and never again: the volume
stopped turning with the camera as soon as a drag started, while everything else in the view - the
bounding box, the orientation marker - kept turning, and the full detail render at the end of the
drag showed the right orientation.

`vtkOpenGLState` caches the draw buffer for each binding point rather than for each framebuffer, and
keeps that cache honest by re-reading it from OpenGL whenever a framebuffer is bound. The read asks
for `GL_DRAW_BUFFER`, which only desktop OpenGL has, so under OpenGL ES nothing was read and the
cache still held the previously bound framebuffer's value. `vtkOpenGLFramebufferObject` leaves every
framebuffer it has used with `glDrawBuffers(GL_NONE)`, so from the second frame on the reduced
buffer was switched off, and the clear and the ray cast that followed were both discarded - with no
GL error, since a framebuffer with no draw buffer is perfectly legal. The texture kept the one
picture that had been drawn into it when it was new.

`patches/VTK/0008-BUG-Refresh-the-cached-draw-buffer-when-a-framebuffe.patch` reads
`GL_DRAW_BUFFER0` where `GL_DRAW_BUFFER` is not defined. Anything that renders to a framebuffer
twice is affected, not just volume rendering.

The same report also had the volume disappear when cropping was switched on, which was a second
instance of the int-literal comparison in `patches/VTK/0003-...`: the clipping code in the gradient
shader compares a `dot` product with `0`, and GLSL ES will not compile that. That patch now also
covers the independent-component and label-map paths. Both are covered by
`web/tests/volume-rendering.mjs`.

## Still open

- Most CLI modules are not here. A CLI module is a separate program, which a web page cannot start,
  so each one offered is a Python implementation described by the XML of the real module
  (`python/slicerweb/cli_modules.py`); the others are described but refuse to run, naming
  themselves. What is implemented: Threshold Scalar Volume, Add/Subtract/Multiply Scalar Volumes,
  Cast Scalar Volume, Mask Scalar Volume, Gaussian Blur, Median Image Filter, Resample Scalar
  Volume, Merge Models, Grayscale Model Maker, and Decimation for the VMTK modules. The ones that
  would need ITK registration or bias field correction (BRAINSFit, N4ITK, Extract Skeleton,
  Fiducial Registration) are not among them, so the extension modules that call those still fail.
  From a panel a module runs in a worker, as Slicer runs one in a separate program: the nodes are
  written to files, the work happens away from the page and the files come back. That costs a
  round trip through NRRD (about two seconds for a 7 million voxel volume) and a few seconds more
  the first time, while Python and the wheels are loaded into the worker. `slicer.cli.run()` from
  Python still runs in the page, which is quicker but holds the thread that draws.
- Two CLI modules are built from Slicer's own C++ (Resample Scalar/Vector/DWI Volume, which Crop
  Volume needs, and Median Image Filter). Adding another is a few lines in `Modules/CLI/`, but its
  command line parser has to be generated by GenerateCLP, which needs a host ITK this toolchain does
  not have, so the generated file is kept in the tree and checked against the module's XML.

- `vtkITKLevelTracingImageFilter` no longer throws but returns an empty contour, for every plane
  and seed tried, with the same calls that Slicer's Level Tracing effect makes. Nothing uses it
  yet; the Level Tracing effect would.
- The extension libraries (SlicerVMTK's `vtkvmtkITK` and `vtkvmtkSegmentation`) also compile ITK
  templates of their own and have not been given the hidden-template treatment; if a filter of
  theirs fails the way the vtkITK ones did, that is where to look.

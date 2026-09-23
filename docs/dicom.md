# Bringing the DICOM module to the web

`known-issues.md` says that neither Plastimatch nor DCMTK is built for WebAssembly, and that is
true, but it reads as though DICOM were out of reach altogether. It is not. Most of what the DICOM
module needs is either already compiled in or is pure Python; what is missing is the database, the
browser and the plugin architecture that sit on top. This describes what is there, what has to be
built, and the two places where the desktop's answer cannot be copied.

Today a folder of DICOM files does load: `io.py` gathers every `.dcm` and `.ima` in a selection and
hands them to `AddArchetypeVolume` as one series, and `DataPanel.vue` has a Folder button for it.
That is enough for one series in one directory and wrong for everything else - two series in a
folder become one volume, nothing is indexed, nothing can be browsed, and nothing survives a
reload.

## What is already built

The reading of DICOM pixels is done. `cmake/itk/wasm.cmake` turns on `ITKGDCM` and `ITKIOGDCM`,
with GDCM's own OpenJPEG (`GDCM_USE_SYSTEM_OPENJPEG OFF`), and `ITKFactoryRegistration` registers
the factory, so compressed transfer syntaxes decode in the page already. Only `ITKIODCMTK` is left
out.

The pieces around it are there too: `.dcm` and `.ima` are already `VolumeFile` types in `io.py`,
`runtime.ts` copies files chosen or dropped in the page into the virtual file system, IDBFS already
carries the settings across reloads, and `packages.py` handles installing a Python package on
demand - the comment in `runtime.ts` names pydicom as the example of a package that comes from
PyPI. `app.py` puts `vtk`, `qt`, `ctk` and `slicer` into `__main__`, which is the idiom the older
DICOM plugins still import through.

## What has to be built, and what cannot be

Three things stand between that and the module.

**The reader is switched off.** `VTKITK_BUILD_DICOM_SUPPORT` is `OFF` (`CMakeLists.txt:175`), so
`vtkITKArchetypeImageSeriesReader` never detects a DICOM archetype, never groups a series by UID,
orientation or echo, and never chooses the GDCM image IO. The reason is incidental rather than
principled: one `#ifdef` guards the GDCM include and the DCMTK include together, so switching off
the half that needs DCMTK switches off the half that does not.

**The database is a Qt class.** `ctkDICOMDatabase` needs DCMTK to read tags and QtSql to store
them, and there is no Qt here. But the surface that Slicer's Python actually uses is small: about
twenty-five methods across `DICOM.py`, `DICOMLib` and the plugins, of which fifty-eight call sites
are `fileValue()` alone. That is a thing to reimplement, not a thing to port.

**DIMSE cannot exist in a page.** `DICOMProcesses.py` is 865 lines of `storescp`, `storescu`,
`getscu` and `dcmdump` started through `qt.QProcess` and talking over raw TCP. A page can start no
programs and open no sockets. This file is not ported; DICOMweb replaces what it did.

## Reading the pixels: one patch, and it belongs upstream

Split the `#ifdef` so that GDCM does not depend on DCMTK being present. That means a new
`VTKITK_BUILD_DICOM_SUPPORT_DCMTK` around the `itkDCMTKImageIO.h` include and the branch that
builds a `DCMTKImageIO`, touching `Libs/vtkITK/vtkITKConfigure.h.in`, `Libs/vtkITK/CMakeLists.txt`,
`vtkITKArchetypeImageSeriesReader.cxx` and the scalar and vector readers beside it. Then
`VTKITK_BUILD_DICOM_SUPPORT` goes `ON` in `CMakeLists.txt:175` and the new one stays `OFF`.

This is the only C++ change the module needs, it is a few lines, and it is the kind of patch
`patches/` exists for - a build that has GDCM but not DCMTK is not peculiar to WebAssembly.

`Slicer_BUILD_DICOM_SUPPORT` (`CMakeLists.txt:82`) stays `OFF`. Turning it on would pull in the
CTK and Qt half of Slicer's DICOM support, which is the thing being replaced.

One consequence for the GUI: `DICOMScalarVolumePlugin` offers four reader approaches, two of which
are DCMTK. They have to be hidden rather than removed, because the plugin stores the user's choice
as an index into that list.

## A database of twenty-five methods

`python/slicerweb/dicom_database.py` stands in for `ctkDICOMDatabase` as `slicer.dicomDatabase`,
on `sqlite3` from Pyodide's own CPython and pydicom from PyPI. The schema follows ctkDICOMDatabase's
- patients, studies, series, images - so that `fileValue(file, tag)` keeps its meaning, and the
methods are the ones the ported code calls: `patients`, `studiesForPatient`, `seriesForStudy`,
`filesForSeries`, `instancesForSeries`, `fileValue`, `instanceValue`, `headerValue`,
`loadFileHeader`, `instanceForFile`, `fileForInstance`, `seriesForFile`, `nameForPatient`,
`removePatient`, `insertDateTimeForInstance`, the four that open and close a database, the two
about schema version, and a `databaseChanged` signal raised through `host.emit`.

Indexing reads only the indexed tags (`stop_before_pixels=True` with a `specific_tags` list); a
full header is read when `loadFileHeader` asks for one. It runs in the job worker so that a folder
of a few thousand files does not stop the page drawing, reporting progress the way the CLI modules
already do.

Keeping the metadata in Python matters for more than convenience. The heap of this application
grows and does not shrink, as the memory section of `known-issues.md` records; indexing thousands
of files is exactly the kind of work that should stay out of the wasm heap.

## The plugins, and the one line that would have stopped them

The plugin contract turns out to be portable. A plugin subclasses the pure-Python `DICOMPlugin`,
returns pure-Python `DICOMLoadable` instances from `examine()`, and imports nothing beyond `vtk`,
`qt`, `ctk`, `slicer` and `DICOMLib`. The C++ `qSlicerDICOMLoadable` appears in the Python only
inside comments, and `slicer.qSlicerDICOMExportable` only in `examineForExport`, which is export
and out of scope. So `vtkSlicerDICOMLoadable` and `vtkSlicerDICOMExportable` do not need building
for import to work.

Registration works by itself as well: each plugin is a hidden module whose class sets
`slicer.modules.dicomPlugins[name]`, creating the dictionary if it is not there yet.

Discovery is the exception, and it would have failed silently. `_discover_scripted_modules`
(`modules.py:814`) admits a file only if its text contains `class <name>(ScriptedLoadableModule)`
or one of two spellings of the same thing. Every DICOM plugin declares a bare class instead -
`class DICOMScalarVolumePlugin:`, `class DicomUltrasoundPlugin:` - which is the older module
protocol, and is what all of them still use. Desktop Slicer is looser: `isValidFile` in
`qSlicerScriptedLoadableModuleFactory` accepts any `.py` that is not a CLI scripted executable, and
the class-named-after-the-file rule is applied later when the module is loaded. Matching that is
enough, and only the test has to change - `_createScriptedModule` already instantiates with
`cls(_ModuleParent(name, filename))`, which is the older protocol.

Whether a plugin then *works* depends on what its `load()` reaches for:

| Plugin | What it needs | Works |
|---|---|---|
| `DICOMScalarVolumePlugin` | vtkITK and GDCM | after the patch above |
| Image sequence, volume sequence, enhanced US, GE ABUS, Slicer data bundle | pydicom and MRML | yes, pure Python |
| SlicerHeart's `DicomUltrasoundPlugin` | pydicom and numpy; some paths want KretzFileReader | partly - SlicerHeart is built, so it depends on that library being in the wheel |
| SlicerDMRI's diffusion plugin | the `dwiconvert` CLI module | only if that CLI is compiled in |
| PET DICOM's SUV and RWVM plugins | the `suvfactorcalculator` CLI module | only if that CLI is compiled in |
| QuantitativeReporting's segmentation plugin | the `segimage2itkimage` CLI module (dcmqi) | see below |
| SlicerRT's DICOM-RT plugin | C++ wanting DCMTK and Plastimatch | no |

The rule behind the table: a plugin that stays in Python works, a plugin that calls a CLI module
works only if that module is compiled into `SlicerWebCore`, since a page cannot start a program,
and a plugin needing C++ that is not built does not. A plugin whose backend is absent should say so
in the module rather than quietly finding nothing to load.

## Browsing, and fetching over DICOMweb

The GUI follows the pattern the other modules use: bridge methods in
`python/slicerweb/panels_dicom.py` over the database and the plugins, imported from `app.py` so the
decorators run, and `web/src/app/modules/DICOMPanel.vue` registered in `modules/index.ts` under both
`DICOM` and `dicom`. `DICOM.py`'s own widget half is not used - the Vue panel replaces
`ctkDICOMVisualBrowserWidget` and the rest - but its logic and its coordination of the plugins are.

In place of DIMSE, `python/slicerweb/dicomweb.py` browses with QIDO-RS and retrieves with WADO-RS,
writing what it finds into the same database so that nothing downstream knows where a series came
from. It fetches the way `downloads.py` already does.

The database schema is ready for this, which is worth knowing before inventing something parallel:
the `Images` table carries a `URL` beside its `Filename`, and ctkDICOMDatabase has `urlsForSeries`
and `instanceForURL` to go with it. An instance that lives on a server is a row like any other,
with the URL set and the filename empty, so a series fetched over DICOMweb and a series read from
disk are the same thing to everything above the database.

The limit is the same one the sample data has: the published site is static and has no download
proxy, so only a server that sends CORS headers can be reached from it. That should be said plainly
in the panel, as `downloads.py` says it for sample data, rather than failing in a way that looks
like a bug in the server.

## Where the database lives, and whose database it is

Two things are wanted of the store: that it survives a reload, and - if it can be had - that a
database Slicer already made on the desktop opens as it stands.

`pyodide.mountNativeFS(path, handle)` offers both, through one code path. It mounts a
`FileSystemDirectoryHandle` into the Emscripten file system and hands back a `syncfs` to flush
writes, which is the shape `runtime.ts` already uses for the settings on IDBFS. The handle comes
from either `navigator.storage.getDirectory()`, which is the origin private file system, or
`window.showDirectoryPicker()`, which is a folder the user chooses and grants access to. The mount
does not care which, so this is not a choice to make once in the design; it is a choice to leave to
the user, and to the browser they are in.

A folder the user picks is the better of the two where it can be had. It is visible, it is backed
up with the rest of their files, it can be a folder they already keep DICOM in, and the data does
not quietly vanish when site data is cleared. Against that, `showDirectoryPicker` is Chromium-only:
Firefox and Safari have no way to grant a page a directory, and there the origin private file
system is the answer. The application should offer the picker where it exists and fall back
otherwise, and keep IDBFS - already proven here - behind both.

### Opening a desktop database

The reason this is worth more than persistence alone is that the desktop's database is a plain
SQLite file in a plain directory: `ctkDICOM.sql` beside `ctkDICOMTagCache.sql`, with the files
under `dicom/<study>/<series>/<sop>.dcm` and thumbnails under `thumbs/`. Nothing in it needs DCMTK
or Qt to read. If the Python database work-alike keeps ctkDICOMDatabase's schema - which it should
anyway, so that `fileValue` means the same thing - then pointing the picker at a Slicer database
directory opens it directly, and `schemaVersion`/`schemaVersionLoaded` are already part of the
contract for refusing one that is too new. The schema declares its own version in a `SchemaInfo`
table (`0.8.1` at the time of writing).

Two things decide how far that goes.

The files resolve only if they were copied in. ctkDICOMDatabase stores a copied file by a path
relative to the database directory, in its own words "to make the database relocatable", and
resolves it through `absolutePathFromInternal`; such a database works wherever it is mounted. A
file that was added as a link keeps the absolute path it had on the host - `Add Link` and `Copy`
are both offered by the desktop browser, and `DICOMUtils.importDicom` defaults to not copying - and
that path means nothing inside the browser's sandbox. The metadata still reads: a linked database
can be browsed in full, every patient, study, series and tag, and only loading the pixels fails.
Saying which files are reachable is better than letting the load fail later.

Writing should be treated carefully. A user's real DICOM database is not a scratch space, and two
applications with different schema versions writing the same SQLite file is a way to lose data.
Opening read-only, and keeping anything the web application imports in a database of its own, is
the conservative default; writing to a desktop database is a thing to offer deliberately, if at
all.

This also settles a question raised above by not needing to answer it: because `mountNativeFS`
takes either kind of handle, whether the origin private file system can be reached from the page
rather than a worker stops being the hinge the plan turns on. It is still worth testing early -
Pyodide's own documentation is conservative about which browsers can supply a handle - but a picked
folder and IDBFS stand behind it.

## Deferred: segmentation objects

Reading DICOM SEG needs dcmqi, and dcmqi needs DCMTK. There are two ways to get it and the choice
is better made with the rest working, but the trade is worth writing down because the obvious
reading of it is wrong.

The quick way is `micropip.install("itkwasm-dicom")`, which carries dcmqi and DCMTK already
compiled. Two things argue against it. It provides a Python function, `read_segmentation`, and not
a CLI module, so QuantitativeReporting's plugin - which asks for `slicer.modules.segimage2itkimage`
and gives up if it is not there - would have to be patched or shimmed. And it brings a second ITK
and a second DCMTK into the page at revisions this project does not set: the dcmqi inside it is
pinned at a commit from December 2024, 166 commits behind, without multiframe source support,
without the cross-study reference fix, without the parametric map dimension index fix and without
DCMTK deflate. Bumping that pin is a small contribution to ITK-Wasm and worth making whichever way
this goes.

The other way is to build it, and it is less of a departure than it sounds, because it can follow
the desktop's own layering exactly. Slicer builds DCMTK as an external project and points ITK at it
with `ITK_USE_SYSTEM_DCMTK=ON` and `Module_ITKIODCMTK` (`SuperBuild/External_ITK.cmake`); it does
*not* let ITK build its own, which is what ITK-Wasm does and what should not be copied here. dcmqi
is not part of Slicer either - it is an extension, and QuantitativeReporting depends on it. So
DCMTK belongs in `40-deps.sh`, beside teem, libarchive, RapidJSON and JsonCpp, which are themselves
Slicer's `External_teem`, `External_LibArchive`, `External_RapidJSON` and `External_JsonCpp`; and
dcmqi belongs in `80-extensions.sh` beside SlicerRT and SlicerHeart. Nothing about that is a new
structure.

What it buys is current dcmqi at a revision pinned here, one ITK and one DCMTK in the page rather
than two of each, `slicer.modules.segimage2itkimage` existing so that QuantitativeReporting's
plugin runs unmodified, and the DICOM-RT modules of SlicerRT unblocked. What it costs is a
`patches/DCMTK` directory to keep, a DCMTK configured without threads or network, and a `CLP.h` per
CLI module generated on a host machine and kept in the tree, as `Modules/CLI/` already does. The
open question is whether DCMTK builds as a shared side module; ITK-Wasm shows it compiles under
Emscripten but not in this link model, so that wants trying before it is promised.

## Not in this

Export of any kind, including STOW-RS, and with it the tag editor and the export dialog. RT
structures and doses. DIMSE. SlicerRT's `DicomRtImportExport` stays disabled: it wants Plastimatch
as well, which is a separate and sizeable piece of work.

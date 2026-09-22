# SlicerWeb

Run 3D Slicer natively in the web browser.

Not a re-implementation: this is Slicer's own C++ — MRML, the logic and displayable manager
libraries, the loadable modules, VTK and ITK — compiled to WebAssembly, with Slicer's Python
packages on top of it. A scene here is a `vtkMRMLScene`, a slice view is drawn by the same
displayable managers as on the desktop, and a scripted module's `setup()` runs unchanged. What is
left behind is Qt: the widgets are Vue components that talk to the same objects.

## What works

- **Views**: slice and 3D views with Slicer's own interactor styles, the layouts of
  `vtkMRMLLayoutNode`, crosshair, slice intersections, orientation markers, linked views.
- **Data**: NRRD, NIfTI, MetaImage, VTK/VTP, STL/OBJ/PLY, `.mrml` and `.mrb` scenes, markups,
  segmentations, transforms (including HDF5), tables, colour tables — read and written by the same
  storage nodes as the desktop. Drag a file onto the window, or load one of Slicer's sample data
  sets.
- **Modules**: Volumes, Models, Markups, Segmentations, Segment Editor, Volume Rendering,
  Transforms, Crop Volume, Colors, Terminologies, Tables, Plots, Sequences, Scene Views, Texts and
  Data, each with a web GUI over the module's own logic. Python scripted modules run through a
  `qt`/`ctk` compatibility layer, including their `.ui` files.
- **CLI modules**: a program cannot be started from a page, so a CLI module is either one of
  Slicer's own compiled in and run through `vtkSlicerCLIModuleLogic`, or a Python implementation of
  it. Either way the GUI is built from the module's XML, and the work runs in a worker so the views
  keep drawing.
- **Extensions**: built as wheels and installed from an index at runtime — SlicerVMTK, SlicerHeart,
  MarkupsToModel and SlicerSimVascular are built by this repository.
- **Python**: the console is the one from the desktop, `slicer.util` works, and packages are
  installed on demand from the Pyodide distribution or PyPI.

`docs/known-issues.md` says what is not there yet, and why.

## How it fits together

```
Browser page
├── Vue 3 application (web/)        layout, panels, widgets; talks to MRML through a bridge
└── Pyodide (CPython 3.14)
    ├── slicer, slicerweb (python/) the application object, module manager, IO, qt/ctk layer
    └── side modules in wheels      VTK, ITK, MRML, Slicer libraries, loadable modules
        └── WebGL 2 canvases        one per view node
Web worker: the same wheels again, for work that would otherwise stop the page
```

Everything is a Pyodide side module, one shared library per library as on the desktop, packaged as
wheels: `vtk`, `slicerweb-itk`, `slicer-core`, `slicer-modules-core`, `slicerweb`, and one per
extension. The page installs them with micropip at startup.

There is no Qt, so what Qt did is done here instead: `SlicerWebCore/` holds Qt-free views, a layout
manager and the CLI module glue, and `python/slicerweb/` holds the application, the module manager
and the IO manager, together with `qt` and `ctk` modules that build Vue widgets.

## Building

Everything is built in a container, driven from Windows by `build.ps1` (or `scripts/build.sh`
inside the container). You need Docker and the sources of Slicer, VTK, ITK and the rest, which the
first stage fetches at the revisions pinned in `sources.env`.

```powershell
.\build.ps1 all          # every stage, a few hours from cold
.\build.ps1 50-slicer 60-wheels   # or just the stages that matter after a change
```

The stages are in `scripts/stages/`: the sources and patches (`00`), VTK's compile tools for the
host (`10`) and VTK itself (`20`), ITK (`30`), teem, libarchive and the rest (`40`),
SlicerExecutionModel (`45`), the Slicer libraries and modules (`50`), the wheels (`60`), a smoke
test (`70`) and the extensions (`80`). The wheels land in `D:\SlicerWeb-build\dist`.

Patches to the upstream projects are in `patches/`, applied by stage `00` and kept small enough to
be sent upstream — the interesting ones are the WebGL fixes in `patches/VTK/` and the one that lets
Slicer's application logic work without threads.

## Running it

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build && npm run preview
```

The wheels, sample data and extensions are taken from the build's `dist` directory; point
`SLICERWEB_WHEELS`, `SLICERWEB_SAMPLE_DATA` and `SLICERWEB_EXTENSIONS` elsewhere if you keep them
somewhere else. Pyodide itself is served from the application, not from a CDN.

## Publishing

The application is published at <https://lassoan.github.io/slicerweb-app/> by the
[Publish app](.github/workflows/publish-app.yml) workflow, which runs when anything under `web/`
changes on `main`, and on request.

A build of the site is a few hundred megabytes: the WebAssembly runtime, and the sample data, which
it carries itself because a site of static files cannot fetch files from servers that refuse
cross-origin requests (the development server fetches them for the page; the published site has no
such proxy, and is built with `VITE_DOWNLOAD_PROXY=0` so that it says so plainly instead of trying).
Keeping those builds in a branch here would mean carrying every one of them in this repository's
history for ever, so the site is pushed to a repository of its own,
[lassoan/slicerweb-app](https://github.com/lassoan/slicerweb-app), as a single commit with no
parent: it holds one build and no history.

The wheels take hours to compile and no runner could build them, so they travel through a release:

```powershell
.\build.ps1 60-wheels 80-extensions      # build them here
.\scripts\publish-runtime.ps1 -Publish   # upload them, and rebuild the site
```

The site repository's Pages source is its `main` branch, and the workflow writes to it with a
deploy key of that repository, whose private half is the secret `SLICERWEB_APP_KEY` here (a token
in `SLICERWEB_APP_TOKEN` is used instead where there is one).

## Tests

The tests drive a real browser (Playwright, `channel: "chrome"`) against a running application and
check what the page and the scene actually did:

```bash
cd web
node tests/browser-smoke.mjs "http://localhost:5173/?sample=CTChest"
node tests/segment-editor-effects.mjs
node tests/volume-rendering.mjs
```

Each file says at the top what it is for; several of them exist because of a bug that is worth not
having again.

## Licence

3D Slicer's licence (see `LICENSE`), the same BSD-style agreement the project it is built from
uses.

This repository also carries a little code derived from other projects under their own licences:
the command line parsers under `Modules/CLI/` are generated from Slicer's module descriptions, and
`patches/` holds differences against Slicer, VTK and SlicerExecutionModel.

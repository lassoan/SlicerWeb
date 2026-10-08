# SlicerWeb

Run 3D Slicer natively in the web browser. Try it here: **https://lassoan.github.io/slicerweb-app/**

Not a re-implementation: this is Slicer's own C++ — MRML, the logic and displayable manager
libraries, the loadable modules, VTK and ITK — compiled to WebAssembly, with Slicer's Python
packages on top of it. A scene here is a `vtkMRMLScene`, a slice view is drawn by the same
displayable managers as on the desktop, and a scripted module's `setup()` runs unchanged. What is
left behind is Qt: the widgets are Vue components that talk to the same objects.

## Opening data with a link

Add the address of a file to the link, URL-encoded, and the application opens on it. Examples:

- From dropbox: https://lassoan.github.io/slicerweb-app/?url=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffi%2Froj7jd4fmcm4rtotwoisl%2FSlicerSceneWithSegClipping3.mrb%3Frlkey%3Dkakd6h5r7961njw0x20hwgcyk%26dl%3D0
- From github: https://lassoan.github.io/slicerweb-app/?url=https%3A%2F%2Fgithub.com%2Flassoan%2FPublicTestingData%2Freleases%2Fdownload%2Fdata%2FColoredVolumeRenderingScene.mrb

Any file it reads works, a whole `.mrb` scene too, from any server: one that does not allow other
sites to read its files is reached through the site's download proxy, and a Dropbox share link can
be used as it is. `&volumeRendering=1` also volume renders the volume, `&layout=OneUp3D` starts in
another layout; all the arguments are listed in [docs/embedding.md](docs/embedding.md).

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
  MarkupsToModel, SimVascular, SlicerIGSIO, SlicerIGT and SlicerRT (without Plastimatch and
  DICOM) are built by this repository, from the description files in `extensions/`; a folder of
  others, private ones too, can be built instead ([docs/extensions.md](docs/extensions.md)).
- **Python**: the console is the one from the desktop, `slicer.util` works, and packages are
  installed on demand from the Pyodide distribution or PyPI.

`docs/known-issues.md` says what is not there yet, and why, and
[docs/embedding.md](docs/embedding.md) describes how to put the application in a website of your
own and how that website and the application can talk to each other.

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
and the IO manager (which, like qSlicerCoreIOManager, hands files to the readers and writers of
Slicer's `vtkMRMLFileIOManager`), together with `qt` and `ctk` modules that build Vue widgets.

## Building

Everything is built in a container, driven by `build.py` on Windows, Linux or macOS (or by
`scripts/build.sh` inside the container). All you need is Docker, Python 3.8 or later and a network
connection: the build fetches every
source it compiles from its repository - Slicer, VTK, ITK and the rest at the revisions pinned in
`sources.env`, the extensions at those in `extensions/*.json` - and no source tree is needed
from outside.

```sh
python build.py all                   # every stage, a few hours from cold
python build.py 50-slicer 60-wheels   # or just the stages that matter after a change
```

`slicerweb.py` builds an application: the folder it is run in, or the one `-C <folder>` names. Its
`application.json` says which extensions the application has and which features it offers.
[examples/](examples/README.md) has two: `full`, with every extension of `extensions/` - the
application SlicerWeb is developed with - and `minimal`. An application that is published is such
a folder in a repository of its own, which the build is published to
([docs/extensions.md](docs/extensions.md)).

What differs from one computer to another - where everything built goes, where the SlicerWeb
checkout is, where the secrets are - goes in the env file of the application, `.env` in its folder
(copied from its `.env.example`; `.gitignore` keeps it out of the repository). No checkout holds
secrets: `SW_SECRETS` of `.env` names a folder outside them.

```sh
python slicerweb.py -C examples/full build                                  # everything
python slicerweb.py -C examples/full build extensions SlicerHeart SlicerRT  # these extensions
python slicerweb.py -C examples/full serve                                  # try the build in the browser
```

The stages are in `scripts/stages/`: the sources and patches (`00`), VTK's compile tools for the
host (`10`) and VTK itself (`20`), ITK (`30`), teem, libarchive and the rest (`40`),
SlicerExecutionModel (`45`), the Slicer libraries and modules (`50`), the wheels (`60`), a smoke
test (`70`) and the extensions (`80`, which packages their wheels too). The wheels land in
`SW_DIST/wheels`.

Patches to the upstream projects are in `patches/`, applied by stage `00` and kept small enough to
be sent upstream — the interesting ones are the WebGL fixes in `patches/VTK/`. Slicer itself needs
none: everything SlicerWeb changed in it is in Slicer's main branch, which `sources.env` pins.

## Running it

```bash
python slicerweb.py -C examples/full dev     # the development server (SW_DEV_PORT, default http://localhost:5173)
python slicerweb.py -C examples/full serve   # the built application (SW_PORT, default http://localhost:4175)
```

Nothing is generated in the checkout: the web application runs in a copy of `web/` in
`SW_DIST/web-workspace`, where npm installs its packages, and `dev` copies each change of the
checkout there as it is saved (Vite then reloads it). The wheels, sample data and extensions are
taken from `SW_DIST`. Pyodide itself is served from the application, not from a CDN.

## Publishing

The application is published at <https://lassoan.github.io/slicerweb-app/> from
[lassoan/slicerweb-app](https://github.com/lassoan/slicerweb-app), the repository of the application
([docs/extensions.md](docs/extensions.md)): its `main` branch says which extensions the build has
(`application.json`, which configures the application too) and holds the workflow that publishes the site, which calls the
[Publish app](.github/workflows/publish-app.yml) workflow of this repository. That workflow also runs
here when anything under `web/` changes on `main`, and publishes the site again with the runtime it
has.

A build of the site is a few hundred megabytes: the WebAssembly runtime, and the sample data, which
it carries itself because a site of static files cannot fetch files from servers that refuse
cross-origin requests (the development server fetches them for the page; the published site has no
such proxy of its own).

Other files of such servers - any URL a user loads - are fetched through a download proxy: a
Cloudflare Worker, [download-proxy/worker.js](download-proxy/worker.js), that only pages of the
allowed sites may use and that passes files on without keeping them. It is published with
`python scripts/publish_download_proxy.py --settings <folder with the Cloudflare settings>`, and
the site is built with its address from the repository variable `SLICERWEB_DOWNLOAD_PROXY`
(`VITE_DOWNLOAD_PROXY`; without one, `0`: no proxy, which the site says plainly instead of trying).
Servers that allow cross-origin requests are read directly, never through the proxy.

Keeping those builds in a branch here would mean carrying every one of them in this repository's
history for ever, so the site is pushed to the branch `deploy/latest` of lassoan/slicerweb-app, as a
single commit with no parent: it holds one build and no history.

The wheels take hours to compile and no runner could build them, so they travel through a release
(`runtime-latest` of lassoan/slicerweb-app), from a checkout of it:

```sh
cd C:/D/slicerweb-app
python C:/D/SlicerWeb/slicerweb.py build    # build them here
python C:/D/SlicerWeb/slicerweb.py deploy   # upload them, and rebuild the site
```

The site repository's Pages source is its branch
`deploy/latest`. The workflow of this repository writes to it with a deploy key of that repository,
whose private half is the secret `SLICERWEB_APP_KEY` here (a token in `SLICERWEB_APP_TOKEN` is used
instead where there is one); its own workflow writes with its own token.

## Tests

The tests drive a real browser (Playwright, `channel: "chrome"`) against a running application and
check what the page and the scene actually did:

```bash
python slicerweb.py -C examples/full test tests/browser-smoke.mjs "http://localhost:5173/?sample=CTChest"
python slicerweb.py -C examples/full test tests/segment-editor-effects.mjs
python slicerweb.py -C examples/full test tests/volume-rendering.mjs
```

(They run in the copy of `web/`, where their npm packages are. A screenshot a test is told to save
goes where it is told: give it a path outside the checkout.)

Each file says at the top what it is for; several of them exist because of a bug that is worth not
having again.

## Licence

3D Slicer's licence (see `LICENSE`), the same BSD-style agreement the project it is built from
uses.

This repository also carries a little code derived from other projects under their own licences:
the command line parsers under `Modules/CLI/` are generated from Slicer's module descriptions, and
`patches/` holds differences against VTK, vtkAddon and SlicerExecutionModel.

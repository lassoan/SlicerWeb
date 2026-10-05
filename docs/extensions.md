# Bundling extensions

The extensions a build bundles are the extension description files in a folder: `extensions/` of
this repository, or any other folder given to the build. Stage `80-extensions` fetches each one at
the revision its file names, builds it against the SlicerWeb build tree, installs the Python
packages it asks for, and packages it as a wheel in `dist/extensions`, together with the extension
index (`index.json`) that the Extensions Manager reads.

```sh
python build.py 80-extensions                                              # extensions/ of this repository
python build.py --extensions-dir ../SlicerWebExtensions 80-extensions      # another folder
python build.py --extensions SlicerHeart 80-extensions                     # only rebuild some of them
```

## Description files

One `<Name>.json` per extension, named after the extension (its CMake `project()`), in the format of
the [Slicer ExtensionsIndex](https://github.com/Slicer/ExtensionsIndex), so a file can be copied from
there as it is:

| Key | Used for |
| --- | --- |
| `scm_url` | the git repository (`https://`, or `git@github.com:` for a private one) |
| `scm_revision` | a commit, branch or tag. A branch is built at whatever it holds when the build runs; a commit keeps the build reproducible |
| `build_dependencies` | extensions built before this one. One that is not in the folder is reported, and the build goes on (SlicerVMTK does without ExtraMarkups) |
| `slicerweb` | what only matters for the browser build (below); the Slicer extension build ignores it |

```json
{
  "scm_url": "https://github.com/lassoan/SlicerSimVascular.git",
  "scm_revision": "be90339c18b7de7b093d1e65e2a1b7e13dead9ca",
  "build_dependencies": [],
  "slicerweb": {
    "python_packages": [
      "scipy",
      "svmorph @ git+https://github.com/lassoan/svMorph.git@330908d80dd911f2a8ca17942dbdce5acf5b3aed"
    ],
    "cmake_options": []
  }
}
```

### Python packages

`slicerweb.python_packages` lists what the extension would pip-install on the desktop, as pip
requirements: a name (`scipy`), a pinned version (`pyyaml==6.0.3`), or a git repository
(`name @ git+https://github.com/org/repo.git@<commit>`). A browser cannot pip-install, so the build
sorts them:

- **In the Pyodide distribution** (SciPy, scikit-image, PyYAML, ...): not bundled. The page loads
  them when the extension is installed and at every start. Pyodide has one version of each: a
  requirement for another one is reported, and Pyodide's version is used.
- **Everything else** is pip-installed into the extension's wheel. It has to be pure Python: the
  build stops at a package with compiled code, since nothing here compiles it for WebAssembly.
- `vtk` is SlicerWeb's own and is left alone.

Dependencies are not followed (a package's own requirements often include things that cannot work
in a browser, such as JAX for svMorph), so list every package the extension imports.

An extension can also say this itself, in a `slicerweb-extension.json` of its source
(`{"pythonPackages": ["scipy"]}`, Pyodide packages only); both lists are used.

**Icon.** The Extensions Manager shows the icon that `"icon"` of `slicerweb-extension.json` names,
a file of the extension's repository (`{"icon": "MyExtension.png"}`), which is copied next to the
extension index; else the `EXTENSION_ICONURL` of its CMakeLists.txt. An icon the page cannot load -
that of a private repository, say - is shown as a placeholder, with a warning in the log; a private
extension names its icon in `slicerweb-extension.json`.

Packages that come with desktop Slicer are there for an extension without it saying so, so they
are added too: the small ones of them that the extension's Python code imports anywhere - also
inside a function, as ImportMimics imports pydicom only when it reads an image - are listed by
`scripts/make_wheels.py` (`BUNDLED_PACKAGES`, for example pydicom and Pillow).

### How an extension is built

Every extension is built as Slicer's extension build builds it, with nothing specific to one
extension in this repository: configured against the SlicerWeb build tree (`Slicer_DIR`), built -
its superbuild included, so an extension that needs a library builds it itself (SlicerVMTK builds
VMTK, SlicerIGSIO builds IGSIO) - and installed: its own build tree (`build_subdirectory` of the
description file, `inner-build` for one with a superbuild) and whatever it lists in
`<Name>_CPACK_INSTALL_CMAKE_PROJECTS`, the list Slicer's extension packaging uses too. An extension
that another depends on is handed to it as `<Name>_DIR` (SlicerIGT finds SlicerIGSIO, and IGSIO
through it).

What makes this a WebAssembly build is a toolchain file that stage `80-extensions` writes and names
in the environment (`CMAKE_TOOLCHAIN_FILE`), so that every CMake configure reads it - the
extension's, and those of the projects its superbuild adds, which get no command line from us. It
holds Pyodide's toolchain, the side-module flags, and the stand-ins for OpenGL and zlib.

An extension adapts to WebAssembly the way it adapts to a platform: with CMake's `EMSCRIPTEN`, as
it would with `APPLE` or `WIN32` - for example, not building a library that cannot be built there,
or a module that runs a program, which a web page cannot. And to what SlicerWeb's Slicer lacks,
with the variables of its `SlicerConfig.cmake`, as for any Slicer (`Slicer_BUILD_DICOM_SUPPORT` is
`OFF`, `Slicer_BUILD_CLI` is `OFF`). Such changes belong in the extension's own repository; until
they are merged upstream, the description file points at a fork that has them.

`slicerweb.cmake_options` in a description file adds CMake options, for when a build needs to be
told something the extension cannot tell by itself. Patches in `patches/<Name>/` are applied to a
fetched source; they are for the libraries SlicerWeb builds itself (Slicer, VTK, ITK, ...).

## Private repositories

### Sources

The build fetches private repositories with a GitHub token: the environment variable `SW_GIT_TOKEN`,
or the file `github-token` of the folder that `SW_SECRETS` in `.env` names (below), outside the
checkouts: no checkout holds secrets. Git and pip get it from a credential helper, so it is not
part of any URL or log. SSH URLs of GitHub (`git@github.com:org/repo.git`) are fetched over HTTPS
with it.

Everything the build runs can read the token, including the extensions' CMake code and the build
scripts of the Python packages. Use a
[fine-grained token](https://github.com/settings/personal-access-tokens/new) with read-only
**Contents** access to just the repositories the build needs, rather than `gh auth token`.

### Deployment

A site is published from a repository of its own, a *deployment*: it configures the application -
which extensions its build has, which features it offers - and holds the workflow that publishes
the site. It holds nothing else - no secrets, nothing built - but for the env file of this computer,
`.env`, which its `.gitignore` keeps out of the repository:

```
slicerweb-deploy/
├── application.json                   the configuration of the application, its extensions among it
├── extensions/*.json                  description files of its own: other extensions, private ones among them
├── .github/workflows/publish-app.yml  builds and publishes the site
├── .gitignore                         keeps .env out
├── .env                               where everything is on this computer (not committed)
└── README.md
```

It is built, published and tried with `slicerweb.py` of this repository, run in the deployment
checkout (or given it with `-C <folder>`). Its `.env` (copied from
`examples/minimal/.env.example` of this repository) says where everything is on this computer:

```
SW_SLICERWEB=C:/D/SlicerWeb                             # the SlicerWeb checkout that builds it
SW_DIST=D:/SlicerWeb-build/dist-slicerweb-deploy        # everything built: wheels, extensions, the web application, sample data
SW_SECRETS=D:/SlicerWeb-build/secrets/slicerweb-deploy  # github-token: read access to the private repositories (optional)
SW_PORT=4175                                            # the port of serve
```

```sh
cd C:/D/slicerweb-deploy
python C:/D/SlicerWeb/slicerweb.py build                                  # everything
python C:/D/SlicerWeb/slicerweb.py build extensions                       # all extensions
python C:/D/SlicerWeb/slicerweb.py build extensions SlicerHeart SlicerRT  # these extensions
python C:/D/SlicerWeb/slicerweb.py deploy [channel]                       # publish (latest by default)
python C:/D/SlicerWeb/slicerweb.py serve                                  # try it in the browser
python C:/D/SlicerWeb/slicerweb.py stop                                   # stop that server
```

The [examples](../examples/README.md) of this repository are folders of the same kind, built the
same way, but not published: to publish one, copy it to a repository of its own. `slicerweb.py`
calls `build.py --deployment` and `scripts/publish_runtime.py --deployment`, which may also be run
themselves.

`application.json`:

```json
{
  "extensions": {
    "slicerweb": ["SlicerHeart", "SlicerVMTK", "SurfaceMarkup"],
    "folder": "extensions"
  },
  "features": {
    "developerMode": "enabledByDefault",
    "pythonConsole": true,
    "extensionsManager": true
  }
}
```

- `extensions.slicerweb` names extensions described in `extensions/` of this repository, so that
  they are not copied and kept up to date in every deployment - or is `"all"`, for every one of them
  (also those added later).
- `extensions.folder` is a folder of description files of the deployment's own (relative to
  `application.json`): each adds an extension, or takes the place of the one of this repository of
  the same name (to build it at another revision, say).
- `features` (each optional, the first value the default):
  - `developerMode`: `enabledByDefault` - on, and the Application settings can turn it off;
    `disabledByDefault` - off, and they can turn it on; `unavailable` - off, and not offered;
  - `pythonConsole`: `true` or `false` - the Python console in the application menu and Ctrl+3;
  - `extensionsManager`: `true` or `false` - the Extensions Manager in the menu and Ctrl+4.

The build puts the descriptions together in `<dist>/extension-descriptions` and stops at a name that
`extensions/` here has no description of, or at a feature or value that `application.json` cannot
have. The rest of the configuration goes to `<dist>/wheels/application.json`, with the runtime to the
site, where the application reads it at startup (`web/src/core/appConfig.ts`); `deploy` writes it
again from the deployment, so a change of `features` needs no build. A setting a user has not changed
follows its default, also when the deployment changes it.

Its build goes to a dist folder of its own (`SW_DIST`), since a build of a deployment has only its
extensions.

A build with private extensions must not go to a public repository: `publish_runtime.py` refuses to
upload a build to one if it has an extension whose source cannot be read without a token. Such a
deployment is a private repository, for example `myorg/slicerweb-deploy`.

The workflow calls the one of this repository, which takes the runtime from the deployment
repository's `runtime` release and pushes the site - one commit, no history - to its `gh-pages`
branch:

```yaml
name: Publish app
on:
  workflow_dispatch:
permissions:
  contents: write   # read the runtime release, push the site to gh-pages
jobs:
  publish:
    uses: lassoan/SlicerWeb/.github/workflows/publish-app.yml@main
    with:
      appRepository: ${{ github.repository }}
      appBranch: gh-pages
      slicerwebRef: main          # the SlicerWeb commit the runtime was built from, to keep them in step
    secrets: inherit
```

Build and publish:

```sh
python build.py --deployment ../slicerweb-deploy 60-wheels 80-extensions
python scripts/publish_runtime.py --deployment ../slicerweb-deploy --publish     # to the repository it is a checkout of
```

The published application, <https://lassoan.github.io/slicerweb-app/>, is a deployment too:
[lassoan/slicerweb-app](https://github.com/lassoan/slicerweb-app) (public), whose `main` branch has
its `application.json` and workflow, and whose site is on its branch `deploy/latest`. A change of the
web application here publishes it again on its own, with the runtime it has (`.github/workflows/publish-app.yml`).

**Channels.** A deployment can publish several versions side by side - `latest`, `stable`, `1.0.0` - each
to a branch of its own, `deploy/<channel>`, from a runtime release of its own, `runtime-<channel>`, so
that a version keeps the build it was published with. The workflow then takes the channel as an
input (`appBranch: deploy/${{ inputs.channel }}`, `runtime: runtime-${{ inputs.channel }}`), and
`publish_runtime.py --channel stable --publish` uploads to that release and runs it for that channel.
[lassoan/slicerweb-app](https://github.com/lassoan/slicerweb-app) is set up this way.

Other inputs: `appRepository` may be another private repository (give the workflow a deploy key as
the secret `SLICERWEB_APP_KEY`, or a token as `SLICERWEB_APP_TOKEN`); `runtimeRepository` and
`runtime` name another release; `RUNTIME_TOKEN` is a secret for reading a release of another private
repository; `sampleData: false` leaves the sample data out.

**Who can open the site.** A private repository keeps the files private, but GitHub Pages of a
private repository is public unless the organization is on GitHub Enterprise Cloud, where Pages can
be restricted to the organization's members. Without Enterprise Cloud, do not turn on Pages for
the branch. Serve it from a host that checks who is asking instead, for example Cloudflare Pages or
a Cloudflare tunnel behind Cloudflare Access, as `scripts/publish_test_site.py` does for the test
site (its settings and API token in a folder of their own, `--deployment`).

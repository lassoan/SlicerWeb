# Embedding SlicerWeb in a website

SlicerWeb is a static site: HTML, JavaScript, WebAssembly and wheels, all addressed relatively.
Anything that can serve a directory can host it, and any page can embed it in a frame. This
describes how to put it in a page, how that page tells it what to show, and how what runs inside it
reaches back out.

Nothing here needs a server of your own beyond the files, and nothing needs cross-origin isolation:
the runtime works without SharedArrayBuffer, so no COOP/COEP headers are involved.

- [Putting it in a page](#putting-it-in-a-page)
- [The website driving the application](#the-website-driving-the-application)
- [The application calling the website](#the-application-calling-the-website)
- [Across origins](#across-origins)
- [What it costs](#what-it-costs)

## Putting it in a page

Copy the published site (or build it, see the [readme](../README.md)) to a path of your own and
point a frame at it:

```html
<iframe id="slicer" src="/slicer/?layout=FourUp&sample="
        style="width: 100%; height: 100%; border: 0"></iframe>
```

What the application reads when it starts:

| | |
|---|---|
| `?layout=<name>` | the layout to start in: `FourUp`, `OneUpRedSlice`, `Dual3D`, … (default `FourUp`) |
| `?sample=<name>` | a sample data set to load; **`?sample=` with nothing after it loads nothing**, which is what an embedded application usually wants |
| `?url=<address of a file>` | a file to load, URL-encoded; repeat it for several files (a scene, `.mrb`, among them). Loaded instead of `?sample=`. A file of a server that does not allow cross-origin requests is fetched through the site's download proxy (`VITE_DOWNLOAD_PROXY`, see the [readme](../README.md)), and a Dropbox share link is read from where the file itself is |
| `?volumeRendering=1` | with `?sample=` or `?url=`: also volume render the volume it loads, with the preset that suits it; `?volumeRendering=<preset name>` (`CT-Chest-Contrast-Enhanced`, `MR-Default`, …) for a given preset |
| `?extensions=<names>` | extensions to make sure are installed, by their names in the extension index (`SlicerHeart,SlicerIGT`), or wheel URLs; installed with what they depend on, and remembered as an installation from the Extensions Manager is |
| `?module=<name>` | the module to open at startup (`Elastix`); it may be one of the extensions of `?extensions=`, as it is opened once they are installed. A restored last session opens the module that was open in it instead |
| `?favoriteModules=<names>` | the modules the toolbar offers, in order (`SegmentEditor,Markups,Models`); for this page only, not kept as the user's setting (Application settings > Modules) |
| `localStorage["slicerweb.extensions"]` | a JSON list of extension wheel URLs to install at startup |

Serving it from your own origin is worth the copy: a frame on the same origin can be driven
directly, while one on another origin can only be reached through messages (see
[across origins](#across-origins)).

## The website driving the application

On the same origin, the frame's `window.slicerWeb` **is** the running application - the same object
the browser console and the tests use. Wait for it to be ready, then talk to it:

```js
const frame = document.getElementById("slicer");
const slicerWebApp = await new Promise((ready) => {
  const poll = () => (frame.contentWindow?.slicerWeb?.store.status === "ready"
    ? ready(frame.contentWindow.slicerWeb)
    : setTimeout(poll, 200));
  frame.addEventListener("load", poll);
});
```

### Loading and saving data

Files live in the application's own file system, so loading and saving are two steps each.

To load, put the bytes there, then read them into the scene.

```js
// something your site serves (same origin, or a server that allows cross-origin requests)
const path = await slicerWebApp.downloadFile("/cases/42/ct.nrrd", "ct.nrrd");
await slicerWebApp.bridge.call("loadFiles", [[path]]);

// bytes you already hold: a File from an <input>, or anything you have fetched
const [scene] = await slicerWebApp.writeFiles([new File([blob], "case42.mrb")]);
await slicerWebApp.bridge.call("loadFiles", [[scene]]);

// several files that belong together (a volume and its segmentation, a DICOM series)
await slicerWebApp.bridge.call("loadFiles", [[volumePath, segmentationPath]]);
```

To save, write the file there, then read its bytes out.

```js
await slicerWebApp.bridge.call("saveScene", ["/data/out/case42.mrb"]); // save to application's virtual file system
const [mrb] = await slicerWebApp.readFiles(["/data/out/case42.mrb"]);  // copy the file to browser file object
await fetch("/cases/42/scene", { method: "PUT", body: mrb }); // use a web request to store the file
```

`loadFiles` reads what the extension says it is - volumes, models, markups, segmentations,
transforms, tables, and `.mrml`/`.mrb` scenes - and returns the IDs of the nodes it added.
`downloadFile` reports progress through its `onProgress` option, and `saveFileToDisk(path)` offers a
file of the application's file system to the visitor as a download. A file that module code writes
next to files the visitor chose (with `writeFiles`, the Data panel or a module's file selector) is
offered as a download by itself, since on the desktop it would have landed in the visitor's folder:
RawImageGuess's NRRD header of a raw file, for instance. Files written anywhere else are not.

`readFiles` rejects, naming the path, if a path is not a file.

### User-initiated data saving

The user may initiate saving of the scene or various other files inside the application too, such as
"Save scene" in the Data panel, "Save to file" on a node, a segmentation's "Export to files",
a dose volume histogram export, "Save picture" in Scene Views, the log, and files that modules
write to be saved (a save path box, a file next to one the visitor chose).

By default, each of these is written to the application's file system and then offered by the browser as a
download.

A page that stores files somewhere of its own can define its own save handler instead:

```js
slicerWebApp.saveHandler = async (path) => {
  const [file] = await slicerWebApp.readFiles([path]);
  await fetch(`/cases/42/files/${encodeURIComponent(file.name)}`, { method: "PUT", body: file });
};
```

While a handler is set, nothing is downloaded - not even when the handler throws or its promise is
rejected (that is logged as an error, and nothing more). A handler that wants a download after all,
for example when its upload fails, can call `slicerWebApp.saveFileToDisk(path)` itself.
Set `saveHandler = null` to go back to downloads.

A save the page itself asks for (`bridge.call("saveScene", ...)` above) does not reach the handler;
the page knows the path already. Every file the user saves also sends the `file-saved` event
(`{path}`), with a handler or without, for a page that only wants to know.

### Accessing other application features

Three levels of access are available:

```js
// 1. named operations of the application (python/slicerweb: every @method())
await slicerWebApp.bridge.call("closeScene");
await slicerWebApp.bridge.call("saveScene", ["/data/case42.mrb"]);
const tree = await slicerWebApp.bridge.call("getSubjectHierarchy");

// 2. any method of any object in the scene
//    targets: app, layout, io, scene, appLogic, node:<id>, logic:<Module>
await slicerWebApp.bridge.invoke("node:vtkMRMLScalarVolumeNode1", "SetName", ["CT"]);
const nodeCount = await slicerWebApp.bridge.invoke("scene", "GetNumberOfNodes");
// a node passed as an argument travels as {__node__: "<id>"}
await slicerWebApp.bridge.invoke("logic:Volumes", "CreateAndAddLabelVolume",
                           [{ __node__: "vtkMRMLScalarVolumeNode1" }, "Segmentation labels"]);

// 3. Python, for anything the first two do not reach
await slicerWebApp.bridge.evalPython("slicer.util.getNode('CT').GetDisplayNode().SetWindowLevel(1000, 300)");
const count = await slicerWebApp.bridge.evalPython("len(slicer.util.getNodesByClass('vtkMRMLModelNode'))", "eval");
```

`evalPython` in `"eval"` mode returns the value's Python `repr` as a string, so parse it or return
JSON from the expression itself.

### Get event notifications from the application

```js
slicerWebApp.bridge.events.on("nodes-loaded", ({ fileName, nodeIDs }) => console.log(fileName, nodeIDs));
slicerWebApp.bridge.events.on("scene-changed", () => refreshMyCaseList());
slicerWebApp.bridge.events.on("busy", ({ busy }) => showSpinner(busy));
```

The events the application sends on its own: `app-ready`, `busy`, `scene-changed`, `nodes-loaded`,
`node-modified`, `layout-changed`, `file-written` (a node written to a file, including each file of
a scene), `file-saved` (a file the user saved, see above), `modules-changed`, `cli-module` (a command line
module starting, finishing or failing), `log`, and `open-dialog`. A module of your own can send any
others it likes (below).

## The application calling the website

### From JavaScript

The frame is a window like any other, so on the same origin:

```js
window.parent.caseApi.saveMeasurements({ case: 42, volumeMl: 87.3 });
```

### From Python

Python reaches the page through Pyodide's `js` module.

```python
import js
js.window.alert("Hello from Slicer's Python")
```

A Slicer module can use this for example to report a result or get information from the website:

```python
import json
import js

# tell the site something
js.window.parent.caseApi.saveMeasurements(json.dumps({"case": 42, "volumeMl": 87.3}))

# ask it something (values come back as JavaScript proxies; str() and float() convert them)
caseId = str(js.window.parent.caseApi.currentCaseId())
```

Passing JSON strings across is the least surprising way: JavaScript objects arrive in Python as
proxies, and Python dictionaries need `pyodide.ffi.to_js` to go the other way.

### Events instead of calls

For anything the host should react to rather than be called for, a module can send an event that
arrives on the host's `bridge.events`:

```python
from slicerweb import host

host.emit("measurement-ready", {"case": 42, "volumeMl": 87.3})
```

```js
slicerWebApp.bridge.events.on("measurement-ready", (payload) => caseApi.save(payload));
```

This keeps the module free of anything about the page it happens to be embedded in.

### Shipping your own code

Code that runs inside the application is a scripted module in an extension wheel, installed at
startup through `localStorage["slicerweb.extensions"]`. That is how a site adds its own buttons,
its own steps, and its own calls back to itself, without a fork of the application.

## Across origins

A frame from another origin - the published site at `lassoan.github.io` while your page is
elsewhere - is closed to all of the above: the browser refuses `frame.contentWindow.slicerWeb`, and
the application has no `postMessage` interface of its own yet.

Two ways out:

1. **Serve it yourself.** Copy the site under your own origin. Everything above then works, and
   this is the path to prefer.
2. **Add a relay.** Roughly forty lines in `web/src/main.ts`: a `message` listener that checks
   `event.origin` against an allowlist, passes `{id, method, args}` to `bridge.call`, posts
   `{id, result}` back, and forwards chosen events outward.

If you add a relay, two things decide whether it is safe:

- The allowlist belongs in the build or in a configuration file, never in a query parameter -
  otherwise any site can frame the application and drive it.
- `evalPython` and `invoke` must not be reachable through it. They run arbitrary code in the frame;
  expose a named list of operations instead, and keep it to what the host actually needs.

## What it costs

- The first visit downloads about 70 MB (the runtime, the wheels) and takes a few seconds before
  the views appear; afterwards the browser cache carries it. Sample data adds to that only when it
  is asked for.
- One instance per page. Each view holds a WebGL context and browsers allow around sixteen.
- The application fills the element it is given and expects a real height - a frame with
  `height: 100%` inside a parent that has none will collapse to nothing.

/**
 * SlicerWeb runtime: loads Pyodide (CPython compiled to WebAssembly), installs the SlicerWeb wheels
 * (VTK, ITK, Slicer libraries and modules, extensions) and starts the Slicer application.
 */
import type { PyodideAPI } from "pyodide";
import { PyodideBridge, setBridge } from "./bridge";
import { jobRunner } from "./jobs";
import { EXTENSIONS_KEY, extensionIndexUrl, loadExtensionIndex, resolveExtensionWheels, type ExtensionIndex } from "./extensions";
import { loadSettings } from "./settings";

export interface RuntimeConfig {
  /** Base URL of Pyodide core files (default: <app>/pyodide/). */
  pyodideURL?: string;
  /** Base URL of Pyodide packages such as numpy (default: jsDelivr CDN of the same Pyodide version). */
  pyodidePackagesURL?: string;
  /** Base URL of SlicerWeb wheels (default: <app>/wheels/). */
  wheelsURL?: string;
  /** Wheel distribution names installed at startup (in this order). */
  startupPackages?: string[];
  /** Additional wheel URLs (installed extensions). */
  extensionWheels?: string[];
  /** Extensions to make sure are installed, by their name in the extension index (or wheel URL). */
  extensions?: string[];
  /** Initial layout name, e.g. "FourUp". */
  layout?: string;
  /** Python packages from the Pyodide distribution to load. */
  pyodidePackages?: string[];
}

export interface LoadingProgress {
  stage: string;
  message: string;
  fraction: number;
}

export const DEFAULT_STARTUP_PACKAGES = ["vtk", "slicerweb-itk", "slicer-core", "slicer-modules-core", "slicerweb"];
export const PYODIDE_VERSION = "314.0.7";

interface WheelIndex {
  packages: { name: string; version: string; file: string }[];
}

/** Base64 of bytes, in pieces: a megabyte of arguments at once overflows the call stack. */
function toBase64(data: Uint8Array): string {
  const CHUNK = 0x8000;
  let text = "";
  for (let i = 0; i < data.length; i += CHUNK) {
    text += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(text);
}

/** A number of bytes, as it is written for a person to read ("1.2 GB"). */
/**
 * Why a download did not happen, in words that say what to do about it.
 *
 * A file is fetched from where it is, and where that is not allowed - most servers do not let
 * another site read their files - through this site, which fetches it instead. When that second
 * request fails without even a status, the usual reason is a redirect somewhere else: a site
 * behind a sign-in answers that way once the sign-in has expired. A page left open goes on working
 * (everything it needs is already loaded), so nothing says the session has ended until something
 * is asked for and does not arrive.
 */
async function downloadFailureReason(proxied: string, response: Response | null): Promise<string> {
  if (response && response.status) return `This site answered ${response.status} ${response.statusText}.`;
  const check = await fetch(proxied, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (check && (check.type === "opaqueredirect" || check.status === 0)) {
    return "The sign-in for this site has expired. Reload the page to sign in again, then try once more.";
  }
  if (check && !check.ok) return `This site answered ${check.status} ${check.statusText}.`;
  return "This site could not be reached.";
}

/**
 * Whether a file that another site holds may be fetched through this site.
 *
 * The development server fetches such a file for the page (most servers do not let another site
 * read their files), but a site that is only static files - the one published on GitHub Pages -
 * has nothing that could. There the files it offers are its own (see mirroredFiles), and asking
 * for a proxy that is not there would only turn a clear failure into a confusing one.
 */
const DOWNLOAD_PROXY = import.meta.env?.VITE_DOWNLOAD_PROXY !== "0";

/**
 * Files this site holds copies of, by the address they are published under elsewhere.
 *
 * Sample data lives on servers that do not allow cross-origin requests, so a site that has no
 * download proxy carries the files itself (web/scripts/mirror-sample-data.mjs writes both the
 * files and this map when the site is built). Missing map, or a file not in it: the download goes
 * to where the data set says it is.
 */
let mirror: Promise<Record<string, string>> | null = null;
function mirroredFiles(): Promise<Record<string, string>> {
  mirror ??= fetch(new URL("sample-data/mirror.json", document.baseURI).href)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return mirror;
}

export function formatBytes(bytes: number): string {
  if (!bytes) {
    return "unknown size";
  }
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 1 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export class SlicerRuntime {
  readonly bridge = new PyodideBridge();
  pyodide: PyodideAPI | null = null;
  private config: Required<RuntimeConfig>;
  private progressListeners = new Set<(p: LoadingProgress) => void>();

  constructor(config: RuntimeConfig = {}) {
    const base = new URL(".", document.baseURI).href;
    this.config = {
      pyodideURL: config.pyodideURL ?? base + "pyodide/",
      pyodidePackagesURL: config.pyodidePackagesURL ?? `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
      wheelsURL: config.wheelsURL ?? base + "wheels/",
      startupPackages: config.startupPackages ?? DEFAULT_STARTUP_PACKAGES,
      extensionWheels: config.extensionWheels ?? [],
      extensions: config.extensions ?? [],
      layout: config.layout ?? "FourUp",
      pyodidePackages: config.pyodidePackages ?? ["numpy", "micropip", "packaging"],
    };
    setBridge(this.bridge);
  }

  onProgress(listener: (p: LoadingProgress) => void) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private progress(stage: string, message: string, fraction: number) {
    for (const l of this.progressListeners) l({ stage, message, fraction });
  }

  async start(): Promise<void> {
    await this.ensureExtensions();
    this.progress("pyodide", "Loading Python runtime", 0.02);
    const { loadPyodide } = await import(/* @vite-ignore */ this.config.pyodideURL + "pyodide.mjs");
    const pyodide: PyodideAPI = await loadPyodide({
      indexURL: this.config.pyodideURL,
      packageBaseUrl: this.config.pyodidePackagesURL,
      stdout: (s: string) => this.bridge.events.emit("stdout", s),
      stderr: (s: string) => this.bridge.events.emit("stderr", s),
      env: { HOME: "/home/pyodide", SLICERWEB: "1" },
    } as any);
    this.pyodide = pyodide;

    // Events from Python (slicerweb.host.emit) are dispatched to the bridge event bus.
    // Work that takes long enough to be felt runs in a worker with a Python of its own
    // Downloads that module code asks for. Python cannot wait for one - it holds the thread the
    // page draws with - so it asks here and is called back (see slicerweb/downloads.py).
    pyodide.registerJsModule("slicerweb_downloads", {
      // Whether this site fetches files of other sites for the page: Python downloads synchronously
      // (slicerweb/downloads.py) and has to know, because a site without a proxy has other ways.
      proxy: DOWNLOAD_PROXY,
      download: (url: string, path: string,
                 onProgress: (received: number, total: number) => void,
                 onDone: (path: string) => void,
                 onFailed: (message: string) => void) => {
        const directory = path.slice(0, path.lastIndexOf("/"));
        this.downloadFile(url, path.split("/").pop(), directory || "/data/downloads", {
          onProgress: (received, total) => onProgress(received, total),
        })
          .then((written) => onDone(written))
          .catch((error: Error) => onFailed(String(error?.message ?? error)));
      },
    });

    pyodide.registerJsModule("slicerweb_jobs", {
      run: (specJson: string, onDone: (resultJson: string) => void, onFailed: (error: string) => void,
            onProgress?: (message: string, fraction: number) => void,
            onLog?: (level: string, message: string) => void) => {
        const spec = JSON.parse(specJson) as { code: string; globals?: Record<string, unknown>; outputs?: string[]; files?: Record<string, string>; packages?: string[] };
        const files: Record<string, Uint8Array> = {};
        for (const [path, base64] of Object.entries(spec.files ?? {})) {
          files[path] = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        }
        jobRunner(this.config.extensionWheels)
          .run({ code: spec.code, globals: spec.globals, outputs: spec.outputs, files, packages: spec.packages }, {
            onProgress: (message, fraction) => onProgress?.(message, fraction),
            onLog: (level, message) => {
              this.bridge.events.emit("job-log", { level, message });
              onLog?.(level, message);
            },
          })
          .then((result) => {
            const returned: Record<string, unknown> = { result: result.result, files: {} };
            for (const [path, data] of Object.entries(result.files)) {
              (returned.files as Record<string, string>)[path] = toBase64(data);
            }
            onDone(JSON.stringify(returned));
          })
          .catch((error: Error) => onFailed(String(error.message ?? error)));
      },
      cancel: () => jobRunner().cancel(),
      busy: () => jobRunner().busy,
      // Started before there is work for it, so that the first job does not wait for the wheels
      start: () => {
        void jobRunner(this.config.extensionWheels).start();
      },
    });

    pyodide.registerJsModule("slicerweb_host", {
      emit: (event: string, payloadJson: string) => this.bridge.dispatch(event, payloadJson),
      persistFileSystem: () => this.persistFileSystem(),
      // A package that Python will want shortly, fetched while the page goes on: a transform in the
      // scene means one may be saved as .h5, which needs h5py (see slicerweb/transforms_hdf5.py).
      // Python cannot wait for it - it holds the thread the page draws with - so it only asks.
      installPackage: (name: string) => {
        void this.ensurePythonPackage(name);
      },
      // slicer.app.extensionsManagerModel() (slicerweb/extensions_manager.py)
      extensionState: () => JSON.stringify(this.extensionState()),
      installExtension: (name: string) => this.installExtensionByName(name).catch((e) => {
        console.warn(`Installing ${name} failed`, e);
        return false;
      }),
      // processEvents() of Python code that may be suspended (slicerweb/yielding.py): resolved once
      // the browser has drawn a frame - the views render in it and the page is painted after it -
      // and then milliseconds more. A hidden page draws no frames: a timer stands in for the frame.
      waitForFrame: (milliseconds: number) => new Promise<void>((resolve) => {
        let done = false;
        const drawn = () => {
          if (done) return;
          done = true;
          setTimeout(resolve, milliseconds);
        };
        requestAnimationFrame(drawn);
        setTimeout(drawn, 100);
      }),
    });

    await this.mountPersistentStorage();

    this.progress("packages", "Loading Python packages", 0.08);
    await pyodide.loadPackage(this.config.pyodidePackages, { messageCallback: () => {} });

    const wheels = await this.resolveWheels();
    // Libraries of a wheel are loaded when it is installed; their dependencies (in the same or in
    // previously installed wheels) are found through the dynamic loader search path.
    const slicerVersion = /slicer_core-(\d+\.\d+)/.exec(wheels.map((w) => w.url).join(" "))?.[1] ?? "5.13";
    pyodide.runPython(`
import os, sysconfig
_sp = sysconfig.get_paths()["purelib"]
_dirs = [f"{_sp}/vtk_libs", f"{_sp}/slicerweb_itk", f"{_sp}/slicer_home/lib/Slicer-${slicerVersion}",
         f"{_sp}/slicer_home/lib/Slicer-${slicerVersion}/qt-loadable-modules"]
os.environ["LD_LIBRARY_PATH"] = ":".join(_dirs + [os.environ.get("LD_LIBRARY_PATH", "")])
`);
    const total = wheels.length || 1;
    for (let i = 0; i < wheels.length; i++) {
      const { name, url } = wheels[i];
      this.progress("wheels", `Loading ${name}`, 0.1 + (0.75 * i) / total);
      await this.installWheel(url);
    }

    this.progress("startup", "Starting 3D Slicer", 0.9);
    const init = pyodide.runPython(`
import json, slicerweb
from slicerweb import bridge
slicerweb.initialize(json.loads(${JSON.stringify(JSON.stringify({
      layout: this.config.layout,
      // The application settings the page keeps (Developer mode, say), as Slicer's own
      settings: loadSettings(),
      // display properties: markups glyphs and picking tolerance are sized for this screen
      devicePixelRatio: window.devicePixelRatio || 1,
      // A finger rather than a mouse (a phone, a tablet): the mouse mode starts as Scroll there
      touchScreen: !!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches,
      screenWidth: window.screen?.width ?? 0,
      screenHeight: window.screen?.height ?? 0,
    }))}))
bridge.call
`);
    // Calls that may run long are started so that Python can be suspended while the page draws,
    // where the browser has JavaScript Promise Integration (see bridge.ts callYielding)
    const jspi = !!(pyodide as any)._module?.jspiSupported;
    this.bridge.attach((method: string, args: string) => init(method, args),
      jspi ? (method: string, args: string) => init.callPromising(method, args) : null);
    this.bridge.missingModuleHandler = (name) => this.ensurePythonPackage(name);
    await this.loadExtensionPackages();
    await this.loadModulesWithPackages();
    this.started = true;
    // modules may ask which extensions there are (slicer.app.extensionsManagerModel()): the index
    // is fetched now, while nothing waits for it
    void this.extensionIndex();
    await this.dropLoadedLibraryFiles();
    this.progress("ready", "Ready", 1);
  }

  /**
   * Drop the files of the shared libraries that are loaded.
   *
   * A wheel is unpacked into the virtual file system, and each library in it is read from there
   * and compiled when it is loaded. The compiled library is what runs; the file's bytes are then
   * only in the way, and they are not few: 194 MB of a JS heap of 365 MB, in a tab that a phone
   * will reclaim as soon as another application is in front. A library that is loaded is never
   * read from its file again - the loader answers from what it holds - so the files go.
   *
   * Not every loaded library, though. Installing a wheel loads all of its libraries at once, but
   * a Python extension module among them is not imported until something imports it, and the
   * importer finds a module by its file: without the file, the import fails. So an extension
   * module's file goes only once Python has imported it; a plain library - VTK's kits, the Slicer
   * libraries - is never looked for by the importer, and goes as soon as it is loaded.
   */
  async dropLoadedLibraryFiles(): Promise<number> {
    const module = (this.pyodide as unknown as { _module?: { LDSO?: { loadedLibsByName?: Record<string, unknown> }; FS?: any } })?._module;
    const loaded = module?.LDSO?.loadedLibsByName;
    if (!loaded || !module?.FS) return 0;
    // Asked of Python directly: this also runs while the wheels are still being installed, before
    // the application (and with it the bridge) exists.
    const imported = new Set<string>(JSON.parse(this.pyodide!.runPython(
      'import sys, json; json.dumps([m.__file__ for m in list(sys.modules.values()) if getattr(m, "__file__", None) and m.__file__.endswith(".so")])')));
    let bytes = 0;
    for (const path of Object.keys(loaded)) {
      if (!path.startsWith("/") || !path.endsWith(".so")) continue;
      // An extension module is tagged (vtkCommonCore.cpython-314-wasm32-emscripten.so) or is a
      // wrapped kit of Slicer's or an extension's (MRMLCorePython.so, vtkvmtkMiscPython.so): what
      // a library is not, a library being lib-something (libMRMLCore.so). Some kits are imported
      // late - VMTK's by Extract Centerline, when it first runs - so their files must stay.
      const name = path.slice(path.lastIndexOf("/") + 1);
      const extensionModule = /\.cpython-[^/]*\.so$/.test(name) || !name.startsWith("lib");
      if (extensionModule && !imported.has(path)) continue;
      // A library loaded later names what it needs by file name alone, and the loader looks
      // that up among what is loaded before it searches the file system. Loaded libraries are
      // recorded by their path, so each is recorded by its name as well: a wheel installed after
      // this - an extension - then finds the kits it needs without their files.
      if (!(name in loaded)) loaded[name] = loaded[path];
      try {
        bytes += module.FS.stat(path).size;
        module.FS.unlink(path);
      } catch {
        // already gone
      }
    }
    return bytes;
  }

  private unavailablePackages = new Set<string>();

  /**
   * Make a Python package importable: from the Pyodide distribution (import or package name), else
   * from PyPI (pure Python or Pyodide-compatible wheels). Returns false if it is not available.
   */
  async ensurePythonPackage(name: string): Promise<boolean> {
    const pyodide = this.pyodide!;
    if (this.unavailablePackages.has(name)) return false;
    const importable = () =>
      pyodide.runPython(`import importlib.util; importlib.util.find_spec(${JSON.stringify(name.replace(/-/g, "_"))}) is not None`);
    this.progress("packages", `Installing Python package ${name}`, 1);
    try {
      // One of the packages built with Pyodide (NumPy, SciPy, h5py and the libraries they need),
      // which is asked for by name or by what it is imported as.
      try {
        await pyodide.loadPackagesFromImports(`import ${name.replace(/-/g, "_")}`, { messageCallback: () => {} });
        if (!importable()) await pyodide.loadPackage(name, { messageCallback: () => {} });
      } catch {
        // Not one of them (loadPackage says so by throwing): it may still be on PyPI, which is
        // where a package of pure Python - pydicom, say - comes from.
      }
      if (importable()) return true;
      const micropip = pyodide.pyimport("micropip");
      try {
        await micropip.install(name);
      } finally {
        micropip.destroy?.();
      }
      if (this.started) await this.dropLoadedLibraryFiles();
      return importable();
    } catch (e) {
      console.warn(`Python package ${name} is not available`, e);
      this.unavailablePackages.add(name);
      return false;
    } finally {
      this.progress("ready", "Ready", 1);
    }
  }

  /**
   * Load modules (e.g. of newly installed extensions). Scripted modules that need Python packages
   * that are not installed yet are loaded again after installing the packages.
   */
  async loadModulesWithPackages(reload = false): Promise<void> {
    if (reload) await this.bridge.call("loadModules");
    for (let round = 0; round < 3; round++) {
      const missing = await this.bridge.call<Record<string, string[]>>("getMissingPythonModules");
      const names = Object.keys(missing).filter((n) => !this.unavailablePackages.has(n));
      if (!names.length) return;
      let installed = false;
      for (const name of names) {
        console.info(`Modules ${missing[name].join(", ")} need Python package ${name}`);
        installed = (await this.ensurePythonPackage(name)) || installed;
      }
      if (!installed) return;
      await this.bridge.call("loadModules");
    }
  }

  /** Install a wheel from a URL (SlicerWeb wheels, extension wheels). */
  /**
   * Load the Pyodide packages the installed extensions ask for (slicerweb-extension.json).
   *
   * On the desktop an extension pip-installs what it needs; here the packages come from the
   * Pyodide distribution, and they have to be there before the module that needs them runs -
   * a module cannot install one itself, since installing is asynchronous and its code is not.
   */
  async loadExtensionPackages(): Promise<string[]> {
    const packages = await this.bridge.call<string[]>("getExtensionPythonPackages").catch(() => []);
    const missing = packages.filter((name) => !this.unavailablePackages.has(name));
    for (const name of missing) {
      await this.ensurePythonPackage(name);
    }
    return missing;
  }

  // ---------------------------------------------------------------- extensions asked for by modules
  private extensionIndexLoaded: { url: string; index: ExtensionIndex } | null = null;

  /** The extension index, fetched once (null where it is not available). */
  async extensionIndex(): Promise<{ url: string; index: ExtensionIndex } | null> {
    if (this.extensionIndexLoaded) return this.extensionIndexLoaded;
    try {
      const url = extensionIndexUrl();
      this.extensionIndexLoaded = { url, index: await loadExtensionIndex(url) };
    } catch (e) {
      console.warn("The extension index is not available", e);
    }
    return this.extensionIndexLoaded;
  }

  /** The wheels of the installed extensions, as the Extensions Manager keeps them. */
  private installedExtensionWheels(): string[] {
    try {
      return JSON.parse(localStorage.getItem(EXTENSIONS_KEY) ?? "null") ?? this.config.extensionWheels;
    } catch {
      return this.config.extensionWheels;
    }
  }

  /**
   * What slicer.app.extensionsManagerModel() tells modules (slicerweb/extensions_manager.py): the
   * extensions of the index, and which of them are installed. `indexLoaded` is false until the
   * index has been fetched (it is, shortly after startup).
   */
  extensionState(): { indexLoaded: boolean; available: string[]; installed: string[] } {
    const loaded = this.extensionIndexLoaded;
    if (!loaded) return { indexLoaded: false, available: [], installed: [] };
    const wheels = this.installedExtensionWheels();
    const entries = loaded.index.extensions;
    return {
      indexLoaded: true,
      available: entries.map((e) => e.name),
      installed: entries.filter((e) => wheels.includes(new URL(e.wheel, loaded.url).href)).map((e) => e.name),
    };
  }

  /**
   * Install an extension of the index by its name, with what it depends on and requires, as the
   * Extensions Manager does, and load its modules. False if the index does not have it.
   */
  async installExtensionByName(name: string): Promise<boolean> {
    const loaded = await this.extensionIndex();
    if (!loaded) return false;
    const { wheels, unknown } = await resolveExtensionWheels([name], loaded.index, loaded.url, (base) => this.baseWheelUrl(base));
    if (unknown.some((n) => n.toLowerCase() === name.toLowerCase())) return false;
    let installed = this.installedExtensionWheels();
    const missing = wheels.filter((url) => !installed.includes(url));
    for (const url of missing) {
      await this.installWheel(url);
      installed = [...installed, url];
      try {
        localStorage.setItem(EXTENSIONS_KEY, JSON.stringify(installed));
      } catch {
        // a private window, say: installed for this page
      }
    }
    if (missing.length) {
      await this.loadExtensionPackages();
      await this.loadModulesWithPackages(true);
    }
    return true;
  }

  async installWheel(url: string): Promise<void> {
    const pyodide = this.pyodide!;
    const micropip = pyodide.pyimport("micropip");
    try {
      await micropip.install(url, { deps: false });
    } finally {
      micropip.destroy?.();
    }
    // A wheel installed once the application runs - an extension - is unpacked into the file
    // system like the others; what it loaded is dropped the same way. During the start the wheels
    // are dropped together, once everything is loaded (see start()).
    if (this.started) await this.dropLoadedLibraryFiles();
  }

  /** URL of a SlicerWeb wheel by distribution name (e.g. "slicerweb-itk-extra"), from the wheel index. */
  async baseWheelUrl(name: string): Promise<string | null> {
    const response = await fetch(this.config.wheelsURL + "index.json");
    if (!response.ok) return null;
    const index: WheelIndex = await response.json();
    const entry = index.packages.find((p) => p.name === name);
    return entry ? new URL(this.config.wheelsURL + entry.file, document.baseURI).href : null;
  }

  /**
   * The extensions asked for by name (config.extensions, from `?extensions=` on the address) join
   * the installed ones: their wheels, with what they depend on, are installed at this start and
   * remembered as the Extensions Manager remembers an installation, so that they stay installed.
   */
  private async ensureExtensions() {
    if (!this.config.extensions.length) return;
    this.progress("extensions", "Resolving extensions", 0.01);
    try {
      const indexUrl = extensionIndexUrl();
      const index = await loadExtensionIndex(indexUrl);
      const { wheels, unknown } = await resolveExtensionWheels(this.config.extensions, index, indexUrl, (name) => this.baseWheelUrl(name));
      if (unknown.length) console.warn(`Extensions not in ${indexUrl}: ${unknown.join(", ")}`);
      const missing = wheels.filter((url) => !this.config.extensionWheels.includes(url));
      if (!missing.length) return;
      this.config.extensionWheels = [...this.config.extensionWheels, ...missing];
      try {
        localStorage.setItem(EXTENSIONS_KEY, JSON.stringify(this.config.extensionWheels));
      } catch {
        // a private window, say: installed for this page
      }
    } catch (e) {
      console.warn("The extensions asked for could not be resolved", e);
    }
  }

  private async resolveWheels(): Promise<{ name: string; url: string }[]> {
    let index: WheelIndex = { packages: [] };
    try {
      const response = await fetch(this.config.wheelsURL + "index.json");
      if (response.ok) index = await response.json();
    } catch (e) {
      console.warn("Wheel index not available", e);
    }
    const result: { name: string; url: string }[] = [];
    for (const name of this.config.startupPackages) {
      const entry = index.packages.find((p) => p.name === name);
      if (entry) result.push({ name, url: this.config.wheelsURL + entry.file });
      else console.warn(`Wheel ${name} not found in ${this.config.wheelsURL}index.json`);
    }
    for (const url of this.config.extensionWheels) {
      result.push({ name: url.split("/").pop() ?? url, url });
    }
    return result;
  }

  /** Settings and user data survive page reloads (IndexedDB). */
  private async mountPersistentStorage() {
    const FS = this.pyodide!.FS;
    for (const dir of ["/home/pyodide/.config", "/home/pyodide/SlicerData"]) {
      FS.mkdirTree(dir);
      FS.mount(FS.filesystems.IDBFS, {}, dir);
    }
    await new Promise<void>((resolve) => FS.syncfs(true, () => resolve()));
  }

  /** Set once the start is complete: wheels installed after that are extensions. */
  private started = false;
  private persistTimer: number | undefined;
  persistFileSystem() {
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.pyodide?.FS.syncfs(false, () => {}), 500);
  }

  /** Write what is pending to IndexedDB now, for the moments when there may be no later. */
  flushPersistentStorage(): Promise<void> {
    window.clearTimeout(this.persistTimer);
    return new Promise((resolve) => (this.pyodide ? this.pyodide.FS.syncfs(false, () => resolve()) : resolve()));
  }

  // ------------------------------------------------------------------ files
  /** Copy browser files (file picker, drag and drop) into the virtual file system. */
  async writeFiles(files: File[], directory = "/data"): Promise<string[]> {
    const FS = this.pyodide!.FS;
    const stamp = Date.now().toString(36);
    const dir = `${directory}/${stamp}`;
    FS.mkdirTree(dir);
    const paths: string[] = [];
    for (const file of files) {
      const rel = (file as any).webkitRelativePath || file.name;
      const path = `${dir}/${rel}`;
      FS.mkdirTree(path.substring(0, path.lastIndexOf("/")));
      FS.writeFile(path, new Uint8Array(await file.arrayBuffer()));
      paths.push(path);
    }
    return paths;
  }

  /** Download a URL into the virtual file system. */
  /**
   * Fetch a file into the virtual file system, reporting how far along it is.
   *
   * The data arrives in chunks rather than in one piece: a large data set would otherwise be held
   * twice over (once as the response, once in the file system) before anything could be said about
   * it, and there would be nothing to show while it downloads. *onProgress* is called with the
   * bytes received and the size, where the server said what the size is.
   *
   * *tooLarge* is asked before anything is downloaded, when the size is known and above
   * *warnAboveBytes*; answering false gives up. Files of a gigabyte or more are on the edge of what
   * a browser tab can hold - and reading one into a scene needs about as much again.
   */
  async downloadFile(url: string, fileName?: string, directory = "/data/downloads",
                     options: {
                       onProgress?: (received: number, total: number) => void;
                       tooLarge?: (total: number, name: string) => boolean | Promise<boolean>;
                       warnAboveBytes?: number;
                     } = {}): Promise<string> {
    const copy = (await mirroredFiles())[url];
    const from = copy ? new URL("sample-data/" + copy, document.baseURI).href : url;
    let response: Response | null = null;
    try {
      response = await fetch(from);
    } catch {
      response = null; // other origin without cross-origin headers: use the download proxy
    }
    if (!response || !response.ok) {
      if (!DOWNLOAD_PROXY) {
        throw new Error(`Download failed: ${url}
This site holds no copy of this file and cannot fetch it from another site.`);
      }
      const proxied = new URL("download?url=" + encodeURIComponent(new URL(url, document.baseURI).href), document.baseURI).href;
      const previous = response;
      response = await fetch(proxied).catch(() => null);
      if (!response || !response.ok) {
        throw new Error(`Download failed: ${url}
${await downloadFailureReason(proxied, response ?? previous)}`);
      }
    }
    const name = fileName ?? decodeURIComponent(new URL(url, document.baseURI).pathname.split("/").pop() || "download");
    const total = Number(response.headers.get("content-length") ?? 0);
    const warnAbove = options.warnAboveBytes ?? 512 * 1024 * 1024;
    if (total > warnAbove && options.tooLarge && !(await options.tooLarge(total, name))) {
      throw new Error(`${name} (${formatBytes(total)}) was not downloaded.`);
    }

    const FS = this.pyodide!.FS;
    FS.mkdirTree(directory);
    const path = `${directory}/${name}`;
    const reader = response.body?.getReader();
    if (!reader) {
      // a response that cannot be read in pieces (an older browser): all at once, as before
      FS.writeFile(path, new Uint8Array(await response.arrayBuffer()));
      options.onProgress?.(total, total);
      return path;
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    options.onProgress?.(0, total);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      options.onProgress?.(received, total);
    }
    const data = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
      // the pieces are released as they are copied, so that only one whole copy is held
      chunk.fill(0, 0, 0);
    }
    chunks.length = 0;
    FS.writeFile(path, data);
    return path;
  }

  /** Offer a file of the virtual file system as a browser download. */
  saveFileToDisk(path: string) {
    const data: Uint8Array = this.pyodide!.FS.readFile(path);
    const blob = new Blob([data.slice().buffer]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = path.split("/").pop() ?? "file";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
}

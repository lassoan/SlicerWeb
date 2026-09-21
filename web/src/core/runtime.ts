/**
 * SlicerWeb runtime: loads Pyodide (CPython compiled to WebAssembly), installs the SlicerWeb wheels
 * (VTK, ITK, Slicer libraries and modules, extensions) and starts the Slicer application.
 */
import type { PyodideAPI } from "pyodide";
import { PyodideBridge, setBridge } from "./bridge";
import { jobRunner } from "./jobs";

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
    });

    pyodide.registerJsModule("slicerweb_host", {
      emit: (event: string, payloadJson: string) => this.bridge.dispatch(event, payloadJson),
      persistFileSystem: () => this.persistFileSystem(),
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
      // display properties: markups glyphs and picking tolerance are sized for this screen
      devicePixelRatio: window.devicePixelRatio || 1,
      screenWidth: window.screen?.width ?? 0,
      screenHeight: window.screen?.height ?? 0,
    }))}))
bridge.call
`);
    this.bridge.attach((method: string, args: string) => init(method, args));
    this.bridge.missingModuleHandler = (name) => this.ensurePythonPackage(name);
    await this.loadExtensionPackages();
    await this.loadModulesWithPackages();
    this.progress("ready", "Ready", 1);
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
      await pyodide.loadPackagesFromImports(`import ${name.replace(/-/g, "_")}`, { messageCallback: () => {} });
      if (!importable()) await pyodide.loadPackage(name, { messageCallback: () => {} });
      if (importable()) return true;
      const micropip = pyodide.pyimport("micropip");
      try {
        await micropip.install(name);
      } finally {
        micropip.destroy?.();
      }
      return true;
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

  async installWheel(url: string): Promise<void> {
    const pyodide = this.pyodide!;
    const micropip = pyodide.pyimport("micropip");
    try {
      await micropip.install(url, { deps: false });
    } finally {
      micropip.destroy?.();
    }
  }

  /** URL of a SlicerWeb wheel by distribution name (e.g. "slicerweb-itk-extra"), from the wheel index. */
  async baseWheelUrl(name: string): Promise<string | null> {
    const response = await fetch(this.config.wheelsURL + "index.json");
    if (!response.ok) return null;
    const index: WheelIndex = await response.json();
    const entry = index.packages.find((p) => p.name === name);
    return entry ? new URL(this.config.wheelsURL + entry.file, document.baseURI).href : null;
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

  private persistTimer: number | undefined;
  persistFileSystem() {
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.pyodide?.FS.syncfs(false, () => {}), 500);
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
    let response: Response | null = null;
    try {
      response = await fetch(url);
    } catch {
      response = null; // other origin without cross-origin headers: use the download proxy
    }
    if (!response || !response.ok) {
      const proxied = new URL("download?url=" + encodeURIComponent(new URL(url, document.baseURI).href), document.baseURI).href;
      const previous = response;
      response = await fetch(proxied).catch(() => null);
      if (!response || !response.ok) {
        throw new Error(`Download failed (${response?.status ?? previous?.status ?? "no response"}): ${url}`);
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

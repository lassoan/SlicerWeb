/**
 * SlicerWeb runtime: loads Pyodide (CPython compiled to WebAssembly), installs the SlicerWeb wheels
 * (VTK, ITK, Slicer libraries and modules, extensions) and starts the Slicer application.
 */
import type { PyodideAPI } from "pyodide";
import { PyodideBridge, setBridge } from "./bridge";

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
slicerweb.initialize(json.loads(${JSON.stringify(JSON.stringify({ layout: this.config.layout }))}))
bridge.call
`);
    this.bridge.attach((method: string, args: string) => init(method, args));
    this.progress("ready", "Ready", 1);
  }

  /** Install a wheel from a URL (SlicerWeb wheels, extension wheels). */
  async installWheel(url: string): Promise<void> {
    const pyodide = this.pyodide!;
    const micropip = pyodide.pyimport("micropip");
    try {
      await micropip.install(url, { deps: false });
    } finally {
      micropip.destroy?.();
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
  async downloadFile(url: string, fileName?: string, directory = "/data/downloads"): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const name = fileName ?? decodeURIComponent(new URL(url, document.baseURI).pathname.split("/").pop() || "download");
    const FS = this.pyodide!.FS;
    FS.mkdirTree(directory);
    const path = `${directory}/${name}`;
    FS.writeFile(path, new Uint8Array(await response.arrayBuffer()));
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

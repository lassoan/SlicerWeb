/**
 * Worker that runs Slicer computations away from the page.
 *
 * The page runs the application: its scene, its views and everything that draws. Work that takes
 * long enough to be felt - meshing, a CLI module - runs here instead, in a Python of its own with
 * the same SlicerWeb wheels, so that the views keep drawing while it runs. This is what a CLI module
 * is in desktop Slicer: a separate program given its inputs as files and asked for its outputs.
 *
 * Messages in: {type:"start", config}, {type:"run", id, code, globals, files, outputs},
 * {type:"cancel"}. Messages out: {type:"ready"}, {type:"progress", id, message, fraction},
 * {type:"log", id, level, message}, {type:"done", id, result, files}, {type:"failed", id, error}.
 */

interface StartMessage {
  type: "start";
  pyodideURL: string;
  pyodidePackagesURL: string;
  wheels: string[];
  slicerVersion: string;
  pyodidePackages: string[];
}

interface RunMessage {
  type: "run";
  id: string;
  /** Python to execute; what it puts in the variable "result" is returned. */
  code: string;
  /** Values made available to the code as globals (JSON). */
  globals?: Record<string, unknown>;
  /** Files written into the worker's file system before the code runs. */
  files?: Record<string, Uint8Array>;
  /** Files read back and returned after it. */
  outputs?: string[];
}

type Message = StartMessage | RunMessage | { type: "cancel" };

let pyodide: any = null;
let starting: Promise<void> | null = null;

function post(message: Record<string, unknown>, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(message, transfer);
}

async function start(message: StartMessage) {
  const { loadPyodide } = await import(/* @vite-ignore */ message.pyodideURL + "pyodide.mjs");
  pyodide = await loadPyodide({
    indexURL: message.pyodideURL,
    packageBaseUrl: message.pyodidePackagesURL,
    stdout: (text: string) => post({ type: "log", level: "INFO", message: text }),
    stderr: (text: string) => post({ type: "log", level: "ERROR", message: text }),
    env: { HOME: "/home/pyodide", SLICERWEB: "1", SLICERWEB_JOB: "1" },
  });

  // The libraries of the wheels find each other through the loader search path, as in the page.
  pyodide.runPython(`
import os, sysconfig
_sp = sysconfig.get_paths()["purelib"]
_dirs = [f"{_sp}/vtk_libs", f"{_sp}/slicerweb_itk", f"{_sp}/slicer_home/lib/Slicer-${message.slicerVersion}",
         f"{_sp}/slicer_home/lib/Slicer-${message.slicerVersion}/qt-loadable-modules"]
os.environ["LD_LIBRARY_PATH"] = ":".join(_dirs + [os.environ.get("LD_LIBRARY_PATH", "")])
`);
  await pyodide.loadPackage(message.pyodidePackages, { messageCallback: () => {} });
  const micropip = pyodide.pyimport("micropip");
  for (const wheel of message.wheels) {
    post({ type: "progress", message: `Loading ${wheel.split("/").pop()}`, fraction: 0.5 });
    await micropip.install(wheel, { keep_going: true });
  }
  // What a job reports while it runs: slicerweb job progress goes back to the page.
  pyodide.registerJsModule("slicerweb_job", {
    progress: (message: string, fraction: number) => post({ type: "progress", message, fraction }),
    log: (level: string, message: string) => post({ type: "log", level, message }),
  });
  // The modules of Slicer and of the extensions are importable here as they are in the page: the
  // scripted modules by name, and the wrapped C++ classes of loadable modules beside them.
  pyodide.runPython(`
import sys, sysconfig
_sp = sysconfig.get_paths()["purelib"]
for _dir in (f"{_sp}/slicer_home/lib/Slicer-${message.slicerVersion}",
             f"{_sp}/slicer_home/lib/Slicer-${message.slicerVersion}/qt-loadable-modules",
             f"{_sp}/slicer_home/lib/Slicer-${message.slicerVersion}/qt-scripted-modules"):
    if _dir not in sys.path:
        sys.path.append(_dir)
`);
  // Where a job writes what it makes; the page asks for those files back by path.
  pyodide.FS.mkdirTree("/work");
  post({ type: "ready" });
}

async function run(message: RunMessage) {
  if (starting) await starting;
  try {
    for (const [path, data] of Object.entries(message.files ?? {})) {
      const directory = path.slice(0, path.lastIndexOf("/"));
      if (directory) pyodide.FS.mkdirTree(directory);
      pyodide.FS.writeFile(path, data);
    }
    const globals = pyodide.toPy({ ...(message.globals ?? {}), result: null });
    await pyodide.runPythonAsync(message.code, { globals });
    const result = globals.get("result");
    const files: Record<string, Uint8Array> = {};
    for (const path of message.outputs ?? []) {
      try {
        files[path] = pyodide.FS.readFile(path);
      } catch {
        // an output the job did not write: the caller sees it missing
      }
    }
    post(
      { type: "done", id: message.id, result: result?.toJs ? result.toJs({ dict_converter: Object.fromEntries }) : result, files },
      Object.values(files).map((f) => f.buffer),
    );
    result?.destroy?.();
    globals.destroy();
  } catch (error) {
    post({ type: "failed", id: message.id, error: String((error as Error)?.message ?? error) });
  }
}

self.onmessage = async (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === "start") {
    starting = start(message).catch((error) => {
      post({ type: "failed", error: String(error?.message ?? error) });
    });
    await starting;
  } else if (message.type === "run") {
    await run(message);
  } else if (message.type === "cancel") {
    // Nothing finer is possible: Python in a worker cannot be interrupted between bytecodes here,
    // so the worker is ended by the page and a new one is started for the next job.
    self.close();
  }
};

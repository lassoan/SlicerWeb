// Run a Python script inside Pyodide (Node.js) with SlicerWeb install trees mounted.
//
// Usage: node pyodide_run.mjs <script.py> [--mount hostDir:pyodideDir]... [--libpath dir]...
//
// Host directories are mounted with NODEFS. --libpath directories are added to the dynamic linker
// search path (LD_LIBRARY_PATH of the Emscripten runtime) so that shared library dependencies of
// Python extension modules are found, the same way they are found inside installed wheels.
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const script = args.shift();
const mounts = [];
const libPaths = [];
const pyPaths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--mount") mounts.push(args[++i].split(":"));
  else if (args[i] === "--libpath") libPaths.push(args[++i]);
  else if (args[i] === "--pypath") pyPaths.push(args[++i]);
}

const pyodideRoot = process.env.PYODIDE_ROOT;
const distDir = path.join(pyodideRoot, "dist");
const { loadPyodide } = await import(path.join(distDir, "pyodide.mjs"));

const pyodide = await loadPyodide({
  indexURL: distDir + "/",
  stdout: (s) => console.log(s),
  stderr: (s) => console.error(s),
});

const FS = pyodide.FS;
for (const [host, target] of mounts) {
  FS.mkdirTree(target);
  FS.mount(FS.filesystems.NODEFS, { root: host }, target);
}
// Pyodide sets LD_LIBRARY_PATH at startup; the dynamic loader reads it at lookup time.
pyodide.runPython(`
import os, sys
sys.path[:0] = ${JSON.stringify(pyPaths)}
_extra = ${JSON.stringify(libPaths.join(":"))}
if _extra:
    os.environ["LD_LIBRARY_PATH"] = _extra + ":" + os.environ.get("LD_LIBRARY_PATH", "")
`);

const code = readFileSync(script, "utf8");
try {
  await pyodide.runPythonAsync(code);
  console.log("SMOKE: PASS");
} catch (e) {
  console.error(String(e));
  console.log("SMOKE: FAIL");
  process.exit(1);
}

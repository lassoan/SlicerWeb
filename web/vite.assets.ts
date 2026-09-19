import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import samples from "./src/app/sampleData.json";
// @ts-expect-error plain JavaScript build script
import { preparePyodide } from "./scripts/prepare-pyodide.mjs";

/**
 * Serves and packages the runtime assets that are not JavaScript modules:
 *  - /pyodide/*  : Pyodide core files from the "pyodide" npm package, with the dynamic linker patches
 *                  of scripts/prepare-pyodide.mjs (needed for fast loading of ~300 shared libraries)
 *  - /wheels/*   : SlicerWeb wheels (VTK, ITK, Slicer libraries, modules, extensions)
 *  - /sample-data/* : optional local sample data
 *
 * Wheels are taken from $SLICERWEB_WHEELS (default: D:/SlicerWeb-build/dist/wheels).
 */
export function slicerWebAssets(): Plugin {
  const pyodideDir = path.resolve("node_modules/.slicerweb-pyodide");
  preparePyodide(path.resolve("node_modules/pyodide"), pyodideDir);
  const wheelsDir = path.resolve(process.env.SLICERWEB_WHEELS ?? "D:/SlicerWeb-build/dist/wheels");
  const sampleDir = path.resolve(process.env.SLICERWEB_SAMPLE_DATA ?? "D:/SlicerWeb-build/dist/sample-data");
  const mounts: Record<string, string> = {
    "/pyodide/": pyodideDir,
    "/wheels/": wheelsDir,
    "/sample-data/": sampleDir,
  };

  const contentType = (file: string) => {
    if (file.endsWith(".wasm")) return "application/wasm";
    if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript";
    if (file.endsWith(".json")) return "application/json";
    if (file.endsWith(".whl") || file.endsWith(".zip")) return "application/zip";
    return "application/octet-stream";
  };

  return {
    name: "slicerweb-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]);
        for (const [prefix, dir] of Object.entries(mounts)) {
          if (!url.startsWith(prefix)) continue;
          const rel = url.slice(prefix.length);
          const file = path.join(dir, rel);
          if (!file.startsWith(dir)) break;
          if (rel === "index.json" && prefix === "/wheels/") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(listWheels(dir)));
            return;
          }
          if (prefix === "/sample-data/" && !fs.existsSync(file)) {
            const sample = samples.find((s) => s.fileName === rel);
            if (sample) {
              downloadTo(sample.sourceUrl, file)
                .then(() => {
                  res.setHeader("Content-Type", "application/octet-stream");
                  fs.createReadStream(file).pipe(res);
                })
                .catch((e) => {
                  res.statusCode = 502;
                  res.end(String(e));
                });
              return;
            }
          }
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            res.setHeader("Content-Type", contentType(file));
            res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
            fs.createReadStream(file).pipe(res);
            return;
          }
        }
        next();
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? "dist/app";
      for (const [prefix, dir] of Object.entries(mounts)) {
        if (!fs.existsSync(dir)) continue;
        const target = path.join(outDir, prefix);
        fs.mkdirSync(target, { recursive: true });
        for (const name of fs.readdirSync(dir)) {
          const src = path.join(dir, name);
          if (!fs.statSync(src).isFile()) continue;
          if (prefix === "/pyodide/" && !/\.(mjs|js|wasm|json|zip|d\.ts)$/.test(name)) continue;
          fs.copyFileSync(src, path.join(target, name));
        }
        if (prefix === "/wheels/") {
          fs.writeFileSync(path.join(target, "index.json"), JSON.stringify(listWheels(dir), null, 1));
        }
      }
    },
  };
}

/** Download a file (server side, no CORS restrictions) into the local sample data cache. */
export async function downloadTo(url: string, file: string) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".part", Buffer.from(await response.arrayBuffer()));
  fs.renameSync(file + ".part", file);
}

/** Wheel index: {packages: [{name, version, file}]} */
function listWheels(dir: string) {
  if (!fs.existsSync(dir)) return { packages: [] };
  const packages = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".whl"))
    .map((file) => {
      const [name, version] = file.split("-");
      return { name: name.replace(/_/g, "-"), version, file };
    });
  return { packages };
}

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
 *  - /extensions/*  : extension wheels and their index (index.json), read by the Extensions Manager
 *  - /download?url= : downloads a file for the page (sample data of modules is hosted on servers that
 *                     do not allow cross-origin requests)
 *
 * Wheels are taken from $SLICERWEB_WHEELS (default: D:/SlicerWeb-build/dist/wheels).
 */
export function slicerWebAssets(): Plugin {
  const pyodideDir = path.resolve("node_modules/.slicerweb-pyodide");
  preparePyodide(path.resolve("node_modules/pyodide"), pyodideDir);
  const wheelsDir = path.resolve(process.env.SLICERWEB_WHEELS ?? "D:/SlicerWeb-build/dist/wheels");
  const sampleDir = path.resolve(process.env.SLICERWEB_SAMPLE_DATA ?? "D:/SlicerWeb-build/dist/sample-data");
  const extensionsDir = path.resolve(process.env.SLICERWEB_EXTENSIONS ?? "D:/SlicerWeb-build/dist/extensions");
  const mounts: Record<string, string> = {
    "/pyodide/": pyodideDir,
    "/wheels/": wheelsDir,
    "/sample-data/": sampleDir,
    "/extensions/": extensionsDir,
  };

  const contentType = (file: string) => {
    if (file.endsWith(".wasm")) return "application/wasm";
    if (file.endsWith(".mjs") || file.endsWith(".js")) return "text/javascript";
    if (file.endsWith(".json")) return "application/json";
    if (file.endsWith(".whl") || file.endsWith(".zip")) return "application/zip";
    return "application/octet-stream";
  };

  /** Downloads a file server side and sends it to the page (no cross-origin restrictions). */
  const downloadProxy = (req: any, res: any, next: any) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (!url.pathname.startsWith("/download")) return next();
    const target = url.searchParams.get("url");
    if (!target || !/^https?:\/\//.test(target)) {
      res.statusCode = 400;
      res.end("download: url parameter is missing or not http(s)");
      return;
    }
    fetch(target, { redirect: "follow" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        res.setHeader("Content-Type", response.headers.get("content-type") ?? "application/octet-stream");
        res.end(Buffer.from(await response.arrayBuffer()));
      })
      .catch((e) => {
        res.statusCode = 502;
        res.end(`download failed: ${e}`);
      });
  };

  const serveMounts = (req: any, res: any, next: any) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]);
        for (const [prefix, dir] of Object.entries(mounts)) {
          if (!url.startsWith(prefix)) continue;
          const rel = url.slice(prefix.length);
          const file = path.join(dir, rel);
          if (!file.startsWith(dir)) break;
          if (rel === "index.json" && prefix === "/wheels/") {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-cache");
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
            const stat = fs.statSync(file);
            res.setHeader("Content-Type", contentType(file));
            res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
            // A rebuilt wheel keeps its name, so it must never be served from a cache (the browser's
            // or one in front of the site) without asking: the tag changes whenever the file does.
            const tag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
            res.setHeader("ETag", tag);
            res.setHeader("Last-Modified", stat.mtime.toUTCString());
            res.setHeader("Cache-Control", "no-cache");
            if (req.headers["if-none-match"] === tag) {
              res.statusCode = 304;
              res.end();
              return;
            }
            fs.createReadStream(file).pipe(res);
            return;
          }
        }
    next();
  };

  // The build, as a stamp: unique to each publish (the workflow run where there is one, else the
  // moment), because a publish can change the wheels without changing anything else, and the
  // service worker and the page both have to be able to tell one publish from another.
  const build = process.env.GITHUB_RUN_ID ?? Date.now().toString(36);

  return {
    name: "slicerweb-assets",
    transformIndexHtml(html) {
      return html.replace("</head>", `  <meta name="slicerweb-build" content="${build}" />\n  </head>`);
    },
    configureServer(server) {
      server.middlewares.use(downloadProxy);
      server.middlewares.use(serveMounts);
    },
    configurePreviewServer(server) {
      server.middlewares.use(downloadProxy);
      server.middlewares.use(serveMounts);
    },
    writeBundle(options) {
      const outDir = options.dir ?? "dist/app";
      // The service worker, stamped with the build: its cache is named after it, so a new build
      // starts an empty cache rather than serving the wheels of the old one under their unchanged
      // names (see src/sw.js).
      fs.writeFileSync(path.join(outDir, "sw.js"),
        fs.readFileSync(path.resolve("src/sw.js"), "utf8").replace("__BUILD__", build));
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

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { slicerWebAssets } from "./vite.assets";
import { slicerWebXR } from "./vite.xr";

/** The commit of SlicerWeb the application is built from ("" outside a checkout), with "+" when files
 *  of it differ from that commit. Shown with the build info of the runtime (the application menu).
 *  SLICERWEB_APP_VERSION gives it where the sources are a copy (slicerweb.py builds in a copy of web/
 *  outside the checkout, where npm's files can go). */
function appVersion() {
  if (process.env.SLICERWEB_APP_VERSION !== undefined) return process.env.SLICERWEB_APP_VERSION;
  try {
    const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const modified = execSync("git status --porcelain --untracked-files=no", { encoding: "utf8" }).trim() !== "";
    return commit + (modified ? "+" : "");
  } catch {
    return "";
  }
}

// The web application. Wheels built by the SlicerWeb toolchain are served from /wheels
// (copied from D:\SlicerWeb-build\dist\wheels), Pyodide from /pyodide.
export default defineConfig({
  base: "./",
  plugins: [vue(), tailwindcss(), slicerWebAssets(), slicerWebXR()],
  define: { __SLICERWEB_APP_VERSION__: JSON.stringify(appVersion()) },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // No cross-origin isolation headers: Pyodide runs without SharedArrayBuffer, and COEP would block
  // resources behind authenticating proxies (e.g. Cloudflare Access) and CDNs.
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  build: { outDir: "dist/app", target: "es2022", chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ["pyodide"] },
  worker: { format: "es" },
});

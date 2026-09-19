import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { slicerWebAssets } from "./vite.assets";

// The web application. Wheels built by the SlicerWeb toolchain are served from /wheels
// (copied from D:\SlicerWeb-build\dist\wheels), Pyodide from /pyodide.
export default defineConfig({
  base: "./",
  plugins: [vue(), tailwindcss(), slicerWebAssets()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // No cross-origin isolation headers: Pyodide runs without SharedArrayBuffer, and COEP would block
  // resources behind authenticating proxies (e.g. Cloudflare Access) and CDNs.
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  build: { outDir: "dist/app", target: "es2022", chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ["pyodide"] },
  worker: { format: "es" },
});

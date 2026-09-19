import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Slicer web widgets as standard custom elements (<sw-node-selector>, <sw-slider>, ...).
// This bundle is framework independent: it is used by module GUIs in the browser and, through
// QtWebEngine, in desktop 3D Slicer (SlicerWebWidgets extension).
export default defineConfig({
  plugins: [vue({ customElement: true }), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist/widgets",
    assetsInlineLimit: 0,
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./src/widgets/custom-elements.ts", import.meta.url)),
      name: "SlicerWebWidgets",
      formats: ["es", "iife"],
      fileName: (format) => (format === "es" ? "slicerweb-widgets.mjs" : "slicerweb-widgets.js"),
    },
  },
});

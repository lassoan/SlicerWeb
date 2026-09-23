import { createApp, watch } from "vue";
import { extensionsFromAddress } from "./core/extensions";
import "./styles/main.css";
import App from "./app/App.vue";
import { store } from "./app/store";
import { SlicerRuntime } from "./core/runtime";
import { registerSlicerWidgets } from "./widgets/custom-elements";
import { installGLDiagnostics } from "./core/glDiagnostics";

// Watch for shaders that will not build, from the first frame on (drivers differ, and VTK does not
// always pass on what the driver said)
installGLDiagnostics();

// Slicer web widgets as custom elements, used by Python scripted module GUIs (slicerweb.qtcompat)
registerSlicerWidgets();

const params = new URLSearchParams(location.search);
export const runtime = new SlicerRuntime({
  layout: params.get("layout") ?? "FourUp",
  extensionWheels: JSON.parse(localStorage.getItem("slicerweb.extensions") ?? "[]"),
  // ?extensions=SlicerHeart,SlicerIGT: installed at this start if they are not yet
  extensions: extensionsFromAddress(),
});

createApp(App).provide("runtime", runtime).mount("#app");

// What a start needs is kept in the browser by a service worker (src/sw.js), so that a restart -
// a phone reclaiming the tab, say - is quick and works without a network. Only the built site has
// one: the development server serves fresh files, and a cache in front of it would hide changes.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // A new build's worker takes over as soon as it is installed. If that happens while this page
  // is starting, what it has fetched so far came from the old build's cache, so it starts again -
  // once, and only when there was an old worker to take over from (a first visit has none).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded && store.status !== "ready") {
      reloaded = true;
      location.reload();
    }
  });
  navigator.serviceWorker.register(new URL("sw.js", document.baseURI).href, { scope: new URL("./", document.baseURI).pathname })
    .catch((error) => console.warn("The service worker could not be installed", error));

  // The very first start fetched everything with no worker in charge to see it. Once that start
  // is done, the worker is handed the list of what was loaded - the page, its files, the runtime,
  // the wheels - so the next start, even one without a network, has it all.
  const stop = watch(() => store.status, async (status) => {
    if (status !== "ready") return;
    stop();
    const registration = await navigator.serviceWorker.ready;
    const urls = performance.getEntriesByType("resource").map((entry) => entry.name);
    registration.active?.postMessage({ type: "keep", urls: [new URL("./", document.baseURI).href, ...urls] });
  });
}

// Debugging and automated tests: window.slicerWeb.bridge.evalPython("..."), window.slicerWeb.store
(window as unknown as { slicerWeb: SlicerRuntime & { store: typeof store } }).slicerWeb =
  Object.assign(runtime, { store });

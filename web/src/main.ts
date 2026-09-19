import { createApp } from "vue";
import "./styles/main.css";
import App from "./app/App.vue";
import { SlicerRuntime } from "./core/runtime";
import { registerSlicerWidgets } from "./widgets/custom-elements";

// Slicer web widgets as custom elements, used by Python scripted module GUIs (slicerweb.qtcompat)
registerSlicerWidgets();

const params = new URLSearchParams(location.search);
export const runtime = new SlicerRuntime({
  layout: params.get("layout") ?? "FourUp",
  extensionWheels: JSON.parse(localStorage.getItem("slicerweb.extensions") ?? "[]"),
});

createApp(App).provide("runtime", runtime).mount("#app");

// Debugging and automated tests: window.slicerWeb.bridge.evalPython("...")
(window as unknown as { slicerWeb: SlicerRuntime }).slicerWeb = runtime;

// The configuration of the application (wheels/application.json) is read first: the defaults of the
// settings and what the page offers follow it, from the first moment (core/appConfig.ts).
import { appConfig, loadAppConfig } from "./core/appConfig";

await loadAppConfig();
if (appConfig.features.webxr !== "unavailable") {
  // The XR script (web/xr/, copied into the build as it is: it finds xr/slicer_xr.py beside itself),
  // told whether its setting is on before a user changes it
  const script = document.createElement("script");
  script.type = "module";
  script.dataset.webxr = appConfig.features.webxr;
  script.src = new URL("xr/slicer-xr.js", document.baseURI).href;
  document.head.appendChild(script);
}
await import("./start");

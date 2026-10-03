// The configuration of the application (wheels/application.json) is read first: the defaults of the
// settings and what the page offers follow it, from the first moment (core/appConfig.ts).
import { loadAppConfig } from "./core/appConfig";

await loadAppConfig();
await import("./start");

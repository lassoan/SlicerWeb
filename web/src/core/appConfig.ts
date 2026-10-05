/* The configuration of the application: what the repository it is published from sets in its
 * application.json (docs/extensions.md) - which features it has, and later its defaults, branding
 * and colors. The build writes it, but for the extensions, next to the wheels
 * (wheels/application.json); without one - SlicerWeb built on its own - the application has the
 * defaults below.
 *
 * It is read before anything else starts (main.ts), so that the defaults of the settings and what
 * the page offers follow it from the first moment.
 */

/**
 * Developer mode (the setting Developer/DeveloperMode):
 * - enabledByDefault: on, and the Application settings dialog can turn it off
 * - disabledByDefault: off, and the dialog can turn it on
 * - unavailable: off, and the dialog does not offer it
 */
export type DeveloperModeAvailability = "enabledByDefault" | "disabledByDefault" | "unavailable";

export interface AppConfig {
  features: {
    developerMode: DeveloperModeAvailability;
    /** The Python console: the application menu, Ctrl+3 */
    pythonConsole: boolean;
    /** The Extensions Manager: the application menu, Ctrl+4 */
    extensionsManager: boolean;
  };
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  features: {
    developerMode: "enabledByDefault",
    pythonConsole: true,
    extensionsManager: true,
  },
};

const ALLOWED: { [K in keyof AppConfig["features"]]: readonly AppConfig["features"][K][] } = {
  developerMode: ["enabledByDefault", "disabledByDefault", "unavailable"],
  pythonConsole: [true, false],
  extensionsManager: [true, false],
};

/** The configuration in effect (the defaults until loadAppConfig has read the application's). */
export const appConfig: AppConfig = structuredClone(DEFAULT_APP_CONFIG);

/** Read wheels/application.json, if the build has one. What it cannot have is reported and left at
 *  the default. */
export async function loadAppConfig(url = new URL("wheels/application.json", document.baseURI).href) {
  let config: unknown;
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) return;   // none: the defaults
    config = await response.json();
  } catch (e) {
    console.error(`The configuration of the application (${url}) could not be read:`, e);
    return;
  }
  const features = (config as { features?: Record<string, unknown> } | null)?.features ?? {};
  for (const [name, value] of Object.entries(features)) {
    const allowed = (ALLOWED as Record<string, readonly unknown[]>)[name];
    if (!allowed) {
      console.error(`application.json: unknown feature ${name}`);
    } else if (!allowed.includes(value)) {
      console.error(`application.json: features.${name} is one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}, not ${JSON.stringify(value)}`);
    } else {
      (appConfig.features as Record<string, unknown>)[name] = value;
    }
  }
}

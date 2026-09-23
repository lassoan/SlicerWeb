/* The application settings the page keeps: the ones its Application settings dialog offers.
 *
 * They are Slicer's own settings, by their Qt key, so that a module reads them as it does on the
 * desktop (slicer.util.settingsValue("Developer/DeveloperMode", ...)). The page keeps them in the
 * browser as it keeps the installed extensions - they survive a reload - hands them to Python at
 * startup and passes on a change made from either side (see slicerweb.settings).
 */
export const SETTINGS_KEY = "slicerweb.settings";

export interface AppSettings {
  /** Show what a module developer needs: the Reload and Test section of a scripted module. */
  "Developer/DeveloperMode": boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  "Developer/DeveloperMode": true,
};

/** The settings kept in the browser, with the defaults for whatever is not kept. */
export function loadSettings(): AppSettings {
  try {
    const kept = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return { ...DEFAULT_SETTINGS, ...(kept && typeof kept === "object" ? kept : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // a private window, say: the settings hold for this page
  }
}

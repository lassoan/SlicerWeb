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
  /** Show in the corner of every view how many times it rendered in the last second, and how long it took. */
  "Developer/ShowRenderingFPS": boolean;
  /**
   * Draw every view into one canvas with one WebGL context, instead of giving each its own.
   *
   * A browser allows only so many contexts at a time - about eight on a phone, sixteen on a
   * desktop - so a layout of nine views cannot give each of them one; and a context costs a few
   * megabytes of graphics memory and its own copy of every shader. Sharing lifts the limit; the
   * views still render on their own, and the canvas copies all of them whenever one has rendered.
   */
  "Rendering/SharedWebGLContext": boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  "Developer/DeveloperMode": true,
  "Developer/ShowRenderingFPS": false,
  "Rendering/SharedWebGLContext": false,
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

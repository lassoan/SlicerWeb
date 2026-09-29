/* The application settings the page keeps: the ones its Application settings dialog offers.
 *
 * They are Slicer's own settings, by their Qt key, so that a module reads them as it does on the
 * desktop (slicer.util.settingsValue("Developer/DeveloperMode", ...)). The page keeps them in the
 * browser as it keeps the installed extensions - they survive a reload - hands them to Python at
 * startup and passes on a change made from either side (see slicerweb.settings).
 */
export const SETTINGS_KEY = "slicerweb.settings";

export interface AppSettings {
  /**
   * Offer as a download what module code writes into the Documents folder or next to files the
   * user chose (a module saving an image, a header of a raw file): on the desktop such a file would
   * be in a folder of the user's, while here it would stay in the page, where nobody can get at it.
   */
  "General/SaveWrittenFilesToDownloads": boolean;
  /**
   * Keep the scene for the next start while working, not only as the page goes into the background:
   * what changed is saved after 5 seconds without input. A reload does not wait for anything to be
   * saved, so without this a reload restores the scene as it was the last time the page was hidden.
   */
  "General/AutoSave": boolean;
  /** Show what a module developer needs: the Reload and Test section of a scripted module. */
  "Developer/DeveloperMode": boolean;
  /** Show in the corner of every view how many times it rendered in the last second, and how long it took. */
  "Developer/ShowRenderingFPS": boolean;
  /**
   * Let Python code that runs long (a self test, the Python console) be suspended while the page
   * draws, where the browser has JavaScript Promise Integration: processEvents() then lets the
   * views render and the page answer, as on the desktop. Off, the page behaves as in a browser
   * without JSPI: nothing is drawn until the code is done.
   */
  "Developer/AllowJSPI": boolean;
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
  "General/SaveWrittenFilesToDownloads": true,
  "General/AutoSave": true,
  "Developer/DeveloperMode": true,
  "Developer/ShowRenderingFPS": false,
  "Developer/AllowJSPI": true,
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

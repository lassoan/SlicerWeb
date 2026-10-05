/* The application settings the page keeps: the ones its Application settings dialog offers.
 *
 * They are Slicer's own settings, by their Qt key, so that a module reads them as it does on the
 * desktop (slicer.util.settingsValue("Developer/DeveloperMode", ...)). The page keeps them in the
 * browser as it keeps the installed extensions - they survive a reload - hands them to Python at
 * startup and passes on a change made from either side (see slicerweb.settings).
 */
import { appConfig } from "./appConfig";

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
  /**
   * The modules the toolbar offers (by name), in order: Slicer's own setting of favorite modules.
   * An embedding page can give others for itself with ?favoriteModules= (docs/embedding.md).
   */
  "Modules/FavoriteModules": string[];
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
  /**
   * Draw the views at no more than this many device pixels per CSS pixel (0: as many as the screen
   * has). A phone has three or more, and drawing at that density costs over twice the pixels of two
   * for a picture that looks hardly sharper (see core/pixelRatio.ts).
   */
  "Rendering/MaximumPixelRatio": number;
  /**
   * While the camera of a 3D view is moving, ambient shadows take a tenth of the samples per pixel:
   * noisier, and many times faster (slicerweb.volume_quality).
   */
  "Rendering/FastShadowsWhileMoving": boolean;
  /**
   * The representation that new segmentations show in 3D views: "Binary labelmap" (smooth surfaces
   * that the GPU computes from the labelmap; experimental), "Closed surface" (a surface mesh made
   * from the labelmap), or "" for the default. The default is binary labelmap in the web viewer (desktop
   * Slicer's is closed surface): it needs no conversion, which could be slow here, so segmentations show
   * at once and update while edited.
   */
  "Segmentations/DefaultRepresentation3D": string;
  /**
   * While the camera of a 3D view is moving, segmentations shown as binary labelmap are drawn with
   * rays cast for every n-th pixel across and down (1: every pixel), and in full when it stops
   * (slicerweb.volume_quality).
   */
  "Segmentations/ImageSampleDistanceWhileMoving": number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  "General/SaveWrittenFilesToDownloads": true,
  "General/AutoSave": true,
  "Modules/FavoriteModules": ["SegmentEditor", "VolumeRendering", "Transforms", "SceneViews"],
  // as the application says (application.json, features.developerMode)
  "Developer/DeveloperMode": appConfig.features.developerMode === "enabledByDefault",
  "Developer/ShowRenderingFPS": false,
  "Developer/AllowJSPI": true,
  "Rendering/SharedWebGLContext": false,
  "Rendering/MaximumPixelRatio": 2,
  "Rendering/FastShadowsWhileMoving": true,
  "Segmentations/DefaultRepresentation3D": "",
  "Segmentations/ImageSampleDistanceWhileMoving": 2,
};

/** What the application does not let a user change (application.json): such a setting has its value
 *  whatever the browser kept. */
export function fixedSettings(): Partial<AppSettings> {
  return appConfig.features.developerMode === "unavailable" ? { "Developer/DeveloperMode": false } : {};
}

/** The settings kept in the browser, with the defaults for whatever is not kept. */
export function loadSettings(): AppSettings {
  try {
    const kept = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return { ...DEFAULT_SETTINGS, ...(kept && typeof kept === "object" ? kept : {}), ...fixedSettings() };
  } catch {
    return { ...DEFAULT_SETTINGS, ...fixedSettings() };
  }
}

/** Keep the settings that differ from the defaults: one the user has not changed follows the
 *  default, also when the application changes it. */
export function saveSettings(settings: AppSettings) {
  const changed = Object.fromEntries(Object.entries(settings).filter(
    ([key, value]) => JSON.stringify(value) !== JSON.stringify((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key])));
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(changed));
  } catch {
    // a private window, say: the settings hold for this page
  }
}

// What the application is busy with - downloading or loading data - shown over the views
// (ActivityIndicator.vue), so that a large scene does not look like nothing is happening.

import type { SlicerBridge } from "@/core/bridge";
import { formatBytes } from "@/core/runtime";
import { store } from "./store";

export interface Activity {
  message: string;
  /** How far along it is (0..1), or null when that is not known */
  fraction: number | null;
  detail: string;
}

export function showActivity(message: string, fraction: number | null = null, detail = "") {
  store.activity = { message, fraction, detail };
}

export function clearActivity() {
  store.activity = null;
}

/** Wait until the browser has drawn a frame (what was just shown is on the screen). */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** The onProgress of runtime.downloadFile: shows how much of *what* has arrived. */
export function downloadProgress(what: string) {
  return (received: number, total: number) => {
    // The size a server announces may be that of the compressed transfer, which what arrives
    // outgrows: never more than all of it
    if (total) received = Math.min(received, total);
    // (formatBytes(0) is "unknown size": nothing is said until something has arrived)
    const done = received ? formatBytes(received) : "0 MB";
    showActivity(`Downloading ${what}`, total ? Math.min(1, received / total) : null,
      total ? `${done} of ${formatBytes(total)}` : done);
  };
}

/**
 * Load files into the scene, showing how far along it is: the files of a scene are reported as they
 * are read ("loading-progress" events of slicerweb/loading_progress.py). The loading is started so
 * that Python may be suspended (where the browser can), which lets the page draw each step and answer.
 * Then the views draw what was loaded - the first drawing of a large scene takes a while - which is
 * said too, until it is on the screen.
 */
export async function loadFilesShowingProgress<T = string[]>(bridge: SlicerBridge, method: string, args: unknown[], name: string): Promise<T> {
  showActivity(`Loading ${name}`);
  const off = bridge.events.on<Activity>("loading-progress", (p) => p && showActivity(p.message, p.fraction, p.detail ?? ""));
  try {
    await nextFrame();
    const result = await bridge.callYielding<T>(method, args);
    showActivity(`Displaying ${name}`);
    // the views render the loaded data in the frames that follow
    await nextFrame();
    await nextFrame();
    return result;
  } finally {
    off();
    clearActivity();
  }
}

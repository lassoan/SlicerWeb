<script setup lang="ts">
// Application settings: what Slicer's settings dialog offers, in sections. The settings are
// Slicer's own, by their Qt key (see core/settings.ts): a module reads them as on the desktop.
import { computed, inject, ref } from "vue";
import { ArrowDown, ArrowUp, X } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwCheckBox } from "@/widgets";
import { setSetting, store } from "../store";
import { moduleList } from "../modules/list";
import { devicePixelRatio } from "@/core/pixelRatio";

const emit = defineEmits<{ close: [] }>();
// Whether this browser has JavaScript Promise Integration (the Developer section says so if not)
const bridge = inject<SlicerBridge>("bridge");
const jspiSupported = !!(bridge as { jspiSupported?: boolean } | undefined)?.jspiSupported;

interface Section { id: string; title: string }
const sections: Section[] = [
  { id: "general", title: "General" }, { id: "modules", title: "Modules" }, { id: "rendering", title: "Rendering" },
  { id: "segmentations", title: "Segmentations" }, { id: "developer", title: "Developer" },
];
const section = ref(sections[0].id);

// Favorite modules: the modules of the toolbar, in order (Slicer's setting Modules/FavoriteModules)
const favourites = computed(() => store.settings["Modules/FavoriteModules"] ?? []);
const titleOf = (name: string) => moduleList.value.find((m) => m.name === name)?.title ?? `${name} (not loaded)`;
const addable = computed(() => moduleList.value.filter((m) => !favourites.value.includes(m.name)));
const setFavourites = (names: string[]) => setSetting("Modules/FavoriteModules", names);
function moveFavourite(index: number, step: number) {
  const names = [...favourites.value];
  const [name] = names.splice(index, 1);
  names.splice(index + step, 0, name);
  setFavourites(names);
}
function addFavourite(event: Event) {
  const select = event.target as HTMLSelectElement;
  if (select.value) setFavourites([...favourites.value, select.value]);
  select.value = "";
}
// An embedding page may name the favorites for itself (?favoriteModules=): the toolbar follows that
const favouritesFromAddress = new URLSearchParams(window.location.search).has("favoriteModules");
// The screen's own density, whatever the views are drawn at
const deviceRatio = `${Math.round(devicePixelRatio() * 100) / 100} pixels per point`;
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" @click.self="emit('close')">
    <div class="flex h-[60vh] w-[640px] max-w-[95vw] flex-col rounded-lg border border-input bg-bkg-med shadow-2xl" data-name="settings-dialog">
      <div class="flex items-center justify-between border-b border-input px-4 py-3">
        <div class="text-[16px] font-medium">Application settings</div>
        <button type="button" class="text-muted-foreground hover:text-highlight" aria-label="Close" @click="emit('close')"><X :size="18" /></button>
      </div>
      <div class="flex min-h-0 flex-1 max-md:flex-col">
        <!-- The sections: a column beside the settings, a row of tabs above them on a phone -->
        <nav class="flex shrink-0 gap-1 border-input p-2 md:w-40 md:flex-col md:border-r max-md:overflow-x-auto max-md:border-b" aria-label="Settings sections">
          <button v-for="s in sections" :key="s.id" type="button" class="rounded px-3 py-1.5 text-left text-[13px]"
            :class="section === s.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60'" @click="section = s.id">
            {{ s.title }}
          </button>
        </nav>
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <template v-if="section === 'general'">
            <SwCheckBox text="Save files that modules write to your downloads" data-name="saveWrittenFilesToDownloads"
              :checked="store.settings['General/SaveWrittenFilesToDownloads']"
              @toggled="setSetting('General/SaveWrittenFilesToDownloads', $event)" />
            <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
              A file that a module writes into the Documents folder - the folder offered when a module asks where to
              save a file - or next to a file you chose is saved to your downloads, as it would be in a folder of yours on
              the desktop. Files anywhere else in the application stay in it.
            </div>
            <SwCheckBox text="Auto-save" class="mt-3" data-name="autoSave"
              :checked="store.settings['General/AutoSave']"
              @toggled="setSetting('General/AutoSave', $event)" />
            <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
              Keep the scene for the next start while you work: what changed is saved after 5 seconds without input,
              so that reloading the page brings back the latest state. A dot in the lower left corner shows it: red
              while saving, green when saved. Off, the scene is kept only when the page goes into the background.
            </div>
          </template>
          <template v-if="section === 'modules'">
            <div class="text-[13px] text-foreground">Favorite modules</div>
            <div class="mt-1 text-[12px] text-muted-foreground">
              The modules the toolbar offers, in this order. (Slicer setting <code>Modules/FavoriteModules</code>.)
              <template v-if="favouritesFromAddress"><br />This page's address names the favorite modules
                (<code>?favoriteModules=</code>), and its toolbar shows those.</template>
            </div>
            <div class="mt-2 flex flex-col gap-0.5" data-name="favoriteModules">
              <div v-for="(name, index) in favourites" :key="name" class="flex items-center gap-1 rounded px-2 py-1 text-[13px] hover:bg-accent/40"
                :data-module="name">
                <span class="min-w-0 flex-1 truncate">{{ titleOf(name) }}</span>
                <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight disabled:opacity-30" :disabled="index === 0"
                  :title="`Move ${titleOf(name)} up`" @click="moveFavourite(index, -1)"><ArrowUp :size="14" /></button>
                <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight disabled:opacity-30" :disabled="index === favourites.length - 1"
                  :title="`Move ${titleOf(name)} down`" @click="moveFavourite(index, 1)"><ArrowDown :size="14" /></button>
                <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight"
                  :title="`Remove ${titleOf(name)}`" @click="setFavourites(favourites.filter((n) => n !== name))"><X :size="14" /></button>
              </div>
              <div v-if="!favourites.length" class="px-2 py-1 text-[12px] text-muted-foreground">None: the toolbar offers no modules.</div>
            </div>
            <select class="mt-2 w-full rounded border border-input bg-background px-2 py-1 text-[13px] text-foreground"
              data-name="addFavoriteModule" @change="addFavourite">
              <option value="">Add a module…</option>
              <option v-for="m in addable" :key="m.name" :value="m.name">{{ m.title || m.name }}</option>
            </select>
          </template>
          <template v-if="section === 'rendering'">
            <SwCheckBox text="Share one WebGL context between the views" data-name="sharedWebGLContext"
              :checked="store.settings['Rendering/SharedWebGLContext']"
              @toggled="setSetting('Rendering/SharedWebGLContext', $event)" />
            <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
              Every view is drawn into one canvas rather than one of its own. A browser allows only so many WebGL
              contexts at a time - about eight on a phone - so a layout of nine views cannot give each of them one;
              a context also costs a few megabytes of graphics memory. The views are rebuilt when this is changed.
            </div>
            <label class="mt-3 block text-[13px]" for="maximumPixelRatio">Resolution of the views</label>
            <select id="maximumPixelRatio" data-name="maximumPixelRatio"
              class="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-[13px] text-foreground"
              :value="String(store.settings['Rendering/MaximumPixelRatio'])"
              @change="setSetting('Rendering/MaximumPixelRatio', Number(($event.target as HTMLSelectElement).value))">
              <option value="0">As sharp as the screen</option>
              <option value="2">At most 2 pixels per point</option>
              <option value="1.5">At most 1.5 pixels per point</option>
              <option value="1">1 pixel per point</option>
            </select>
            <div class="mt-1 text-[12px] text-muted-foreground">
              How many pixels the views are drawn with for each point of the page. A phone's screen has three or more,
              and drawing at that density makes the 3D views slow - for a picture that looks hardly sharper than at two.
              Lower it if rendering is slow. This screen has {{ deviceRatio }}. The views are rebuilt when this is changed.
            </div>
            <SwCheckBox text="Fast shadows while rotating" class="mt-3" data-name="fastShadowsWhileMoving"
              :checked="store.settings['Rendering/FastShadowsWhileMoving']"
              @toggled="setSetting('Rendering/FastShadowsWhileMoving', $event)" />
            <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
              While a 3D view is rotated, panned or zoomed, ambient shadows are computed from a tenth of the samples:
              noisier, and many times faster - on a phone, shadows can take most of the time of drawing a view. They are
              drawn in full when the movement stops. (Slicer setting <code>Rendering/FastShadowsWhileMoving</code>.)
            </div>
          </template>
          <template v-if="section === 'segmentations'">
            <label class="block text-[13px]" for="defaultRepresentation3D">Representation in 3D views</label>
            <select id="defaultRepresentation3D" data-name="defaultRepresentation3D"
              class="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-[13px] text-foreground"
              :value="store.settings['Segmentations/DefaultRepresentation3D']"
              @change="setSetting('Segmentations/DefaultRepresentation3D', ($event.target as HTMLSelectElement).value)">
              <option value="">Default (binary labelmap)</option>
              <option value="Binary labelmap">Binary labelmap</option>
              <option value="Closed surface">Closed surface</option>
            </select>
            <div class="mt-1 text-[12px] text-muted-foreground">
              The representation that new segmentations show in 3D views. Binary labelmap is shown as smooth surfaces
              that the GPU computes from the labelmap (experimental); closed surface is a surface mesh made from it.
              (Slicer setting <code>Segmentations/DefaultRepresentation3D</code>.)
            </div>
            <label class="mt-3 block text-[13px]" for="imageSampleDistanceWhileMoving">Resolution while rotating</label>
            <select id="imageSampleDistanceWhileMoving" data-name="imageSampleDistanceWhileMoving"
              class="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-[13px] text-foreground"
              :value="String(store.settings['Segmentations/ImageSampleDistanceWhileMoving'])"
              @change="setSetting('Segmentations/ImageSampleDistanceWhileMoving', Number(($event.target as HTMLSelectElement).value))">
              <option value="1">Full</option>
              <option value="2">Half</option>
              <option value="3">Third</option>
              <option value="4">Quarter</option>
            </select>
            <div class="mt-1 text-[12px] text-muted-foreground">
              While a 3D view is rotated, panned or zoomed, segmentations shown as binary labelmap are drawn with fewer
              pixels, which is several times faster, and in full when the movement stops - as volume rendering does.
              (Slicer setting <code>Segmentations/ImageSampleDistanceWhileMoving</code>.)
            </div>
          </template>
          <template v-if="section === 'developer'">
            <SwCheckBox text="Developer mode" :checked="store.settings['Developer/DeveloperMode']"
              @toggled="setSetting('Developer/DeveloperMode', $event)" />
            <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
              Show what a module developer needs: the Reload and Test section at the bottom of a scripted module's panel.
              (Slicer setting <code>Developer/DeveloperMode</code>.)
            </div>
            <SwCheckBox text="Show rendering FPS" class="mt-3" data-name="showRenderingFPS"
              :checked="store.settings['Developer/ShowRenderingFPS']"
              @toggled="setSetting('Developer/ShowRenderingFPS', $event)" />
            <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
              Show in the top right corner of every view how many times it rendered in the last second, and how long
              its last render took.
            </div>
            <SwCheckBox text="Allow JavaScript Promise Integration (JSPI)" class="mt-3" data-name="allowJSPI"
              :checked="store.settings['Developer/AllowJSPI']"
              @toggled="setSetting('Developer/AllowJSPI', $event)" />
            <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
              Let Python code that runs for a while - a module's self test, code typed in the Python console - pause
              whenever it processes events, so that the views are drawn and the page responds meanwhile, as on the
              desktop. Turn it off to see the application as in a browser without JSPI, where nothing is drawn until the
              code is done.
              <template v-if="!jspiSupported"><br />This browser does not support JSPI: the setting has no effect.</template>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

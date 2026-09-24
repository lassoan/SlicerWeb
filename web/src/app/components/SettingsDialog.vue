<script setup lang="ts">
// Application settings: what Slicer's settings dialog offers, in sections. The settings are
// Slicer's own, by their Qt key (see core/settings.ts): a module reads them as on the desktop.
import { ref } from "vue";
import { X } from "@lucide/vue";
import { SwCheckBox } from "@/widgets";
import { setSetting, store } from "../store";

const emit = defineEmits<{ close: [] }>();

interface Section { id: string; title: string }
const sections: Section[] = [{ id: "rendering", title: "Rendering" }, { id: "developer", title: "Developer" }];
const section = ref(sections[0].id);
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
          <template v-if="section === 'rendering'">
            <SwCheckBox text="Share one WebGL context between the views" data-name="sharedWebGLContext"
              :checked="store.settings['Rendering/SharedWebGLContext']"
              @toggled="setSetting('Rendering/SharedWebGLContext', $event)" />
            <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
              Every view is drawn into one canvas rather than one of its own. A browser allows only so many WebGL
              contexts at a time - about eight on a phone - so a layout of nine views cannot give each of them one;
              a context also costs a few megabytes of graphics memory and its own copy of every shader. The price is
              that a change in one view redraws all of them. The views are rebuilt when this is changed.
            </div>
          </template>
          <template v-if="section === 'developer'">
            <SwCheckBox text="Developer mode" :checked="store.settings['Developer/DeveloperMode']"
              @toggled="setSetting('Developer/DeveloperMode', $event)" />
            <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
              Show what a module developer needs: the Reload and Test section at the bottom of a scripted module's panel.
              (Slicer setting <code>Developer/DeveloperMode</code>.)
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

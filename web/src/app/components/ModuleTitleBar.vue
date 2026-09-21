<script setup lang="ts">
/**
 * The title bar of the module panel: the module that is open, and the ways of getting to another.
 *
 * It stands where the panel's tab label used to, and works like the module toolbar of desktop
 * Slicer: the title opens the finder, the arrows walk back and forth through the modules that were
 * opened, and the list shows the ones used most recently.
 */
import { computed, ref } from "vue";
import { ChevronLeft, ChevronRight, Info, List, Search } from "@lucide/vue";
import { moduleTitle } from "../modules/list";
import { recentModules, stepModuleHistory, store } from "../store";

const recentOpen = ref(false);

const title = computed(() => moduleTitle(store.activeModule));
const canGoBack = computed(() => store.moduleHistoryIndex > 0);
const canGoForward = computed(() => store.moduleHistoryIndex < store.moduleHistory.length - 1);
const previousTitle = computed(() => (canGoBack.value ? moduleTitle(store.moduleHistory[store.moduleHistoryIndex - 1]) : ""));
const nextTitle = computed(() => (canGoForward.value ? moduleTitle(store.moduleHistory[store.moduleHistoryIndex + 1]) : ""));
const recent = computed(() => recentModules().map((name) => ({ name, title: moduleTitle(name) })));

function toggleFinder() {
  recentOpen.value = false;
  store.moduleFinderOpen = !store.moduleFinderOpen;
}

function openRecent(name: string) {
  recentOpen.value = false;
  // Going to a module through the recent list is a move of its own, not a step through the history
  store.activeModule = name;
  const index = store.moduleHistory.lastIndexOf(name);
  if (index >= 0) {
    store.moduleHistoryIndex = index;
  }
}

function step(direction: number) {
  recentOpen.value = false;
  store.moduleFinderOpen = false;
  stepModuleHistory(direction);
}
</script>

<template>
  <div class="relative flex h-full w-full items-center bg-primary/10 pr-1 pl-2" data-name="moduleTitleBar">
    <button type="button" class="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground hover:text-highlight"
      :title="'Module: ' + title + ' (click to choose another)'" data-name="moduleTitle" @click="toggleFinder">
      {{ title }}
    </button>
    <button type="button" class="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-highlight"
      title="Find a module" data-name="findModule" @click="toggleFinder">
      <Search :size="14" />
    </button>
    <button type="button" class="flex h-6 w-6 items-center justify-center"
      :class="canGoBack ? 'text-muted-foreground hover:text-highlight' : 'text-muted-foreground/30'"
      :disabled="!canGoBack" :title="canGoBack ? 'Back to ' + previousTitle : 'No module to go back to'"
      data-name="previousModule" @click="step(-1)">
      <ChevronLeft :size="16" />
    </button>
    <button type="button" class="flex h-6 w-6 items-center justify-center"
      :class="canGoForward ? 'text-muted-foreground hover:text-highlight' : 'text-muted-foreground/30'"
      :disabled="!canGoForward" :title="canGoForward ? 'Forward to ' + nextTitle : 'No module to go forward to'"
      data-name="nextModule" @click="step(1)">
      <ChevronRight :size="16" />
    </button>
    <button type="button" class="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-highlight"
      title="Modules used recently" data-name="recentModules" :aria-expanded="recentOpen"
      @click="recentOpen = !recentOpen; store.moduleFinderOpen = false">
      <List :size="14" />
    </button>
    <button type="button" class="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-highlight"
      title="Help and acknowledgment" data-name="moduleHelp"
      @click="store.moduleHelpOpen = !store.moduleHelpOpen">
      <Info :size="14" />
    </button>

    <div v-if="recentOpen" class="absolute top-full right-1 z-40 mt-1 min-w-44 rounded-md border border-input bg-popover py-1 shadow-lg"
      data-name="recentModuleList" @pointerleave="recentOpen = false">
      <button v-for="m in recent" :key="m.name" type="button"
        class="flex w-full items-center px-3 py-1 text-left text-[13px] hover:bg-accent"
        :class="m.name === store.activeModule ? 'text-highlight' : ''" @click="openRecent(m.name)">
        {{ m.title }}
      </button>
    </div>
  </div>
</template>

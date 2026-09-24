<script setup lang="ts">
/**
 * What is known about a module: what it says about itself, and where it came from.
 *
 * Shown by the module finder for the module it has highlighted, and by the panel's title bar for
 * the module that is open. A module that says nothing about itself still has a name, a category
 * and a file it came from, which is what the help of desktop Slicer falls back to as well.
 */
import type { ModuleSummary } from "../store";

defineProps<{ module: ModuleSummary; showTitle?: boolean }>();

function kindLabel(m: ModuleSummary) {
  return m.kind === "scripted" ? "Python scripted" : m.kind === "cli" ? "Command line" : "C++ loadable";
}

// Slicer puts a module with no category of its own at the top of the module list; here it is named
function categories(m: ModuleSummary) {
  const named = m.categories.filter(Boolean);
  return named.length ? named.join(", ") : "General";
}
</script>

<template>
  <div class="text-[12px]" data-name="moduleInformation">
    <div v-if="showTitle" class="flex items-center gap-1.5 text-[14px] font-semibold text-foreground">
      <img v-if="module.icon" :src="module.icon" alt="" class="h-4 w-4 shrink-0" />
      <span class="truncate">{{ module.title }}</span>
    </div>
    <div v-if="module.helpText" class="mt-1 text-muted-foreground" v-html="module.helpText" />
    <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
      <dt class="font-semibold">Category:</dt><dd class="truncate">{{ categories(module) }}</dd>
      <template v-if="module.contributors.length">
        <dt class="font-semibold">Contributors:</dt><dd>{{ module.contributors.join(", ") }}</dd>
      </template>
      <dt class="font-semibold">Internal name:</dt><dd class="truncate">{{ module.name }}</dd>
      <dt class="font-semibold">Type:</dt>
      <dd>{{ kindLabel(module) }}<span v-if="module.extension"> (extension {{ module.extension }})</span></dd>
      <template v-if="module.path">
        <dt class="font-semibold">Location:</dt><dd class="break-all">{{ module.path }}</dd>
      </template>
    </dl>
    <div v-if="module.acknowledgementText" class="mt-2 text-muted-foreground" v-html="module.acknowledgementText" />
  </div>
</template>

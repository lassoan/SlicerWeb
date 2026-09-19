<script setup lang="ts">
import { computed, ref } from "vue";
import { Search, Info } from "@lucide/vue";
import { store } from "../store";
import { modulePanels } from "../modules";
import ScriptedModuleHost from "../modules/ScriptedModuleHost.vue";
import GenericModulePanel from "../modules/GenericModulePanel.vue";

const filter = ref("");
const selectorOpen = ref(false);
const showHelp = ref(false);

// Web GUIs that are not tied to a loadable module name
const webOnlyModules = [
  { name: "SegmentEditor", title: "Segment Editor", categories: ["Segmentation"] },
  { name: "Data", title: "Data", categories: [""] },
];

const modules = computed(() => {
  const list = store.modules.filter((m) => !m.hidden).map((m) => ({ name: m.name, title: m.title, categories: m.categories }));
  for (const w of webOnlyModules) if (!list.some((m) => m.name === w.name)) list.push(w);
  return list.sort((a, b) => a.title.localeCompare(b.title));
});

const grouped = computed(() => {
  const f = filter.value.toLowerCase();
  const groups = new Map<string, { name: string; title: string }[]>();
  for (const m of modules.value) {
    if (f && !m.title.toLowerCase().includes(f) && !m.name.toLowerCase().includes(f)) continue;
    const cat = m.categories[0] || "Main";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(m);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === "Main" ? -1 : b === "Main" ? 1 : a.localeCompare(b)));
});

const active = computed(() => store.modules.find((m) => m.name === store.activeModule));
const activeTitle = computed(() => active.value?.title ?? webOnlyModules.find((w) => w.name === store.activeModule)?.title ?? store.activeModule);
const panel = computed(() => modulePanels[store.activeModule] ?? (active.value?.webWidget ? modulePanels[active.value.webWidget] : undefined));

function select(name: string) {
  store.activeModule = name;
  selectorOpen.value = false;
  filter.value = "";
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="relative p-2">
      <button type="button" class="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2 text-left text-[13px] hover:border-primary"
        @click="selectorOpen = !selectorOpen">
        <Search :size="14" class="text-muted-foreground" />
        <span class="flex-1 truncate font-medium">{{ activeTitle }}</span>
        <button type="button" class="text-muted-foreground hover:text-highlight" title="Help and acknowledgment" @click.stop="showHelp = !showHelp">
          <Info :size="14" />
        </button>
      </button>
      <div v-if="selectorOpen" class="absolute right-2 left-2 z-30 mt-1 max-h-[65vh] overflow-y-auto rounded-lg border border-input bg-popover p-1 shadow-xl">
        <input v-model="filter" autofocus placeholder="Search modules" class="mb-1 h-7 w-full rounded border border-input bg-background px-2 text-[13px] outline-none" />
        <template v-for="[category, items] in grouped" :key="category">
          <div class="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{{ category }}</div>
          <button v-for="m in items" :key="m.name" type="button" class="block w-full rounded px-2 py-1 text-left text-[13px] hover:bg-accent"
            :class="m.name === store.activeModule ? 'text-highlight' : ''" @click="select(m.name)">{{ m.title }}</button>
        </template>
      </div>
    </div>
    <div v-if="showHelp && active" class="mx-2 mb-2 rounded-md bg-card p-2 text-[12px] text-muted-foreground">
      <div v-if="active.helpText" v-html="active.helpText" />
      <div v-if="active.acknowledgementText" class="mt-2" v-html="active.acknowledgementText" />
      <div v-if="active.contributors.length" class="mt-2">Contributors: {{ active.contributors.join(", ") }}</div>
    </div>
    <div class="sw-panel-scroll min-h-0 flex-1 px-2 pb-3">
      <component :is="panel" v-if="panel" :key="store.activeModule" />
      <ScriptedModuleHost v-else-if="active?.kind === 'scripted'" :key="active.name" :module="active.name" />
      <GenericModulePanel v-else :module="active" :name="store.activeModule" />
    </div>
  </div>
</template>

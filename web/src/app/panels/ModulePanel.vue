<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Search, Info } from "@lucide/vue";
import { store, type ModuleSummary } from "../store";
import { modulePanels } from "../modules";
import ModuleFinder from "../components/ModuleFinder.vue";
import ScriptedModuleHost from "../modules/ScriptedModuleHost.vue";
import GenericModulePanel from "../modules/GenericModulePanel.vue";

const selectorOpen = ref(false);
const showHelp = ref(false);

// Web GUIs that are not tied to a loadable module name
const webOnlyModules: ModuleSummary[] = [
  { name: "SegmentEditor", title: "Segment Editor", categories: ["Segmentation"], kind: "scripted",
    helpText: "Edit the segments of a segmentation with the paint, draw, erase and threshold effects.",
    dependencies: [], hidden: false, acknowledgementText: "", contributors: [], webWidget: null, icon: null },
  { name: "Data", title: "Data", categories: ["Informatics"], kind: "loadable",
    helpText: "The nodes of the scene, as a subject hierarchy tree.",
    dependencies: [], hidden: false, acknowledgementText: "", contributors: [], webWidget: null, icon: null },
];

const modules = computed<ModuleSummary[]>(() => {
  // Hidden modules are left out, unless this application has a GUI for one (Terminologies is hidden
  // in desktop Slicer, which has no panel for it)
  const list = store.modules.filter((m) => !m.hidden || m.name in modulePanels).slice();
  for (const w of webOnlyModules) if (!list.some((m) => m.name === w.name)) list.push(w);
  return list.sort((a, b) => a.title.localeCompare(b.title));
});

const active = computed(() => store.modules.find((m) => m.name === store.activeModule));
const activeTitle = computed(() => active.value?.title ?? webOnlyModules.find((w) => w.name === store.activeModule)?.title ?? store.activeModule);
const panel = computed(() => modulePanels[store.activeModule] ?? (active.value?.webWidget ? modulePanels[active.value.webWidget] : undefined));

// Opening the finder puts the cursor in its search box, so that a module can be typed straight away
// (on a phone this is also what brings the keyboard up).
const finder = ref<InstanceType<typeof ModuleFinder>>();
watch(selectorOpen, async (open) => {
  if (!open) return;
  await nextTick();
  finder.value?.focus();
});

function select(name: string) {
  store.activeModule = name;
  selectorOpen.value = false;
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
      <div v-if="selectorOpen" class="absolute right-2 left-2 z-30 mt-1">
        <ModuleFinder ref="finder" :modules="modules" :current="store.activeModule" @select="select" @close="selectorOpen = false" />
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

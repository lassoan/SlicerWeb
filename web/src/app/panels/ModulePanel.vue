<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { openModule, store } from "../store";
import { modulePanels } from "../modules";
import { moduleList, webOnlyModules } from "../modules/list";
import ModuleFinder from "../components/ModuleFinder.vue";
import ModuleInformation from "../components/ModuleInformation.vue";
import ScriptedModuleHost from "../modules/ScriptedModuleHost.vue";
import GenericModulePanel from "../modules/GenericModulePanel.vue";
import CliModulePanel from "../modules/CliModulePanel.vue";

// The module that is open, what it is called and the panel that shows it. Which module that is,
// and whether the finder is open, is decided in the title bar above the panel (ModuleTitleBar).
const active = computed(() => store.modules.find((m) => m.name === store.activeModule));
const panel = computed(() => modulePanels[store.activeModule] ?? (active.value?.webWidget ? modulePanels[active.value.webWidget] : undefined));
// What the "i" in the title bar shows: everything known about the module that is open. A module
// with no help text of its own still has a name, a category and a file it came from.
const help = computed(() => active.value ?? webOnlyModules.find((w) => w.name === store.activeModule));

// Opening the finder puts the cursor in its search box, so that a module can be typed straight away
// (on a phone this is also what brings the keyboard up).
const finder = ref<InstanceType<typeof ModuleFinder>>();
watch(() => store.moduleFinderOpen, async (open) => {
  if (!open) return;
  await nextTick();
  finder.value?.focus();
});

function select(name: string) {
  openModule(name);
  store.moduleFinderOpen = false;
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div v-if="store.moduleFinderOpen" class="relative px-2 pt-2">
      <div class="absolute right-2 left-2 z-30">
        <ModuleFinder ref="finder" :modules="moduleList" :current="store.activeModule" @select="select"
          @close="store.moduleFinderOpen = false" />
      </div>
    </div>
    <div v-if="store.moduleHelpOpen" class="mx-2 mt-2 mb-1 rounded-md bg-card p-2" data-name="moduleHelp">
      <ModuleInformation v-if="help" :module="help" />
      <div v-else class="text-[12px] text-muted-foreground">
        Nothing is known about “{{ store.activeModule }}”: it is not one of the modules that are loaded.
      </div>
    </div>
    <div class="sw-panel-scroll min-h-0 flex-1 px-2 pt-2 pb-3">
      <component :is="panel" v-if="panel" :key="store.activeModule" />
      <ScriptedModuleHost v-else-if="active?.kind === 'scripted'" :key="active.name" :module="active.name" />
      <!-- Every CLI module has the same panel, built from the description the module ships -->
      <CliModulePanel v-else-if="active?.kind === 'cli'" :key="active.name" :name="active.name" />
      <GenericModulePanel v-else :module="active" :name="store.activeModule" />
    </div>
  </div>
</template>

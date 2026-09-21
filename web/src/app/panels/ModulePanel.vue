<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { openModule, store } from "../store";
import { modulePanels } from "../modules";
import { moduleList, webOnlyModules } from "../modules/list";
import ModuleFinder from "../components/ModuleFinder.vue";
import ScriptedModuleHost from "../modules/ScriptedModuleHost.vue";
import GenericModulePanel from "../modules/GenericModulePanel.vue";

// The module that is open, what it is called and the panel that shows it. Which module that is,
// and whether the finder is open, is decided in the title bar above the panel (ModuleTitleBar).
const active = computed(() => store.modules.find((m) => m.name === store.activeModule));
const panel = computed(() => modulePanels[store.activeModule] ?? (active.value?.webWidget ? modulePanels[active.value.webWidget] : undefined));
const help = computed(() => {
  // Nothing to show for a module that says nothing about itself, rather than an empty box
  const module = active.value ?? webOnlyModules.find((w) => w.name === store.activeModule);
  return module && (module.helpText || module.acknowledgementText || module.contributors.length) ? module : undefined;
});

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
    <div v-if="store.moduleHelpOpen && help" class="mx-2 mt-2 mb-1 rounded-md bg-card p-2 text-[12px] text-muted-foreground">
      <div v-if="help.helpText" v-html="help.helpText" />
      <div v-if="help.acknowledgementText" class="mt-2" v-html="help.acknowledgementText" />
      <div v-if="help.contributors.length" class="mt-2">Contributors: {{ help.contributors.join(", ") }}</div>
    </div>
    <div class="sw-panel-scroll min-h-0 flex-1 px-2 pt-2 pb-3">
      <component :is="panel" v-if="panel" :key="store.activeModule" />
      <ScriptedModuleHost v-else-if="active?.kind === 'scripted'" :key="active.name" :module="active.name" />
      <GenericModulePanel v-else :module="active" :name="store.activeModule" />
    </div>
  </div>
</template>

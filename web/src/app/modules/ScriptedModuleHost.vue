<script setup lang="ts">
// Hosts the GUI of a Python scripted module. The module's ScriptedLoadableModuleWidget.setup() runs
// unchanged; the qt/ctk compatibility layer (slicerweb.qtcompat) creates Slicer web widgets
// (custom elements) inside this container.
import { inject, onBeforeUnmount, onMounted, ref } from "vue";
import type { SlicerBridge } from "@/core/bridge";

const props = defineProps<{ module: string }>();
const bridge = inject<SlicerBridge>("bridge")!;
const containerId = `sw-scripted-${props.module}-${Math.random().toString(36).slice(2, 8)}`;
const error = ref("");

onMounted(async () => {
  try {
    await bridge.call("showScriptedModuleWidget", [props.module, "#" + containerId]);
  } catch (e: any) {
    error.value = e.message ?? String(e);
  }
});
onBeforeUnmount(() => {
  bridge.call("hideScriptedModuleWidget", [props.module]).catch(() => {});
});
</script>

<template>
  <div>
    <div :id="containerId" class="sw-scripted-module flex flex-col gap-1.5" />
    <pre v-if="error" class="mt-2 rounded bg-destructive/40 p-2 text-[12px] whitespace-pre-wrap">{{ error }}</pre>
  </div>
</template>

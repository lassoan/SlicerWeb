<script setup lang="ts">
// Hosts the GUI of a Python scripted module. The module's ScriptedLoadableModuleWidget.setup() runs
// unchanged; the qt/ctk compatibility layer (slicerweb.qtcompat) creates Slicer web widgets
// (custom elements) inside this container.
//
// The "Reload and Test" section is the developer tools section of desktop Slicer: reload the
// module's Python file, and run its self test (<Name>Test).
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwButton, SwCollapsible } from "@/widgets";
import { store } from "../store";

const props = defineProps<{ module: string }>();
const bridge = inject<SlicerBridge>("bridge")!;
const containerId = `sw-scripted-${props.module}-${Math.random().toString(36).slice(2, 8)}`;
const error = ref("");
const busy = ref("");
const result = ref<{ passed: boolean; message: string; seconds?: number; traceback?: string } | null>(null);
const hasTest = computed(() => store.modules.find((m) => m.name === props.module)?.hasTest ?? false);

// What a running test says it is doing (slicer.util.delayDisplay), shown while it runs - the page
// is drawn during a test where Python can be suspended (see bridge.callYielding)
const testMessage = ref("");
const offDelayDisplay = bridge.events.on<{ message: string }>("delay-display", ({ message }) => {
  if (busy.value) testMessage.value = message;
});

async function show() {
  error.value = "";
  try {
    await bridge.call("showScriptedModuleWidget", [props.module, "#" + containerId]);
  } catch (e: any) {
    error.value = e.message ?? String(e);
  }
}

async function reload() {
  busy.value = "Reloading";
  result.value = null;
  try {
    await bridge.call("reloadScriptedModule", [props.module]);
    await show();
  } catch (e: any) {
    error.value = e.message ?? String(e);
  } finally {
    busy.value = "";
  }
}

async function test(withReload: boolean) {
  busy.value = withReload ? "Reloading and testing" : "Testing";
  testMessage.value = "";
  result.value = null;
  error.value = "";
  try {
    if (withReload) {
      await bridge.call("reloadScriptedModule", [props.module]);
      await show();
    }
    // the test may process events: the page then draws while it runs (see bridge.callYielding)
    result.value = await bridge.callYielding("runScriptedModuleTest", [props.module]);
  } catch (e: any) {
    result.value = { passed: false, message: e.message ?? String(e) };
  } finally {
    busy.value = "";
    testMessage.value = "";
  }
}

onMounted(show);
onBeforeUnmount(() => {
  offDelayDisplay?.();
  bridge.call("hideScriptedModuleWidget", [props.module]).catch(() => {});
});
</script>

<template>
  <div>
    <div :id="containerId" class="sw-scripted-module flex flex-col gap-1.5" />
    <pre v-if="error" class="mt-2 rounded bg-destructive/40 p-2 text-[12px] whitespace-pre-wrap">{{ error }}</pre>
    <!-- What a module developer needs, shown in Developer mode (Application settings), as on the desktop -->
    <SwCollapsible v-if="store.settings['Developer/DeveloperMode']" text="Reload and Test" collapsed class="mt-2">
      <div class="flex flex-wrap items-center gap-1">
        <SwButton text="Reload" :enabled="!busy" @clicked="reload" />
        <SwButton v-if="hasTest" text="Reload and Test" :enabled="!busy" @clicked="test(true)" />
        <SwButton v-if="hasTest" text="Test" :enabled="!busy" @clicked="test(false)" />
        <span v-if="busy" class="text-[12px] text-muted-foreground" data-name="testStatus">{{ busy }}…{{ testMessage ? " " + testMessage : "" }}</span>
      </div>
      <div v-if="!hasTest" class="text-[12px] text-muted-foreground">This module has no self test.</div>
      <div v-if="result" class="mt-1 rounded px-2 py-1 text-[12px]" :class="result.passed ? 'bg-emerald-900/40 text-emerald-200' : 'bg-red-900/40 text-red-200'">
        {{ result.message }}<span v-if="result.seconds"> ({{ result.seconds }} s)</span>
      </div>
      <pre v-if="result?.traceback" class="mt-1 max-h-60 overflow-auto rounded bg-card p-2 text-[11px] whitespace-pre-wrap">{{ result.traceback }}</pre>
      <div class="text-[11px] text-muted-foreground">Progress and messages are shown in the Python console.</div>
    </SwCollapsible>
  </div>
</template>

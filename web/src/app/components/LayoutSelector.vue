<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted } from "vue";
import type { SlicerBridge } from "@/core/bridge";
import { store } from "../store";

const emit = defineEmits<{ close: [] }>();
const bridge = inject<SlicerBridge>("bridge")!;

// Common Slicer layouts first, then all others
const common = ["FourUp", "Conventional", "OneUp3D", "OneUpRedSlice", "OneUpYellowSlice", "OneUpGreenSlice",
  "ThreeByThreeSlice", "SideBySide", "DualThreeD", "TripleThreeD", "ConventionalWidescreen", "FourUpTable", "FourByFourSlice"];
const layouts = computed(() => {
  const names = Object.keys(store.availableLayouts);
  return [...common.filter((n) => names.includes(n)), ...names.filter((n) => !common.includes(n))];
});

function label(name: string) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace("One Up", "1-up").replace("Four Up", "Four-up").replace("Three D", "3D");
}

async function select(name: string) {
  await bridge.call("setLayout", [name]);
  emit("close");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="fixed inset-0 z-30" @click="emit('close')" />
  <div class="absolute top-11 left-0 z-40 max-md:fixed max-md:top-[56px] max-md:left-2 max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-input bg-popover p-1 shadow-xl">
    <div class="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Layouts</div>
    <button v-for="name in layouts" :key="name" type="button"
      class="block w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent"
      :class="store.layout.layout === store.availableLayouts[name] ? 'text-highlight' : 'text-foreground'"
      @click="select(name)">
      {{ label(name) }}
    </button>
  </div>
</template>

<script setup lang="ts">
// A toolbar button that opens a menu of tools, for groups that do not fit a phone's toolbar.
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronDown } from "@lucide/vue";
import ToolButton from "./ToolButton.vue";

defineProps<{ label: string; active?: boolean }>();
const open = ref(false);
const root = ref<HTMLElement>();

function onDocumentPointerDown(event: PointerEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener("pointerdown", onDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointerDown));
</script>

<template>
  <div ref="root" class="relative">
    <ToolButton :label="label" :active="active" @click="open = !open">
      <slot name="button" />
      <ChevronDown :size="11" class="-mr-1 opacity-70" />
    </ToolButton>
    <div v-if="open" class="absolute top-full left-0 z-40 mt-1 min-w-44 rounded-lg border border-input bg-popover p-1 shadow-xl"
      role="menu" @click="open = false">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
// A toolbar button that opens a menu of tools, for groups that do not fit a phone's toolbar.
import { ChevronDown } from "@lucide/vue";
import PopupMenu from "./PopupMenu.vue";
import ToolButton from "./ToolButton.vue";

withDefaults(defineProps<{ label: string; active?: boolean; align?: "left" | "right" }>(), {
  active: false,
  align: "left",
});
</script>

<template>
  <PopupMenu :align="align">
    <template #trigger="{ open, toggle }">
      <ToolButton :label="label" :active="active || open" @click="toggle">
        <slot name="button" />
        <ChevronDown :size="11" class="-mr-1 opacity-70" />
      </ToolButton>
    </template>
    <slot />
  </PopupMenu>
</template>

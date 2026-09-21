<script setup lang="ts">
import { ref } from "vue";
import { ChevronLeft, ChevronRight } from "@lucide/vue";

// OHIF SidePanel: 280 px expanded (resizable), 25 px collapsed, 28 px tab headers.
const props = defineProps<{ side: "left" | "right"; open: boolean; tabs: { id: string; label: string }[] }>();
defineEmits<{ toggle: [] }>();

const width = ref(props.side === "right" ? 340 : 280);
let startX = 0;
let startWidth = 0;

function startResize(e: PointerEvent) {
  startX = e.clientX;
  startWidth = width.value;
  const move = (ev: PointerEvent) => {
    const delta = props.side === "left" ? ev.clientX - startX : startX - ev.clientX;
    width.value = Math.min(640, Math.max(220, startWidth + delta));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
</script>

<template>
  <aside v-if="open" class="relative flex shrink-0 flex-col bg-background"
    :class="side === 'left' ? 'pr-[4px]' : 'pl-[4px]'" :style="{ width: width + 'px' }">
    <div class="flex h-[28px] shrink-0 items-center gap-[2px]">
      <button type="button" class="flex h-full w-[30px] items-center justify-center bg-muted text-muted-foreground hover:text-highlight"
        :class="side === 'right' ? 'order-first' : 'order-last'" :title="'Collapse panel'" @click="$emit('toggle')">
        <ChevronLeft v-if="side === 'left'" :size="16" />
        <ChevronRight v-else :size="16" />
      </button>
      <div v-for="tab in tabs" :key="tab.id"
        class="flex h-full min-w-0 flex-1 items-center justify-center bg-primary/10 text-[13px] text-foreground">
        <slot name="header" :tab="tab">{{ tab.label }}</slot>
      </div>
    </div>
    <div class="sw-panel-scroll mt-[2px] min-h-0 flex-1 bg-bkg-low">
      <slot />
    </div>
    <div class="absolute top-0 bottom-0 z-10 w-[4px] cursor-col-resize hover:bg-primary/40"
      :class="side === 'left' ? 'right-0' : 'left-0'" @pointerdown.prevent="startResize" />
  </aside>
  <aside v-else class="flex w-[25px] shrink-0 flex-col items-center bg-popover pt-1"
    :class="side === 'left' ? 'ml-[4px] mr-[8px]' : 'mr-[4px] ml-[8px]'">
    <button type="button" class="text-muted-foreground hover:text-highlight" title="Expand panel" @click="$emit('toggle')">
      <ChevronRight v-if="side === 'left'" :size="16" />
      <ChevronLeft v-else :size="16" />
    </button>
  </aside>
</template>

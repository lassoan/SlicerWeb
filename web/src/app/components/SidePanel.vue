<script setup lang="ts">
import { computed } from "vue";
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { store } from "../store";

// OHIF SidePanel: 280 px expanded (resizable), 25 px collapsed, 28 px tab headers.
//
// *overlay* is set by the shell when there is not enough width for the panel and the views side by
// side (a phone held upright, say). The panel then lies over the views instead of narrowing them:
// the strip that closes it again stays where it is, and the views keep the width they had, which
// matters because what is loaded is fitted to the width of a view at the moment it arrives.
const props = defineProps<{ side: "left" | "right"; open: boolean; overlay?: boolean; tabs: { id: string; label: string }[] }>();
defineEmits<{ toggle: [] }>();

const width = computed({
  get: () => (props.side === "left" ? store.leftPanelWidth : store.rightPanelWidth),
  set: (value: number) => {
    if (props.side === "left") store.leftPanelWidth = value;
    else store.rightPanelWidth = value;
  },
});
// Over the views, a panel leaves a strip of them showing, so that it is clear what is underneath
// and there is somewhere to tap to put it away.
const shownWidth = computed(() => (props.overlay ? Math.min(width.value, Math.max(240, window.innerWidth - 56)) : width.value));
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
  <!-- The strip that opens the panel again. It stays in the row while the panel lies over the
       views, so that the views neither move nor change size when the panel comes and goes. -->
  <aside v-if="!open || overlay" class="flex w-[25px] shrink-0 flex-col items-center bg-popover pt-1"
    :class="side === 'left' ? 'ml-[4px] mr-[8px]' : 'mr-[4px] ml-[8px]'">
    <button type="button" class="text-muted-foreground hover:text-highlight" title="Expand panel" @click="$emit('toggle')">
      <ChevronRight v-if="side === 'left'" :size="16" />
      <ChevronLeft v-else :size="16" />
    </button>
  </aside>
  <!-- Tapping the views puts an overlaying panel away, as a drawer does. -->
  <div v-if="open && overlay" class="absolute inset-0 z-30 bg-black/50" @click="$emit('toggle')" />
  <aside v-if="open" class="flex flex-col bg-background"
    :class="[overlay ? 'absolute inset-y-0 z-40 shadow-2xl ' + (side === 'left' ? 'left-0' : 'right-0') : 'relative shrink-0',
             side === 'left' ? 'pr-[4px]' : 'pl-[4px]']"
    :style="{ width: shownWidth + 'px' }">
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
    <div v-if="!overlay" class="absolute top-0 bottom-0 z-10 w-[4px] cursor-col-resize hover:bg-primary/40"
      :class="side === 'left' ? 'right-0' : 'left-0'" @pointerdown.prevent="startResize" />
  </aside>
</template>

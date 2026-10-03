<script setup lang="ts">
// qMRMLSegmentationShow3DButton: shows a segmentation in the 3D views or hides it, and its menu chooses the
// representation shown there (binary labelmap, drawn as smooth surfaces computed on the GPU, or closed surface)
// and how much the surfaces are smoothed.
import { inject, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronDown } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwSlider } from "@/widgets";
import PopupMenu from "./PopupMenu.vue";

const props = defineProps<{ segmentationNodeId: string | null }>();
const emit = defineEmits<{ changed: [] }>();
const bridge = inject<SlicerBridge>("bridge")!;

interface Show3DState { shown: boolean; representation3D: string; smoothingFactor: number }
const state = ref<Show3DState | null>(null);
const REPRESENTATIONS = [
  { name: "Binary labelmap", tip: "Smooth surfaces computed on the GPU from the labelmap, updated at once while editing (experimental)" },
  { name: "Closed surface", tip: "Surface mesh created from the labelmap" },
];

async function refresh() {
  state.value = props.segmentationNodeId
    ? await bridge.call<Show3DState>("segmentationShow3D", [props.segmentationNodeId]).catch(() => null)
    : null;
}
watch(() => props.segmentationNodeId, refresh, { immediate: true });
// The panel that holds the button observes the segmentation; its changes come as these events
const offs = [
  bridge.events.on<{ id: string }>("node-modified", (p) => p?.id === props.segmentationNodeId && refresh()),
  bridge.events.on("segment-editor-changed", refresh),
  bridge.events.on("scene-changed", refresh),
];
onBeforeUnmount(() => offs.forEach((off) => off()));

async function set(properties: Record<string, unknown>) {
  if (!props.segmentationNodeId) return;
  await bridge.call("setSegmentationDisplay", [props.segmentationNodeId, properties]);
  await refresh();
  emit("changed");
}
</script>

<template>
  <div class="inline-flex" data-name="show3D">
    <button type="button" data-name="show3DButton" :disabled="!state"
      :title="state?.shown ? 'Hide the segments in the 3D views' : 'Show the segments in the 3D views'"
      class="sw-button inline-flex min-h-7 items-center rounded-l-md px-3 py-0.5 text-[13px] leading-tight transition-colors disabled:opacity-40"
      :class="state?.shown ? 'bg-primary text-primary-foreground hover:bg-primary/85' : 'bg-secondary/60 text-secondary-foreground hover:bg-secondary'"
      @click="set({ showSurfaces: !state?.shown })">Show 3D</button>
    <PopupMenu align="right">
      <template #trigger="{ open, toggle }">
        <button type="button" data-name="show3DMenu" title="Representation and smoothing in 3D views" :disabled="!state"
          class="inline-flex min-h-7 items-center rounded-r-md border-l border-background/40 px-1 transition-colors disabled:opacity-40"
          :class="state?.shown || open ? 'bg-primary text-primary-foreground hover:bg-primary/85' : 'bg-secondary/60 text-secondary-foreground hover:bg-secondary'"
          @click="toggle"><ChevronDown :size="13" /></button>
      </template>
      <template v-if="state">
        <div class="px-2 pb-0.5 pt-1 text-[11px] uppercase tracking-wide text-muted-foreground">Representation</div>
        <button v-for="r in REPRESENTATIONS" :key="r.name" type="button" role="menuitemradio" :aria-checked="state.representation3D === r.name"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60" :title="r.tip"
          :data-name="`show3DRepresentation-${r.name.replace(' ', '')}`" @click="set({ representation3D: r.name })">
          <Check :size="14" :class="state.representation3D === r.name ? '' : 'invisible'" />{{ r.name }}</button>
        <div class="my-1 border-t border-input" />
        <!-- clicks on the slider must not close the menu -->
        <div class="px-2 py-1" data-name="show3DSmoothing" @click.stop>
          <div class="text-[13px]" title="Higher value means smoother surfaces">Smoothing factor</div>
          <SwSlider :value="state.smoothingFactor" :minimum="0" :maximum="1" :single-step="0.1" :decimals="2" :tracking="false"
            @value-changed="set({ smoothingFactor: $event })" />
        </div>
      </template>
    </PopupMenu>
  </div>
</template>

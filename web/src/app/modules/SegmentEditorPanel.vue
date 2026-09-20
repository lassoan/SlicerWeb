<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import { Brush, Eraser, SlidersHorizontal, Undo2, Redo2, Plus, Minus, Sparkles, Waves, Eraser as ClearIcon, MousePointer2 } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwCheckBox, SwFormRow, SwNodeSelector, SwRangeSlider, SwSlider, SwButton, SwComboBox } from "@/widgets";

interface EditorState {
  segmentationNodeID: string | null;
  sourceVolumeNodeID: string | null;
  segments: { id: string; name: string; color: string }[];
  currentSegmentID: string | null;
  effect: string | null;
  brushRadius: number;
  sphereBrush: boolean;
  show3D: boolean;
  canUndo: boolean;
  canRedo: boolean;
  scalarRange: number[];
  maskMode: number;
  overwriteMode: number;
}

const bridge = inject<SlicerBridge>("bridge")!;
const state = ref<EditorState | null>(null);
const threshold = ref<[number, number]>([0, 0]);
const smoothing = ref(3);
const error = ref("");

async function refresh() {
  state.value = await bridge.call<EditorState>("segmentEditorState");
}

async function run<T>(method: string, args: unknown[] = []) {
  error.value = "";
  try {
    const result = await bridge.call<T>(method, args);
    await refresh();
    return result;
  } catch (e: any) {
    error.value = e.message ?? String(e);
  }
}

async function setup(segmentationID: string | null, volumeID: string | null) {
  state.value = await bridge.call<EditorState>("segmentEditorSetup", [segmentationID, volumeID]);
  const r = state.value.scalarRange;
  if (threshold.value[0] === threshold.value[1]) threshold.value = [r[0] + (r[1] - r[0]) * 0.3, r[1]];
}

const effects = [
  { name: null, label: "None", icon: MousePointer2 },
  { name: "Paint", label: "Paint", icon: Brush },
  { name: "Erase", label: "Erase", icon: Eraser },
  { name: "Threshold", label: "Threshold", icon: SlidersHorizontal },
  { name: "Islands", label: "Islands", icon: Sparkles },
  { name: "Smoothing", label: "Smoothing", icon: Waves },
  { name: "Clear", label: "Clear", icon: ClearIcon },
];
const maskModes = ["Everywhere", "Inside all segments", "Inside all visible segments", "Outside all segments", "Outside all visible segments"];
const overwriteModes = ["All segments", "Visible segments", "None"];
const current = computed(() => state.value?.segments.find((s) => s.id === state.value?.currentSegmentID));

const off = bridge.events.on("segment-editor-changed", () => refresh());
onMounted(refresh);
onBeforeUnmount(() => {
  off();
  bridge.call("segmentEditorSetEffect", [null]);
});
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Segmentation">
      <SwNodeSelector node-types="vtkMRMLSegmentationNode" add-enabled base-name="Segmentation" :current-node-id="state?.segmentationNodeID"
        @current-node-changed="setup($event, state?.sourceVolumeNodeID ?? null)" />
    </SwFormRow>
    <SwFormRow label="Source volume">
      <SwNodeSelector node-types="vtkMRMLScalarVolumeNode" :current-node-id="state?.sourceVolumeNodeID"
        @current-node-changed="setup(state?.segmentationNodeID ?? null, $event)" />
    </SwFormRow>
    <template v-if="state?.segmentationNodeID">
      <div class="flex items-center gap-1">
        <SwButton @clicked="run('segmentEditorAddSegment')"><Plus :size="14" />Add</SwButton>
        <SwButton @clicked="run('segmentEditorRemoveSegment')"><Minus :size="14" />Remove</SwButton>
        <SwButton text="Show 3D" :primary="state.show3D" data-name="show3DButton"
          :tool-tip="state.show3D ? 'Hide the segments in the 3D views' : 'Show the segments in the 3D views'"
          @clicked="run('segmentEditorShow3D', [!state.show3D])" />
        <div class="flex-1" />
        <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight disabled:opacity-30" :disabled="!state.canUndo" title="Undo"
          @click="run('segmentEditorUndo')"><Undo2 :size="16" /></button>
        <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight disabled:opacity-30" :disabled="!state.canRedo" title="Redo"
          @click="run('segmentEditorRedo')"><Redo2 :size="16" /></button>
      </div>
      <div class="max-h-48 overflow-y-auto rounded-md border border-input/60">
        <button v-for="s in state.segments" :key="s.id" type="button" class="flex w-full items-center gap-2 px-2 py-1 text-left text-[13px]"
          :class="s.id === state.currentSegmentID ? 'bg-accent text-foreground' : 'hover:bg-accent/40'"
          @click="run('segmentEditorSelectSegment', [s.id])">
          <span class="h-3 w-3 rounded-sm" :style="{ background: s.color }" />{{ s.name }}
        </button>
        <div v-if="!state.segments.length" class="p-2 text-[12px] text-muted-foreground">Add a segment to start editing.</div>
      </div>
      <div class="grid grid-cols-4 gap-1">
        <button v-for="e in effects" :key="e.label" type="button"
          class="flex flex-col items-center gap-0.5 rounded-md py-1.5 text-[11px]"
          :class="state.effect === e.name ? 'bg-highlight text-background' : 'bg-card text-foreground/85 hover:bg-accent'"
          @click="run('segmentEditorSetEffect', [e.name])">
          <component :is="e.icon" :size="16" />{{ e.label }}
        </button>
      </div>
      <div v-if="state.effect" class="rounded-md bg-card/70 p-2">
        <template v-if="state.effect === 'Paint' || state.effect === 'Erase'">
          <div class="mb-1 text-[12px] text-muted-foreground">Left-click and drag in a slice view to {{ state.effect.toLowerCase() }} {{ current?.name ?? '' }}.</div>
          <SwFormRow label="Brush radius">
            <SwSlider :value="state.brushRadius" :minimum="0.5" :maximum="50" :single-step="0.5" :decimals="1" suffix="mm"
              @value-changed="run('segmentEditorSetBrush', [$event])" />
          </SwFormRow>
          <SwCheckBox text="Sphere brush" :checked="state.sphereBrush" @toggled="run('segmentEditorSetBrush', [null, $event])" />
        </template>
        <template v-else-if="state.effect === 'Threshold'">
          <SwRangeSlider :minimum="state.scalarRange[0]" :maximum="state.scalarRange[1]" :minimum-value="threshold[0]" :maximum-value="threshold[1]"
            @values-changed="(lo: number, hi: number) => (threshold = [lo, hi])" />
          <SwButton text="Apply" primary class="mt-1" @clicked="run('segmentEditorApply', ['Threshold', { lower: threshold[0], upper: threshold[1] }])" />
        </template>
        <template v-else-if="state.effect === 'Islands'">
          <div class="mb-1 text-[12px] text-muted-foreground">Keep the largest connected region of the selected segment.</div>
          <SwButton text="Apply" primary @clicked="run('segmentEditorApply', ['Islands'])" />
        </template>
        <template v-else-if="state.effect === 'Smoothing'">
          <SwFormRow label="Kernel size"><SwSlider :value="smoothing" :minimum="1" :maximum="15" :decimals="1" suffix="mm" @value-changed="smoothing = $event" /></SwFormRow>
          <SwButton text="Apply median smoothing" primary class="mt-1" @clicked="run('segmentEditorApply', ['Smoothing', { kernelSizeMm: smoothing }])" />
        </template>
        <template v-else-if="state.effect === 'Clear'">
          <SwButton text="Clear selected segment" primary @clicked="run('segmentEditorApply', ['Clear'])" />
        </template>
      </div>
      <details class="text-[12px]">
        <summary class="cursor-pointer text-muted-foreground">Masking</summary>
        <div class="mt-1 flex flex-col gap-1">
          <SwFormRow label="Editable area"><SwComboBox :items="maskModes" :current-index="state.maskMode" @current-index-changed="run('segmentEditorSetMasking', [$event, null])" /></SwFormRow>
          <SwFormRow label="Modify other segments"><SwComboBox :items="overwriteModes" :current-index="state.overwriteMode" @current-index-changed="run('segmentEditorSetMasking', [null, $event])" /></SwFormRow>
        </div>
      </details>
    </template>
    <div v-if="error" class="rounded bg-destructive/40 px-2 py-1 text-[12px]">{{ error }}</div>
  </div>
</template>

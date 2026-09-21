<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Brush, Eraser, SlidersHorizontal, Undo2, Redo2, Plus, Minus, Sparkles, Waves, Eraser as ClearIcon,
  MousePointer2, Sprout, Layers, Expand, CircleDashed, Combine } from "@lucide/vue";
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
}

// What the threshold effect offers is the values of the volume being segmented, so the slider
// takes its range from that volume as soon as it is chosen, and again whenever the volume is
// written to. A volume the editor has not seen before starts where Slicer starts it, a quarter of
// the way up the range; values the person set on this volume are kept, and only pulled back into
// the range if what is in the volume has changed under them.
const thresholdVolumeID = ref<string | null>(null);
watch(
  () => [state.value?.sourceVolumeNodeID, state.value?.scalarRange?.[0], state.value?.scalarRange?.[1]].join(),
  () => {
    const range = state.value?.scalarRange;
    const volumeID = state.value?.sourceVolumeNodeID ?? null;
    if (!range || !volumeID) return;
    const [low, high] = [range[0], range[1]];
    if (volumeID !== thresholdVolumeID.value) {
      thresholdVolumeID.value = volumeID;
      threshold.value = [low + (high - low) * 0.25, high];
      return;
    }
    const [minimum, maximum] = threshold.value;
    const clamped: [number, number] = [Math.min(Math.max(minimum, low), high), Math.min(Math.max(maximum, low), high)];
    threshold.value = clamped[0] < clamped[1] ? clamped : [low + (high - low) * 0.25, high];
  },
  { immediate: true },
);
// A thousand steps across the range, as the threshold effect of Slicer has
const thresholdStep = computed(() => {
  const range = state.value?.scalarRange ?? [0, 1];
  return Math.max((range[1] - range[0]) / 1000, 1e-6);
});

const effects = [
  { name: null, label: "None", icon: MousePointer2 },
  { name: "Paint", label: "Paint", icon: Brush },
  { name: "Erase", label: "Erase", icon: Eraser },
  { name: "Threshold", label: "Threshold", icon: SlidersHorizontal },
  { name: "GrowFromSeeds", label: "Grow from seeds", icon: Sprout },
  { name: "FillBetweenSlices", label: "Fill between slices", icon: Layers },
  { name: "Margin", label: "Margin", icon: Expand },
  { name: "Hollow", label: "Hollow", icon: CircleDashed },
  { name: "Logic", label: "Logical operators", icon: Combine },
  { name: "Islands", label: "Islands", icon: Sparkles },
  { name: "Smoothing", label: "Smoothing", icon: Waves },
  { name: "Clear", label: "Clear", icon: ClearIcon },
];
const shellModes = [
  { value: "inside", label: "Inside the surface" },
  { value: "medial", label: "Across the surface" },
  { value: "outside", label: "Outside the surface" },
];
const logicalOperations = [
  { value: "copy", label: "Copy", needsOther: true },
  { value: "add", label: "Add", needsOther: true },
  { value: "subtract", label: "Subtract", needsOther: true },
  { value: "intersect", label: "Intersect", needsOther: true },
  { value: "invert", label: "Invert", needsOther: false },
  { value: "fill", label: "Fill", needsOther: false },
  { value: "clear", label: "Clear", needsOther: false },
];

// what the effects that have something to set are set to
const marginMm = ref(3);
const hollowThicknessMm = ref(3);
const shellMode = ref("inside");
const logicalOperation = ref("copy");
const otherSegmentID = ref<string | null>(null);
const seedLocality = ref(0);

const otherSegments = computed(() => (state.value?.segments ?? []).filter((s) => s.id !== state.value?.currentSegmentID));
const operationNeedsOther = computed(() => logicalOperations.find((o) => o.value === logicalOperation.value)?.needsOther ?? false);
watch(otherSegments, (segments) => {
  if (!segments.some((s) => s.id === otherSegmentID.value)) otherSegmentID.value = segments[0]?.id ?? null;
}, { immediate: true });
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
            :single-step="thresholdStep" :decimals="thresholdStep < 0.1 ? 3 : 1"
            @values-changed="(lo: number, hi: number) => (threshold = [lo, hi])" />
          <SwButton text="Apply" primary class="mt-1" @clicked="run('segmentEditorApply', ['Threshold', { lower: threshold[0], upper: threshold[1] }])" />
        </template>
        <template v-else-if="state.effect === 'GrowFromSeeds'">
          <div class="mb-1 text-[12px] text-muted-foreground">
            Paint a little of each structure, and a little of what is around them, then grow: every
            other voxel goes to the segment it resembles most, following the edges in the volume.
          </div>
          <SwFormRow label="Keep seeds local">
            <SwSlider :value="seedLocality" :minimum="0" :maximum="0.5" :single-step="0.01" :decimals="2"
              @value-changed="seedLocality = $event" />
          </SwFormRow>
          <SwButton text="Grow from seeds" primary class="mt-1"
            @clicked="run('segmentEditorApply', ['GrowFromSeeds', { seedLocality }])" />
        </template>
        <template v-else-if="state.effect === 'FillBetweenSlices'">
          <div class="mb-1 text-[12px] text-muted-foreground">
            Segment the structure on every few slices; the slices between them are filled in, the
            outline growing from one segmented slice to the next.
          </div>
          <SwButton text="Fill between slices" primary @clicked="run('segmentEditorApply', ['FillBetweenSlices'])" />
        </template>
        <template v-else-if="state.effect === 'Margin'">
          <div class="mb-1 text-[12px] text-muted-foreground">Grow the segment, or shrink it where the margin is below zero.</div>
          <SwFormRow label="Margin">
            <SwSlider :value="marginMm" :minimum="-20" :maximum="20" :single-step="0.5" :decimals="1" suffix="mm"
              @value-changed="marginMm = $event" />
          </SwFormRow>
          <SwButton :text="marginMm < 0 ? 'Shrink' : 'Grow'" primary class="mt-1"
            @clicked="run('segmentEditorApply', ['Margin', { marginMm }])" />
        </template>
        <template v-else-if="state.effect === 'Hollow'">
          <div class="mb-1 text-[12px] text-muted-foreground">Keep a shell where the segment is now, and empty out the rest of it.</div>
          <SwFormRow label="Shell thickness">
            <SwSlider :value="hollowThicknessMm" :minimum="0.5" :maximum="20" :single-step="0.5" :decimals="1" suffix="mm"
              @value-changed="hollowThicknessMm = $event" />
          </SwFormRow>
          <SwFormRow label="Shell goes">
            <SwComboBox :current-index="shellModes.findIndex((m) => m.value === shellMode)"
              :items="shellModes.map((m) => m.label)"
              @current-index-changed="shellMode = shellModes[$event].value" />
          </SwFormRow>
          <SwButton text="Hollow" primary class="mt-1"
            @clicked="run('segmentEditorApply', ['Hollow', { thicknessMm: hollowThicknessMm, shellMode }])" />
        </template>
        <template v-else-if="state.effect === 'Logic'">
          <SwFormRow label="Operation">
            <SwComboBox :current-index="logicalOperations.findIndex((o) => o.value === logicalOperation)"
              :items="logicalOperations.map((o) => o.label)"
              @current-index-changed="logicalOperation = logicalOperations[$event].value" />
          </SwFormRow>
          <SwFormRow v-if="operationNeedsOther" label="Other segment">
            <SwComboBox :current-index="Math.max(0, otherSegments.findIndex((s) => s.id === otherSegmentID))"
              :items="otherSegments.map((s) => s.name)"
              @current-index-changed="otherSegmentID = otherSegments[$event]?.id ?? null" />
          </SwFormRow>
          <div v-if="operationNeedsOther && !otherSegments.length" class="text-[12px] text-muted-foreground">
            Add another segment to {{ logicalOperation }} with.
          </div>
          <SwButton text="Apply" primary class="mt-1" :enabled="!operationNeedsOther || !!otherSegmentID"
            @clicked="run('segmentEditorApply', ['Logic', { operation: logicalOperation, modifierSegmentID: otherSegmentID }])" />
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

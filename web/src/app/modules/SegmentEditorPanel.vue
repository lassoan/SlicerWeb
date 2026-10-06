<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Brush, Eraser, SlidersHorizontal, Undo2, Redo2, Plus, Minus, Sparkles, Waves,
  MousePointer2, Sprout, Layers, Expand, CircleDashed, Combine, PenLine, Scissors, SquareDashed, Eye, EyeOff } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwCheckBox, SwFormRow, SwNodeSelector, SwRangeSlider, SwSlider, SwSpinBox, SwButton, SwComboBox } from "@/widgets";
import SegmentList from "../components/SegmentList.vue";
import Show3DButton from "../components/Show3DButton.vue";
import { store } from "../store";

interface EditorState {
  segmentationNodeID: string | null;
  sourceVolumeNodeID: string | null;
  segments: { id: string; name: string; color: string }[];
  currentSegmentID: string | null;
  effect: string | null;
  /** Another mouse mode has the views: the effect waits until its own is chosen again */
  suspended: boolean;
  brushRadius: number;
  sphereBrush: boolean;
  show3D: boolean;
  canUndo: boolean;
  canRedo: boolean;
  scalarRange: number[];
  maskMode: number;
  overwriteMode: number;
  /** What the effects are set to, by effect and parameter (the desktop's parameter names) */
  effectParameters: Record<string, Record<string, number | string>>;
  /** The result of Grow from seeds or Fill between slices, shown before it is applied */
  preview: { effect: string; opacity: number; show3D: boolean; computing: boolean } | null;
  maskVolume: { inputVolumeNodeID: string | null; outputVolumeNodeID: string | null; inputVisible: boolean; outputVisible: boolean };
  smoothing: { kernelSizePixel: number[] } | null;
  margin: { feasible: boolean; actual: string } | null;
}

const bridge = inject<SlicerBridge>("bridge")!;
const state = ref<EditorState | null>(null);
const threshold = ref<[number, number]>([0, 0]);
const error = ref("");
// Double-clicking a segment asks what it is, the way the desktop Segment Editor does: the choice
// names the segment and colours it from the terminology.

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

// A segment picked in the Data tree while the editor is open is the one edited: its segmentation
// is taken (with the volume being segmented) and the segment selected
async function takePickedSegment() {
  const [segmentationID, segmentID] = [store.selectedNodeID, store.selectedSegmentID];
  if (!state.value || !segmentID || !segmentationID || store.selectedNodeClass !== "vtkMRMLSegmentationNode") return;
  if (state.value.segmentationNodeID !== segmentationID) await setup(segmentationID, state.value.sourceVolumeNodeID);
  if (state.value?.currentSegmentID !== segmentID) await run("segmentEditorSelectSegment", [segmentID]);
}
watch(() => [store.selectedSegmentID, store.selectedNodeID], takePickedSegment);

/** A segment chosen in the editor's list is also the one the tree shows as selected. */
async function selectSegment(segmentID: string) {
  await run("segmentEditorSelectSegment", [segmentID]);
  if (state.value?.segmentationNodeID) {
    store.selectedNodeClass = "vtkMRMLSegmentationNode";
    store.selectedNodeID = state.value.segmentationNodeID;
    store.selectedSegmentID = segmentID;
  }
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
// What the threshold would fill is shown while the effect is active, as on the desktop (and in 3D
// views too). The slider moves often: one update at a time, the latest range last.
let previewPending: [number, number] | null = null;
let previewBusy = false;
async function updateThresholdPreview() {
  if (state.value?.effect !== "Threshold" || !state.value.currentSegmentID) return;
  previewPending = [threshold.value[0], threshold.value[1]];
  if (previewBusy) return;
  previewBusy = true;
  try {
    while (previewPending) {
      const range = previewPending;
      previewPending = null;
      await bridge.call("segmentEditorThresholdPreview", range).catch(() => {});
    }
  } finally {
    previewBusy = false;
  }
}
watch(() => [state.value?.effect, state.value?.currentSegmentID, state.value?.sourceVolumeNodeID, threshold.value[0], threshold.value[1]].join(),
  updateThresholdPreview);
// A thousand steps across the range, as the threshold effect of Slicer has
const thresholdStep = computed(() => {
  const range = state.value?.scalarRange ?? [0, 1];
  return Math.max((range[1] - range[0]) / 1000, 1e-6);
});

// In the order of the desktop Segment Editor
const effects = [
  { name: null, label: "None", icon: MousePointer2 },
  { name: "Paint", label: "Paint", icon: Brush },
  { name: "Draw", label: "Draw", icon: PenLine },
  { name: "Erase", label: "Erase", icon: Eraser },
  { name: "GrowFromSeeds", label: "Grow from seeds", icon: Sprout },
  { name: "FillBetweenSlices", label: "Fill between slices", icon: Layers },
  { name: "Threshold", label: "Threshold", icon: SlidersHorizontal },
  { name: "Margin", label: "Margin", icon: Expand },
  { name: "Hollow", label: "Hollow", icon: CircleDashed },
  { name: "Smoothing", label: "Smoothing", icon: Waves },
  { name: "Scissors", label: "Scissors", icon: Scissors },
  { name: "Islands", label: "Islands", icon: Sparkles },
  { name: "Logic", label: "Logical operators", icon: Combine },
  { name: "MaskVolume", label: "Mask volume", icon: SquareDashed },
];
const scissorsOperations = [
  { value: "EraseInside", label: "Erase inside" },
  { value: "EraseOutside", label: "Erase outside" },
  { value: "FillInside", label: "Fill inside" },
  { value: "FillOutside", label: "Fill outside" },
];
const scissorsShapes = [
  { value: "FreeForm", label: "Free-form" },
  { value: "Circle", label: "Circle" },
  { value: "Rectangle", label: "Rectangle" },
];
const sliceCutModes = [
  { value: "Unlimited", label: "Unlimited", toolTip: "Cut through the entire segmentation. Only used for slice views." },
  { value: "Positive", label: "Positive", toolTip: "Only positive side of the slice plane is included in cut region. Only used for slice views." },
  { value: "Negative", label: "Negative", toolTip: "Only negative side of the slice plane is included in cut region. Only used for slice views." },
  { value: "Symmetric", label: "Symmetric", toolTip: "Cut region is limited to the specified thickness around the slice plane. Only used for slice views." },
];
const islandOperations = [
  { value: "KEEP_LARGEST_ISLAND", label: "Keep largest island", toolTip: "Keep only the largest island in selected segment, remove all other islands in the segment." },
  { value: "REMOVE_SMALL_ISLANDS", label: "Remove small islands", toolTip: "Remove all islands from the selected segment that are smaller than the specified minimum size." },
  { value: "SPLIT_ISLANDS_TO_SEGMENTS", label: "Split islands to segments", toolTip: "Create a new segment for each island of selected segment. Islands smaller than minimum size will be removed. Segments will be ordered by island size." },
  { value: "KEEP_SELECTED_ISLAND", label: "Keep selected island", toolTip: "Click on an island in a slice view to keep that island and remove all other islands in selected segment." },
  { value: "REMOVE_SELECTED_ISLAND", label: "Remove selected island", toolTip: "Click on an island in a slice view to remove it from selected segment." },
  { value: "ADD_SELECTED_ISLAND", label: "Add selected island", toolTip: "Click on a region in a slice view to add it to selected segment." },
];
const islandSelectionRequired = computed(() =>
  ["KEEP_SELECTED_ISLAND", "REMOVE_SELECTED_ISLAND", "ADD_SELECTED_ISLAND"].includes(parameter("Islands", "Operation")));
const smoothingMethods = [
  { value: "MEDIAN", label: "Median" },
  { value: "MORPHOLOGICAL_OPENING", label: "Opening (remove extrusions)" },
  { value: "MORPHOLOGICAL_CLOSING", label: "Closing (fill holes)" },
  { value: "GAUSSIAN", label: "Gaussian" },
  { value: "JOINT_TAUBIN", label: "Joint smoothing" },
];
const maskVolumeOperations = [
  { value: "FILL_INSIDE", label: "Fill inside" },
  { value: "FILL_OUTSIDE", label: "Fill outside" },
  { value: "FILL_INSIDE_AND_OUTSIDE", label: "Fill inside and outside" },
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
const hollowThicknessMm = ref(3);
const shellMode = ref("inside");
const logicalOperation = ref("copy");
const otherSegmentID = ref<string | null>(null);

/** A parameter of an effect, as the segment editor node has it. */
function parameter(effect: string, name: string): any {
  return state.value?.effectParameters?.[effect]?.[name];
}
function setParameter(effect: string, name: string, value: number | string | boolean) {
  return run("segmentEditorSetEffectParameter", [effect, name, typeof value === "boolean" ? Number(value) : value]);
}

// Grow from seeds and Fill between slices: a preview of the result is computed (Initialize), kept up
// to date while the inputs are edited (Auto-update), and replaces the segments when applied
const isAutoComplete = computed(() => state.value?.effect === "GrowFromSeeds" || state.value?.effect === "FillBetweenSlices");
const previewShown = computed(() => !!state.value?.preview && state.value.preview.effect === state.value.effect);
const computing = ref(false);
async function preview() {
  computing.value = true;
  try {
    await run("segmentEditorPreview", [state.value?.effect]);
  } finally {
    computing.value = false;
  }
}
// The opacity slider moves often: one call at a time, the latest value last
let opacityPending: number | null = null;
let opacityBusy = false;
async function setPreviewOpacity(opacity: number) {
  opacityPending = opacity;
  if (opacityBusy) return;
  opacityBusy = true;
  try {
    while (opacityPending !== null) {
      const value = opacityPending;
      opacityPending = null;
      await bridge.call("segmentEditorSetPreviewDisplay", [value, null]);
    }
  } finally {
    opacityBusy = false;
  }
}
// Touch screens have no double click, right button or keys: a double tap applies the outline
const touchScreen = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

const otherSegments = computed(() => (state.value?.segments ?? []).filter((s) => s.id !== state.value?.currentSegmentID));
// As the desktop says which way the other segment is used
const modifierSegmentLabel = computed(() => ({ copy: "Copy from segment", add: "Add segment", subtract: "Subtract segment",
  intersect: "Intersect with segment" } as Record<string, string>)[logicalOperation.value] ?? "Modifier segment");
const operationNeedsOther = computed(() => logicalOperations.find((o) => o.value === logicalOperation.value)?.needsOther ?? false);
watch(otherSegments, (segments) => {
  if (!segments.some((s) => s.id === otherSegmentID.value)) otherSegmentID.value = segments[0]?.id ?? null;
}, { immediate: true });
const maskModes = ["Everywhere", "Inside all segments", "Inside all visible segments", "Outside all segments", "Outside all visible segments"];
const overwriteModes = ["All segments", "Visible segments", "None"];
const current = computed(() => state.value?.segments.find((s) => s.id === state.value?.currentSegmentID));

/** What an effect is called in the panel. */
function effectLabel(name: string | null) {
  return effects.find((e) => e.name === name)?.label ?? name ?? "";
}

/** Why an effect cannot be used now, if it cannot: every effect works on a segment. */
function unusable(effect: string | null): string {
  if (!effect) return "";
  if (!state.value?.segments.length) return "Add a segment first";
  return "";
}

const off = bridge.events.on("segment-editor-changed", () => refresh());
// There is nothing to edit in an empty scene, and every effect needs a segmentation, so the module
// makes one when it is opened - the Segment Editor of the desktop offers to, this does it.
onMounted(async () => {
  state.value = await bridge.call<EditorState>("segmentEditorEnsureSegmentation");
  await takePickedSegment();
});
// The effect is not stopped when the panel goes: on a phone the panel is closed to see the views,
// and to paint in them. It is stopped when another module is opened (App.vue), as on the desktop.
onBeforeUnmount(() => {
  off();
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
        <Show3DButton :segmentation-node-id="state.segmentationNodeID" @changed="refresh()" />
        <div class="flex-1" />
        <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight disabled:opacity-30" :disabled="!state.canUndo" title="Undo"
          @click="run('segmentEditorUndo')"><Undo2 :size="16" /></button>
        <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight disabled:opacity-30" :disabled="!state.canRedo" title="Redo"
          @click="run('segmentEditorRedo')"><Redo2 :size="16" /></button>
      </div>
      <!-- The same list as the Segmentations module's: choose, rename, colour and terminology, show, remove -->
      <SegmentList :segmentation-node-id="state.segmentationNodeID" :current-id="state.currentSegmentID"
        @select="selectSegment($event)" @changed="refresh">
        <template #empty>Add a segment to start editing.</template>
      </SegmentList>
      <div class="grid grid-cols-4 gap-1">
        <button v-for="e in effects" :key="e.label" type="button" :disabled="!!unusable(e.name)"
          class="flex flex-col items-center gap-0.5 rounded-md py-1.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
          :class="state.effect === e.name ? 'bg-highlight text-background' : 'bg-card text-foreground/85 enabled:hover:bg-accent'"
          :title="unusable(e.name) || e.label" @click="run('segmentEditorSetEffect', [e.name])">
          <component :is="e.icon" :size="16" />{{ e.label }}
        </button>
      </div>
      <!-- A preview of Grow from seeds or Fill between slices that is kept up to date while another
           effect (Paint, say) adds to its inputs -->
      <div v-if="state.preview && state.preview.effect !== state.effect" data-name="backgroundPreview"
        class="flex items-center gap-2 rounded-md bg-accent/60 px-2 py-1.5 text-[12px]">
        <span class="flex-1">{{ effectLabel(state.preview.effect) }} preview is shown{{
          parameter(state.preview.effect, "AutoUpdate") ? ", and updated as the segments are edited" : "" }}.</span>
        <SwButton text="Switch" :tool-tip="`Switch to ${effectLabel(state.preview.effect)}`" @clicked="run('segmentEditorSetEffect', [state.preview.effect])" />
      </div>
      <div v-if="state.effect" class="rounded-md bg-card/70 p-2">
        <div v-if="state.suspended" class="mb-1 flex items-center gap-2 rounded bg-accent/60 px-2 py-1 text-[12px]">
          <span class="flex-1">Another mouse mode is in use: the views do not edit until this effect is resumed.</span>
          <SwButton text="Resume" @clicked="run('segmentEditorSuspend', [false])" />
        </div>
        <template v-if="state.effect === 'Paint' || state.effect === 'Erase'">
          <div class="mb-1 text-[12px] text-muted-foreground">Left-click and drag in a slice view to {{ state.effect.toLowerCase() }} {{ current?.name ?? '' }}.</div>
          <SwFormRow label="Brush radius">
            <SwSlider :value="state.brushRadius" :minimum="0.5" :maximum="50" :single-step="0.5" :decimals="1" suffix="mm"
              @value-changed="run('segmentEditorSetBrush', [$event])" />
          </SwFormRow>
          <div class="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1">
            <SwCheckBox text="Sphere brush" :checked="state.sphereBrush" @toggled="run('segmentEditorSetBrush', [null, $event])" />
            <SwCheckBox text="Edit in 3D views" :checked="!!parameter(state.effect, 'EditIn3DViews')"
              tool-tip="Allow painting in 3D views. If enabled, click-and-drag in a 3D view paints in the view instead of rotating the view."
              @toggled="setParameter(state.effect!, 'EditIn3DViews', $event)" />
          </div>
        </template>
        <template v-else-if="state.effect === 'Threshold'">
          <SwRangeSlider :minimum="state.scalarRange[0]" :maximum="state.scalarRange[1]" :minimum-value="threshold[0]" :maximum-value="threshold[1]"
            :single-step="thresholdStep" :decimals="thresholdStep < 0.1 ? 3 : 1"
            @values-changed="(lo: number, hi: number) => (threshold = [lo, hi])" />
          <SwButton text="Apply" primary class="mt-1 w-full" @clicked="run('segmentEditorApply', ['Threshold', { lower: threshold[0], upper: threshold[1] }])" />
        </template>
        <template v-else-if="state.effect === 'Draw'">
          <div class="text-[12px] text-muted-foreground">
            <template v-if="touchScreen">Tap or drag in a slice view to add points to the outline of {{ current?.name ?? '' }}; double-tap to fill it.</template>
            <template v-else>
              Draw the outline of {{ current?.name ?? '' }} in a slice view. <b>Left-click:</b> add point. <b>Left-button drag:</b> add
              multiple points. <b>x:</b> delete last point. <b>Double-click</b>, <b>right-click</b>, <b>a</b> or <b>Enter</b>: apply outline.
            </template>
          </div>
        </template>
        <template v-else-if="isAutoComplete">
          <div class="mb-1 text-[12px] text-muted-foreground">
            <template v-if="state.effect === 'GrowFromSeeds'">
              Paint seeds in each region that should belong to a separate segment - at least two segments, one of them
              for what is around the structure - and click Initialize. Browse the slices, and where the result is not
              right add seeds with Paint: the preview is updated a moment later. Apply replaces the segments by it.
            </template>
            <template v-else>
              Segment the structure on every few slices, leaving at least one empty slice between them, and click
              Initialize: the slices between are filled in. All visible segments are interpolated. Apply replaces the
              segments by the preview.
            </template>
          </div>
          <SwFormRow v-if="state.effect === 'GrowFromSeeds'" label="Seed locality">
            <SwSlider :value="Number(parameter('GrowFromSeeds', 'SeedLocalityFactor') ?? 0)" :minimum="0" :maximum="10" :single-step="0.1" :decimals="1"
              :tracking="false" @value-changed="setParameter('GrowFromSeeds', 'SeedLocalityFactor', $event)" />
          </SwFormRow>
          <SwFormRow label="Preview">
            <div class="flex items-center gap-2">
              <SwCheckBox text="Auto-update" :enabled="previewShown" :checked="!!parameter(state.effect!, 'AutoUpdate')"
                tool-tip="Auto-update results preview when input segments change."
                @toggled="setParameter(state.effect!, 'AutoUpdate', $event)" />
              <SwButton class="flex-1" :text="computing || state.preview?.computing ? 'Computing...' : previewShown ? 'Update' : 'Initialize'"
                :enabled="!computing" tool-tip="Preview complete segmentation" @clicked="preview()" />
            </div>
          </SwFormRow>
          <!-- The whole width: the slider moves between what was painted and what the effect made of it -->
          <div class="mt-1 flex items-center gap-1.5 text-[12px]">
            <span class="text-muted-foreground">Display: inputs</span>
            <SwSlider class="min-w-[60px] flex-1" :value="state.preview?.opacity ?? 0" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2"
              :spin-box-visible="false" :enabled="previewShown" @value-changed="setPreviewOpacity($event)" />
            <span class="text-muted-foreground">results</span>
            <SwButton text="Show 3D" checkable :checked="!!state.preview?.show3D" :enabled="previewShown" tool-tip="Preview results in 3D."
              @toggled="run('segmentEditorSetPreviewDisplay', [null, $event])" />
          </div>
          <div class="mt-1 flex gap-1">
            <SwButton class="flex-1" text="Cancel" :enabled="previewShown" tool-tip="Clear preview and cancel auto-complete"
              @clicked="run('segmentEditorCancelPreview')" />
            <SwButton class="flex-1" text="Apply" primary :enabled="previewShown" tool-tip="Replace segments by previewed result"
              @clicked="run('segmentEditorApplyPreview')" />
          </div>
        </template>
        <template v-else-if="state.effect === 'Scissors'">
          <div class="mb-1 text-[12px] text-muted-foreground">
            Drag in a slice or 3D view to sweep out an outline: the segment is cut through, from the viewpoint of the view.
          </div>
          <div class="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
            <div class="flex flex-col items-start gap-0.5">
              <div class="text-muted-foreground">Operation:</div>
              <SwCheckBox v-for="o in scissorsOperations" :key="o.value" radio :text="o.label" :checked="parameter('Scissors', 'Operation') === o.value"
                @toggled="$event && setParameter('Scissors', 'Operation', o.value)" />
            </div>
            <div class="flex flex-col items-start gap-0.5">
              <div class="text-muted-foreground">Shape:</div>
              <SwCheckBox v-for="s in scissorsShapes" :key="s.value" radio :text="s.label" :checked="parameter('Scissors', 'Shape') === s.value"
                @toggled="$event && setParameter('Scissors', 'Shape', s.value)" />
              <SwCheckBox text="Centered" :checked="!!parameter('Scissors', 'ShapeDrawCentered')" :enabled="parameter('Scissors', 'Shape') !== 'FreeForm'"
                tool-tip="If checked, click position sets the circle or rectangle center, otherwise click position is at the shape boundary."
                @toggled="setParameter('Scissors', 'ShapeDrawCentered', $event)" />
            </div>
            <div class="flex flex-col items-start gap-0.5">
              <div class="text-muted-foreground" title="Restrict cut region in slice views.">Slice cut:</div>
              <SwCheckBox v-for="m in sliceCutModes" :key="m.value" radio :text="m.label" :tool-tip="m.toolTip" :checked="parameter('Scissors', 'SliceCutMode') === m.value"
                @toggled="$event && setParameter('Scissors', 'SliceCutMode', m.value)" />
              <SwSpinBox :value="Number(parameter('Scissors', 'SliceCutDepthMm') ?? 0)" :minimum="0" :maximum="1000" :single-step="0.5" :decimals="1" suffix="mm"
                :enabled="parameter('Scissors', 'SliceCutMode') === 'Symmetric'" @value-changed="setParameter('Scissors', 'SliceCutDepthMm', $event)" />
            </div>
            <div class="self-end">
              <SwCheckBox text="Apply to visible segments" :checked="!!parameter('Scissors', 'ApplyToAllVisibleSegments')"
                tool-tip="Apply scissor effect to all visible segments from top to bottom."
                @toggled="setParameter('Scissors', 'ApplyToAllVisibleSegments', $event)" />
            </div>
          </div>
        </template>
        <template v-else-if="state.effect === 'MaskVolume'">
          <div class="mb-1 text-[12px] text-muted-foreground">
            Use {{ current?.name ?? 'the selected segment' }} as a mask to blank out regions in a volume. The mask is applied to the source volume by default.
          </div>
          <SwFormRow label="Operation">
            <div class="flex flex-col text-[12px]">
              <SwCheckBox v-for="o in maskVolumeOperations" :key="o.value" radio :text="o.label" :checked="parameter('MaskVolume', 'Operation') === o.value"
                @toggled="$event && setParameter('MaskVolume', 'Operation', o.value)" />
            </div>
          </SwFormRow>
          <template v-if="parameter('MaskVolume', 'Operation') === 'FILL_INSIDE_AND_OUTSIDE'">
            <SwFormRow label="Outside fill value">
              <SwSpinBox :value="Number(parameter('MaskVolume', 'BinaryMaskFillValueOutside'))" :decimals="2"
                @value-changed="setParameter('MaskVolume', 'BinaryMaskFillValueOutside', $event)" />
            </SwFormRow>
            <SwFormRow label="Inside fill value">
              <SwSpinBox :value="Number(parameter('MaskVolume', 'BinaryMaskFillValueInside'))" :decimals="2"
                @value-changed="setParameter('MaskVolume', 'BinaryMaskFillValueInside', $event)" />
            </SwFormRow>
          </template>
          <SwFormRow v-else label="Fill value">
            <SwSpinBox :value="Number(parameter('MaskVolume', 'FillValue'))" :decimals="2" @value-changed="setParameter('MaskVolume', 'FillValue', $event)" />
          </SwFormRow>
          <SwFormRow label="Soft edge">
            <SwSpinBox :value="Number(parameter('MaskVolume', 'SoftEdgeMm'))" :minimum="0" :single-step="0.5" :decimals="1" suffix="mm"
              @value-changed="setParameter('MaskVolume', 'SoftEdgeMm', $event)" />
          </SwFormRow>
          <SwFormRow label="Input volume">
            <div class="flex items-center gap-1">
              <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight" title="Show the input volume in the slice views" data-name="showInput"
                @click="run('segmentEditorShowVolume', [state.maskVolume.inputVolumeNodeID])">
                <Eye v-if="state.maskVolume.inputVisible" :size="14" /><EyeOff v-else :size="14" class="opacity-60" />
              </button>
              <SwNodeSelector class="flex-1" node-types="vtkMRMLScalarVolumeNode" none-enabled none-display="(Source volume)" :current-node-id="state.maskVolume.inputVolumeNodeID"
                @current-node-changed="run('segmentEditorSetEffectNodeReference', ['MaskVolume', 'InputVolume', $event])" />
            </div>
          </SwFormRow>
          <SwFormRow label="Output volume">
            <div class="flex items-center gap-1">
              <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight disabled:opacity-30" title="Show the output volume in the slice views"
                data-name="showOutput" :disabled="!state.maskVolume.outputVolumeNodeID" @click="run('segmentEditorShowVolume', [state.maskVolume.outputVolumeNodeID])">
                <Eye v-if="state.maskVolume.outputVisible" :size="14" /><EyeOff v-else :size="14" class="opacity-60" />
              </button>
              <SwNodeSelector class="flex-1" add-enabled rename-enabled remove-enabled none-enabled
                :node-types="parameter('MaskVolume', 'Operation') === 'FILL_INSIDE_AND_OUTSIDE' ? ['vtkMRMLLabelMapVolumeNode', 'vtkMRMLScalarVolumeNode'] : ['vtkMRMLScalarVolumeNode', 'vtkMRMLLabelMapVolumeNode']"
                :none-display="parameter('MaskVolume', 'Operation') === 'FILL_INSIDE_AND_OUTSIDE' ? '(Create new Labelmap Volume)' : '(Create new Volume)'"
                :current-node-id="state.maskVolume.outputVolumeNodeID"
                @current-node-changed="run('segmentEditorSetEffectNodeReference', ['MaskVolume', 'OutputVolume', $event])" />
            </div>
          </SwFormRow>
          <SwButton text="Apply" primary class="mt-1 w-full" tool-tip="Apply segment as volume mask. No undo operation available once applied."
            @clicked="run('segmentEditorApply', ['MaskVolume'])" />
        </template>
        <template v-else-if="state.effect === 'Margin'">
          <SwFormRow label="Operation">
            <div class="flex flex-col items-start text-[12px]">
              <SwCheckBox radio text="Shrink" :checked="Number(parameter('Margin', 'MarginSizeMm')) < 0"
                @toggled="$event && setParameter('Margin', 'MarginSizeMm', -Math.abs(Number(parameter('Margin', 'MarginSizeMm'))))" />
              <SwCheckBox radio text="Grow" :checked="Number(parameter('Margin', 'MarginSizeMm')) > 0"
                @toggled="$event && setParameter('Margin', 'MarginSizeMm', Math.abs(Number(parameter('Margin', 'MarginSizeMm'))))" />
            </div>
          </SwFormRow>
          <SwFormRow label="Margin size">
            <SwSpinBox :value="Math.abs(Number(parameter('Margin', 'MarginSizeMm')))" :minimum="0" :single-step="1" :decimals="1" suffix="mm"
              title="Segment boundaries will be shifted by this distance. Positive value means the segments will grow, negative value means segment will shrink."
              @value-changed="setParameter('Margin', 'MarginSizeMm', (Number(parameter('Margin', 'MarginSizeMm')) < 0 ? -1 : 1) * $event)" />
          </SwFormRow>
          <div v-if="state.margin" class="text-[12px] text-muted-foreground"
            title="Size change in pixel. Computed from the segment's spacing and the specified margin size.">{{ state.margin.actual }}</div>
          <SwCheckBox text="Apply to visible segments" :checked="!!parameter('Margin', 'ApplyToAllVisibleSegments')"
            tool-tip="Grow or shrink all visible segments in this segmentation node. This operation may take a while."
            @toggled="setParameter('Margin', 'ApplyToAllVisibleSegments', $event)" />
          <SwButton text="Apply" primary class="mt-1 w-full" :enabled="!!state.margin?.feasible"
            tool-tip="Grows or shrinks selected segment (default) or all segments (checkbox) by the specified margin."
            @clicked="run('segmentEditorApply', ['Margin'])" />
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
          <SwButton text="Apply" primary class="mt-1 w-full"
            @clicked="run('segmentEditorApply', ['Hollow', { thicknessMm: hollowThicknessMm, shellMode }])" />
        </template>
        <template v-else-if="state.effect === 'Logic'">
          <SwFormRow label="Operation">
            <SwComboBox :current-index="logicalOperations.findIndex((o) => o.value === logicalOperation)"
              :items="logicalOperations.map((o) => o.label)"
              @current-index-changed="logicalOperation = logicalOperations[$event].value" />
          </SwFormRow>
          <SwFormRow v-if="operationNeedsOther" :label="modifierSegmentLabel">
            <SwComboBox :current-index="Math.max(0, otherSegments.findIndex((s) => s.id === otherSegmentID))"
              :items="otherSegments.map((s) => s.name)"
              @current-index-changed="otherSegmentID = otherSegments[$event]?.id ?? null" />
          </SwFormRow>
          <div v-if="operationNeedsOther && !otherSegments.length" class="text-[12px] text-muted-foreground">
            Add another segment to {{ logicalOperation }} with.
          </div>
          <SwCheckBox text="Bypass masking" :checked="!!parameter('Logic', 'BypassMasking')"
            tool-tip="Ignore all masking options and only modify the selected segment."
            @toggled="setParameter('Logic', 'BypassMasking', $event)" />
          <SwButton text="Apply" primary class="mt-1 w-full" :enabled="!operationNeedsOther || !!otherSegmentID"
            @clicked="run('segmentEditorApply', ['Logic', { operation: logicalOperation, modifierSegmentID: otherSegmentID }])" />
        </template>
        <template v-else-if="state.effect === 'Islands'">
          <div class="grid grid-cols-2 gap-x-3 text-[12px]">
            <div class="flex flex-col items-start gap-0.5">
              <SwCheckBox v-for="o in islandOperations.slice(0, 3)" :key="o.value" radio :text="o.label" :tool-tip="o.toolTip"
                :checked="parameter('Islands', 'Operation') === o.value" @toggled="$event && setParameter('Islands', 'Operation', o.value)" />
            </div>
            <div class="flex flex-col items-start gap-0.5">
              <SwCheckBox v-for="o in islandOperations.slice(3)" :key="o.value" radio :text="o.label" :tool-tip="o.toolTip"
                :checked="parameter('Islands', 'Operation') === o.value" @toggled="$event && setParameter('Islands', 'Operation', o.value)" />
            </div>
          </div>
          <SwFormRow label="Minimum size" class="mt-1">
            <SwSpinBox :value="Number(parameter('Islands', 'MinimumSize') ?? 1000)" :minimum="0" :maximum="2147483647" suffix="voxels"
              :enabled="!islandSelectionRequired" @value-changed="setParameter('Islands', 'MinimumSize', Math.round($event))" />
          </SwFormRow>
          <div v-if="islandSelectionRequired" class="mt-1 text-[12px] text-muted-foreground">Click in a slice view to select an island.</div>
          <SwButton v-else text="Apply" primary class="mt-1 w-full" @clicked="run('segmentEditorApply', ['Islands'])" />
        </template>
        <template v-else-if="state.effect === 'Smoothing'">
          <SwFormRow label="Smoothing method">
            <SwComboBox :items="smoothingMethods.map((m) => m.label)"
              :current-index="Math.max(0, smoothingMethods.findIndex((m) => m.value === parameter('Smoothing', 'SmoothingMethod')))"
              @current-index-changed="setParameter('Smoothing', 'SmoothingMethod', smoothingMethods[$event].value)" />
          </SwFormRow>
          <SwFormRow v-if="['MEDIAN', 'MORPHOLOGICAL_OPENING', 'MORPHOLOGICAL_CLOSING'].includes(parameter('Smoothing', 'SmoothingMethod'))" label="Kernel size">
            <div class="flex items-center gap-2">
              <SwSpinBox :value="Number(parameter('Smoothing', 'KernelSizeMm'))" :minimum="0" :single-step="1" :decimals="1" suffix="mm"
                @value-changed="setParameter('Smoothing', 'KernelSizeMm', $event)" />
              <span v-if="state.smoothing" class="whitespace-nowrap text-[12px] text-muted-foreground"
                title="Diameter of the neighborhood in pixel. Computed from the segment's spacing and the specified kernel size.">
                {{ state.smoothing.kernelSizePixel.join("x") }} pixel</span>
            </div>
          </SwFormRow>
          <SwFormRow v-if="parameter('Smoothing', 'SmoothingMethod') === 'GAUSSIAN'" label="Standard deviation">
            <SwSpinBox :value="Number(parameter('Smoothing', 'GaussianStandardDeviationMm'))" :minimum="0" :single-step="1" :decimals="1" suffix="mm"
              @value-changed="setParameter('Smoothing', 'GaussianStandardDeviationMm', $event)" />
          </SwFormRow>
          <SwFormRow v-if="parameter('Smoothing', 'SmoothingMethod') === 'JOINT_TAUBIN'" label="Smoothing factor">
            <SwSlider :value="Number(parameter('Smoothing', 'JointTaubinSmoothingFactor'))" :minimum="0.01" :maximum="1" :single-step="0.01" :decimals="2"
              :tracking="false" @value-changed="setParameter('Smoothing', 'JointTaubinSmoothingFactor', $event)" />
          </SwFormRow>
          <SwCheckBox v-if="parameter('Smoothing', 'SmoothingMethod') !== 'JOINT_TAUBIN'" text="Apply to visible segments"
            :checked="!!parameter('Smoothing', 'ApplyToAllVisibleSegments')"
            tool-tip="Apply smoothing effect to all visible segments in this segmentation node. This operation may take a while."
            @toggled="setParameter('Smoothing', 'ApplyToAllVisibleSegments', $event)" />
          <div v-else class="text-[12px] text-muted-foreground">Smooths all visible segments at once, keeping the interfaces between them watertight. Masking settings are bypassed.</div>
          <SwButton text="Apply" primary class="mt-1 w-full" tool-tip="Apply smoothing to selected segment" @clicked="run('segmentEditorApply', ['Smoothing'])" />
          <details class="mt-2 text-[12px]">
            <summary class="cursor-pointer text-muted-foreground">Smoothing brush options</summary>
            <div class="mt-1 flex flex-col gap-1">
              <div class="text-muted-foreground">Paint in a slice view to smooth only there.</div>
              <SwFormRow label="Brush radius">
                <SwSlider :value="state.brushRadius" :minimum="0.5" :maximum="50" :single-step="0.5" :decimals="1" suffix="mm"
                  @value-changed="run('segmentEditorSetBrush', [$event])" />
              </SwFormRow>
              <SwCheckBox text="Sphere brush" :checked="state.sphereBrush" @toggled="run('segmentEditorSetBrush', [null, $event])" />
              <SwCheckBox text="Edit in 3D views" :checked="!!parameter('Smoothing', 'EditIn3DViews')"
                tool-tip="Allow painting in 3D views. If enabled, click-and-drag in a 3D view paints in the view instead of rotating the view."
                @toggled="setParameter('Smoothing', 'EditIn3DViews', $event)" />
            </div>
          </details>
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

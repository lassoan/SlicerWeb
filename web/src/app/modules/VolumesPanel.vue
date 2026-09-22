<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { SwCheckBox, SwCollapsible, SwComboBox, SwFormRow, SwNodeSelector, SwRangeSlider, SwSlider } from "@/widgets";
import { store } from "../store";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface VolumeInfo {
  id: string;
  name: string;
  isLabelmap: boolean;
  spacing: number[];
  origin: number[];
  dimensions: number[];
  scalarType: string;
  numberOfComponents: number;
  scalarRange: number[];
  window?: number;
  level?: number;
  autoWindowLevel?: boolean;
  applyThreshold?: boolean;
  lowerThreshold?: number;
  upperThreshold?: number;
  interpolate?: boolean;
  colorNodeID?: string;
}

const nodeID = useSelectedNode("Volume");
const { state, bridge } = useNodeState<VolumeInfo>("volumeInfo", nodeID);
const presets = ref<{ id: string; name: string }[]>([]);
const colors = ref<{ id: string; name: string }[]>([]);

onMounted(async () => {
  presets.value = await bridge.call<{ id: string; name: string }[]>("volumeDisplayPresets").catch(() => []);
  colors.value = await bridge.call<{ id: string; name: string }[]>("colorTables").catch(() => []);
});

function set(props: Record<string, unknown>) {
  if (nodeID.value) bridge.call("setVolumeDisplay", [nodeID.value, props]);
}

/**
 * How the window and level are chosen, as in desktop Slicer (qMRMLWindowLevelWidget::ControlMode):
 * by the application, by window and level, or by the two ends of the displayed range.
 *
 * The scene knows only whether the choosing is automatic, so which of the two manual ways is shown
 * is remembered here.
 */
const MODES = ["Auto", "Manual", "Manual Min/Max"];
const manualMode = ref(1);
const mode = computed(() => (state.value?.autoWindowLevel ? 0 : manualMode.value));

function setMode(index: number) {
  if (index > 0) manualMode.value = index;
  set(index === 0 ? { autoWindowLevel: true } : { window: state.value?.window, level: state.value?.level });
}

/**
 * What the sliders span: the values the volume holds, a whole range further either way, and
 * whatever is set now - a display range wider than the data is worth keeping reachable.
 */
const bounds = computed<[number, number]>(() => {
  const info = state.value;
  if (!info) return [0, 1];
  const [low, high] = info.scalarRange;
  const width = high - low || 1;
  const window = info.window ?? width;
  const level = info.level ?? (low + high) / 2;
  return [Math.min(low - width, level - window / 2), Math.max(high + width, level + window / 2)];
});

const displayedMin = computed(() => (state.value!.level ?? 0) - (state.value!.window ?? 0) / 2);
const displayedMax = computed(() => (state.value!.level ?? 0) + (state.value!.window ?? 0) / 2);

/** Set the displayed range by its ends; the scene keeps it as a window and a level. */
function setMinMax(min: number, max: number) {
  const window = Math.max(max - min, 0.001);
  set({ window, level: min + window / 2 });
}
const fmt = (v: number[] | undefined, d = 2) => (v ?? []).map((x) => x.toFixed(d)).join(" × ");
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Active volume">
      <SwNodeSelector node-types="vtkMRMLVolumeNode" :current-node-id="nodeID" rename-enabled remove-enabled
        @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <SwCollapsible text="Volume information" collapsed>
        <SwFormRow label="Dimensions">{{ state.dimensions.join(" × ") }}</SwFormRow>
        <SwFormRow label="Spacing">{{ fmt(state.spacing, 3) }} mm</SwFormRow>
        <SwFormRow label="Origin">{{ fmt(state.origin, 2) }}</SwFormRow>
        <SwFormRow label="Scalar type">{{ state.scalarType }} ({{ state.numberOfComponents }})</SwFormRow>
        <SwFormRow label="Scalar range">{{ fmt(state.scalarRange, 1) }}</SwFormRow>
      </SwCollapsible>
      <SwCollapsible v-if="!state.isLabelmap && state.window !== undefined" text="Display">
        <SwFormRow label="Preset">
          <SwComboBox :items="['Select…', ...presets.map((p) => p.name)]" :current-index="0"
            @current-index-changed="$event > 0 && bridge.call('applyVolumeDisplayPreset', [nodeID, presets[$event - 1].id])" />
        </SwFormRow>
        <SwFormRow label="Lookup table">
          <SwComboBox :items="colors.map((c) => c.name)" :current-index="Math.max(0, colors.findIndex((c) => c.id === state!.colorNodeID))"
            @current-index-changed="set({ colorNodeID: colors[$event].id })" />
        </SwFormRow>
        <SwFormRow label="Window/level">
          <SwComboBox :items="MODES" :current-index="mode" @current-index-changed="setMode($event)" />
        </SwFormRow>
        <template v-if="mode === 2">
          <SwFormRow label="Min">
            <SwSlider :value="displayedMin" :minimum="bounds[0]" :maximum="bounds[1]" :decimals="0"
              @value-changed="setMinMax($event, displayedMax)" />
          </SwFormRow>
          <SwFormRow label="Max">
            <SwSlider :value="displayedMax" :minimum="bounds[0]" :maximum="bounds[1]" :decimals="0"
              @value-changed="setMinMax(displayedMin, $event)" />
          </SwFormRow>
        </template>
        <template v-else>
          <SwFormRow label="Window">
            <SwSlider :value="state.window" :minimum="0" :maximum="bounds[1] - bounds[0]" :decimals="0"
              :enabled="mode === 1" @value-changed="set({ window: $event })" />
          </SwFormRow>
          <SwFormRow label="Level">
            <SwSlider :value="state.level" :minimum="bounds[0]" :maximum="bounds[1]" :decimals="0"
              :enabled="mode === 1" @value-changed="set({ level: $event })" />
          </SwFormRow>
        </template>
        <SwCheckBox text="Threshold" :checked="state.applyThreshold" @toggled="set({ applyThreshold: $event })" />
        <SwRangeSlider v-if="state.applyThreshold" :minimum="state.scalarRange[0]" :maximum="state.scalarRange[1]"
          :minimum-value="state.lowerThreshold" :maximum-value="state.upperThreshold"
          @values-changed="(lo: number, hi: number) => set({ lowerThreshold: lo, upperThreshold: hi })" />
        <SwCheckBox text="Interpolate" :checked="state.interpolate" @toggled="set({ interpolate: $event })" />
      </SwCollapsible>
    </template>
    <div v-else class="py-6 text-center text-[12px] text-muted-foreground">Load a volume to adjust its display.</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
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
        <SwCheckBox text="Auto window/level" :checked="state.autoWindowLevel" @toggled="set({ autoWindowLevel: $event })" />
        <SwFormRow label="Window">
          <SwSlider :value="state.window" :minimum="0" :maximum="(state.scalarRange[1] - state.scalarRange[0]) * 2 || 1" :decimals="0"
            @value-changed="set({ window: $event })" />
        </SwFormRow>
        <SwFormRow label="Level">
          <SwSlider :value="state.level" :minimum="state.scalarRange[0]" :maximum="state.scalarRange[1]" :decimals="0"
            @value-changed="set({ level: $event })" />
        </SwFormRow>
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

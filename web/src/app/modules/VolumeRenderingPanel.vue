<script setup lang="ts">
import { ref } from "vue";
import { SwCheckBox, SwComboBox, SwFormRow, SwNodeSelector, SwSlider } from "@/widgets";
import { store } from "../store";
import { useNodeState } from "./useNodeState";

interface VRInfo {
  visible: boolean;
  presets: string[];
  preset: string | null;
  shift: number;
  shiftRange: number[];
  croppingEnabled?: boolean;
}

const nodeID = ref<string | null>((store as any).selectedNodeID ?? null);
const { state, bridge, refresh } = useNodeState<VRInfo>("volumeRenderingInfo", nodeID);

async function set(props: Record<string, unknown>) {
  if (!nodeID.value) return;
  await bridge.call("setVolumeRendering", [nodeID.value, props]);
  refresh();
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Volume">
      <SwNodeSelector node-types="vtkMRMLScalarVolumeNode" :current-node-id="nodeID" @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <SwCheckBox text="Show volume rendering" :checked="state.visible" @toggled="set({ visible: $event })" />
      <SwFormRow label="Preset">
        <SwComboBox :items="state.presets" :current-index="Math.max(0, state.presets.indexOf(state.preset ?? ''))"
          @current-text-changed="set({ preset: $event, visible: true })" />
      </SwFormRow>
      <SwFormRow label="Shift">
        <SwSlider :value="state.shift" :minimum="state.shiftRange[0]" :maximum="state.shiftRange[1]" :decimals="0" @value-changed="set({ shift: $event })" />
      </SwFormRow>
      <SwCheckBox text="Crop (ROI)" :checked="state.croppingEnabled" @toggled="set({ croppingEnabled: $event })" />
    </template>
    <div v-else class="py-6 text-center text-[12px] text-muted-foreground">Load a volume to render it in 3D.</div>
  </div>
</template>

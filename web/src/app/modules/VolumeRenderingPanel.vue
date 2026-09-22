<script setup lang="ts">
import { ref } from "vue";
import { SwCheckBox, SwComboBox, SwFormRow, SwNodeSelector, SwSlider } from "@/widgets";
import { store } from "../store";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface VRInfo {
  visible: boolean;
  presets: string[];
  preset: string | null;
  shift: number;
  shiftRange: number[];
  croppingEnabled?: boolean;
  quality: number;
  expectedFPS: number;
}

// vtkMRMLViewNode::VolumeRenderingQualityType
const qualities = ["Adaptive", "Normal", "Maximum"];

const nodeID = useSelectedNode("Volume");
const { state, error, bridge, refresh } = useNodeState<VRInfo>("volumeRenderingInfo", nodeID);

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
      <SwFormRow label="Quality">
        <SwComboBox :items="qualities" :current-index="state.quality"
          tool-tip="Adaptive gives up detail while the camera is moving, so that it keeps up; the others always render in full."
          @current-index-changed="set({ quality: $event })" />
      </SwFormRow>
      <SwFormRow v-if="state.quality === 0" label="Aim for">
        <SwSlider :value="state.expectedFPS" :minimum="1" :maximum="60" :decimals="0" suffix=" fps"
          @value-changed="set({ expectedFPS: $event })" />
      </SwFormRow>
      <SwCheckBox text="Crop (ROI)" :checked="state.croppingEnabled" @toggled="set({ croppingEnabled: $event })" />
    </template>
    <div v-else class="py-6 text-center text-[12px] text-muted-foreground">Load a volume to render it in 3D.</div>
    <p v-if="error" class="rounded bg-card/70 p-2 text-[12px] text-red-400" data-name="vrError">{{ error }}</p>
  </div>
</template>

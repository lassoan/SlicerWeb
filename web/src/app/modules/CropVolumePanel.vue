<script setup lang="ts">
// Crop Volume module: cut a volume down to a region of interest.
import { inject, onMounted, ref } from "vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwCheckBox, SwComboBox, SwFormRow, SwNodeSelector, SwSlider } from "@/widgets";

interface CropInfo {
  parameterNodeID: string;
  inputVolumeID: string | null;
  outputVolumeID: string | null;
  roiID: string | null;
  interpolationMode: number;
  voxelBased: boolean;
  isotropicResampling: boolean;
  spacingScale: number;
  fillValue: number;
  outputDimensions: number[];
  outputSpacing: number[];
  interpolatedCropAvailable: boolean;
}

const INTERPOLATION = ["Nearest neighbour", "Linear", "Windowed sinc", "B-spline"];
const bridge = inject<SlicerBridge>("bridge")!;
const state = ref<CropInfo | null>(null);
const error = ref("");
const busy = ref(false);

async function refresh() {
  state.value = await bridge.call<CropInfo>("cropVolumeInfo", [state.value?.parameterNodeID ?? null]);
}

async function set(properties: Record<string, unknown>) {
  if (!state.value) return;
  await bridge.call("setCropVolumeParameters", [state.value.parameterNodeID, properties]);
  await refresh();
}

async function apply() {
  if (!state.value) return;
  busy.value = true;
  error.value = "";
  try {
    await bridge.call("applyCropVolume", [state.value.parameterNodeID]);
    await refresh();
  } catch (e: any) {
    error.value = e.message ?? String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div v-if="state" class="flex flex-col gap-2">
    <SwFormRow label="Input volume">
      <SwNodeSelector node-types="vtkMRMLScalarVolumeNode" :current-node-id="state.inputVolumeID"
        @current-node-changed="set({ inputVolumeID: $event })" />
    </SwFormRow>
    <SwFormRow label="Region of interest">
      <SwNodeSelector node-types="vtkMRMLMarkupsROINode" :current-node-id="state.roiID" add-enabled base-name="Crop ROI"
        @current-node-changed="set({ roiID: $event })" />
    </SwFormRow>
    <SwFormRow label="Output volume">
      <SwNodeSelector node-types="vtkMRMLScalarVolumeNode" :current-node-id="state.outputVolumeID" none-enabled
        none-display="(create new)" @current-node-changed="set({ outputVolumeID: $event })" />
    </SwFormRow>
    <SwCheckBox text="Voxel based (no resampling)" :checked="state.voxelBased" @toggled="set({ voxelBased: $event })" />
    <div v-if="!state.voxelBased && !state.interpolatedCropAvailable" class="rounded bg-card/70 p-2 text-[12px] text-muted-foreground">
      Cropping with resampling needs the Resample Scalar/Vector/DWI Volume module, which is not built
      into this application. Crop voxel based instead.
    </div>
    <template v-if="!state.voxelBased">
      <SwFormRow label="Interpolation">
        <SwComboBox :items="INTERPOLATION" :current-index="Math.max(0, state.interpolationMode - 1)"
          @current-index-changed="set({ interpolationMode: $event + 1 })" />
      </SwFormRow>
      <SwCheckBox text="Isotropic spacing" :checked="state.isotropicResampling" @toggled="set({ isotropicResampling: $event })" />
      <SwFormRow label="Spacing scale">
        <SwSlider :value="state.spacingScale" :minimum="0.1" :maximum="5" :single-step="0.1" :decimals="2"
          @value-changed="set({ spacingScale: $event })" />
      </SwFormRow>
      <SwFormRow label="Fill value">
        <SwSlider :value="state.fillValue" :minimum="-1024" :maximum="1024" :single-step="1" :decimals="0"
          @value-changed="set({ fillValue: $event })" />
      </SwFormRow>
    </template>
    <div v-if="state.outputDimensions.some((d) => d > 0)" class="text-[12px] text-muted-foreground" data-name="cropOutput">
      Result: {{ state.outputDimensions.join(" × ") }} voxels
      <span v-if="state.outputSpacing.some((s) => s > 0)"> at {{ state.outputSpacing.join(" × ") }} mm</span>
    </div>
    <button type="button" class="rounded bg-primary px-3 py-1 text-[13px] text-primary-foreground hover:bg-primary/85 disabled:opacity-40"
      :disabled="busy || !state.inputVolumeID || !state.roiID" data-name="applyCrop" @click="apply">
      {{ busy ? "Cropping…" : "Apply" }}
    </button>
    <pre v-if="error" class="rounded bg-destructive/40 p-2 text-[12px] whitespace-pre-wrap">{{ error }}</pre>
  </div>
</template>

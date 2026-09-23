<script setup lang="ts">
// Web GUI of the Dose Volume Histogram module (SlicerRT extension): what the desktop
// qSlicerDoseVolumeHistogramModuleWidget offers, driven by the vtkMRMLDoseVolumeHistogramNode
// parameter node and the module logic (see slicerweb.panels_dvh). The DVHs are drawn in the
// plot view of a quantitative layout; the metrics table is shown here, with a box per DVH that
// puts it in the chart or takes it out.
import { computed, inject, ref } from "vue";
import { SwButton, SwCheckBox, SwCollapsible, SwFormRow, SwLineEdit, SwNodeSelector } from "@/widgets";
import type { SlicerRuntime } from "@/core/runtime";
import { store } from "../store";
import { useNodeState } from "./useNodeState";

interface Segment { id: string; name: string; color: string; selected: boolean }
interface DvhInfo {
  doseVolumeID: string | null;
  isDoseVolume: boolean;
  doseUnit: string;
  segmentationID: string | null;
  selectedSegmentIDs: string[];
  segments: Segment[];
  vDoseValues: string;
  showVMetricsCc: boolean;
  showVMetricsPercent: boolean;
  dVolumeValuesCc: string;
  dVolumeValuesPercent: string;
  showDMetrics: boolean;
  showDoseVolumesOnly: boolean;
  automaticOversampling: boolean;
  doseSurfaceHistogram: boolean;
  useInsideDoseSurface: boolean;
  useFractionalLabelmap: boolean;
  metrics: { columns: string[]; rows: { visible: boolean; cells: string[] }[] };
  legendVisible: boolean;
}

const runtime = inject<SlicerRuntime>("runtime")!;
const nodeID = ref<string | null>(null);
const { state, bridge, refresh } = useNodeState<DvhInfo>("doseVolumeHistogramInfo", nodeID);
const error = ref("");
const busy = ref("");

// The first parameter node, or a new one (the desktop module makes one on entering)
(async () => {
  const nodes = await bridge.call<{ id: string }[]>("getNodes", ["vtkMRMLDoseVolumeHistogramNode"]);
  if (nodes.length) nodeID.value = nodes[0].id;
  else nodeID.value = await bridge.evalPython(
    'slicer.mrmlScene.AddNewNodeByClass("vtkMRMLDoseVolumeHistogramNode", "DoseVolumeHistogram").GetID()', "eval",
  ).then((id) => (id ? String(id).replace(/^'|'$/g, "") : null));
})();

const computed_ = computed(() => (state.value?.metrics.rows.length ?? 0) > 0);
const canCompute = computed(() => !!state.value?.doseVolumeID && !!state.value?.segmentationID && !busy.value);
// Dose volumes are what the DICOM-RT importer marks as such; the box limits the selector to them
const doseVolumeAttributes = computed(() => (state.value?.showDoseVolumesOnly ? { "DicomRtImport.DoseVolume": null } : undefined));

async function set(props: Record<string, unknown>) {
  if (!nodeID.value) return;
  error.value = "";
  try {
    await bridge.call("setDoseVolumeHistogram", [nodeID.value, props]);
  } catch (e: any) {
    error.value = e.message ?? String(e);
  }
  refresh();
}

/** The segments to compute: the ones ticked; none ticked stands for all, as the logic takes it. */
function selectSegment(id: string, selected: boolean) {
  const segments = state.value?.segments ?? [];
  const chosen = segments.filter((s) => (s.id === id ? selected : s.selected)).map((s) => s.id);
  set({ selectedSegmentIDs: chosen.length === segments.length ? [] : chosen });
}

async function compute() {
  if (!nodeID.value) return;
  error.value = "";
  busy.value = "Computing DVH for the selected segments";
  try {
    await bridge.call("computeDoseVolumeHistogram", [nodeID.value]);
  } catch (e: any) {
    error.value = e.message ?? String(e);
  }
  busy.value = "";
  refresh();
}

async function setVisibility(visible: boolean, rows?: number[]) {
  if (!nodeID.value) return;
  await bridge.call("setDoseVolumeHistogramVisibility", [nodeID.value, visible, rows ?? null]);
  refresh();
}

async function exportTo(what: "dvh" | "metrics", comma: boolean) {
  if (!nodeID.value) return;
  error.value = "";
  try {
    const path = await bridge.call<string>("exportDoseVolumeHistogram", [nodeID.value, what, comma]);
    runtime.saveFileToDisk(path);
  } catch (e: any) {
    error.value = e.message ?? String(e);
  }
}

const setLayout = (name: string) => bridge.call("setLayout", [name]);
const hasLayout = (name: string) => name in store.availableLayouts;
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Parameter set">
      <SwNodeSelector node-types="vtkMRMLDoseVolumeHistogramNode" :current-node-id="nodeID" add-enabled rename-enabled remove-enabled
        base-name="DoseVolumeHistogram" @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <SwCollapsible text="Input">
        <SwFormRow label="Dose volume">
          <div class="flex items-center gap-2">
            <SwNodeSelector class="min-w-0 flex-1" node-types="vtkMRMLScalarVolumeNode" :current-node-id="state.doseVolumeID" none-enabled
              :node-attributes="doseVolumeAttributes" data-name="dvhDoseVolume" @current-node-changed="set({ doseVolumeID: $event })" />
            <SwCheckBox text="A/O" tool-tip="Automatic oversampling: an oversampling factor is worked out for each structure; otherwise 2 is used"
              :checked="state.automaticOversampling" @toggled="set({ automaticOversampling: $event })" />
          </div>
        </SwFormRow>
        <div v-if="state.doseVolumeID && !state.isDoseVolume" class="text-[12px] text-amber-300">Selected volume is not a dose</div>
        <SwFormRow label="Segmentation">
          <SwNodeSelector node-types="vtkMRMLSegmentationNode" :current-node-id="state.segmentationID" none-enabled data-name="dvhSegmentation"
            @current-node-changed="set({ segmentationID: $event })" />
        </SwFormRow>
        <div v-if="state.segments.length" class="rounded border border-input p-1">
          <div class="px-1 pb-1 text-[11px] text-muted-foreground">Select individual structures (none selected: all)</div>
          <label v-for="s in state.segments" :key="s.id" class="flex h-6 cursor-pointer items-center gap-2 rounded px-1 text-[13px] hover:bg-accent/40">
            <input type="checkbox" class="h-3.5 w-3.5 accent-highlight" :checked="s.selected" data-name="dvhSegment" @change="selectSegment(s.id, ($event.target as HTMLInputElement).checked)" />
            <span class="inline-block h-3 w-3 rounded-sm" :style="{ background: s.color }" />{{ s.name }}
          </label>
        </div>
        <SwCheckBox text="Show dose volumes only" :checked="state.showDoseVolumesOnly" @toggled="set({ showDoseVolumesOnly: $event })" />
        <SwCheckBox text="Dose surface histogram" tool-tip="Calculate dose surface histogram. Open contours are not currently supported."
          :checked="state.doseSurfaceHistogram" @toggled="set({ doseSurfaceHistogram: $event })" />
        <SwCheckBox v-if="state.doseSurfaceHistogram" text="Use inside surface of the structure" class="ml-5"
          :checked="state.useInsideDoseSurface" @toggled="set({ useInsideDoseSurface: $event })" />
        <div class="flex items-center gap-2">
          <SwButton text="Compute DVH" primary :enabled="canCompute" data-name="dvhCompute" @clicked="compute" />
          <span v-if="busy" class="text-[12px] text-muted-foreground">{{ busy }}…</span>
        </div>
        <div v-if="error" class="rounded bg-destructive/40 px-2 py-1 text-[12px] whitespace-pre-wrap" data-name="dvhError">{{ error }}</div>
      </SwCollapsible>

      <SwCollapsible text="Output">
        <div v-if="!computed_" class="py-2 text-center text-[12px] text-muted-foreground">No DVH computed yet.</div>
        <template v-else>
          <div class="max-h-64 overflow-auto rounded border border-input">
            <table class="w-full text-[12px]" data-name="dvhMetrics">
              <thead class="sticky top-0 bg-bkg-med">
                <tr>
                  <th class="px-1 py-1 text-left font-medium text-muted-foreground" title="Show in chart">Show</th>
                  <th v-for="c in state.metrics.columns" :key="c" class="whitespace-nowrap px-2 py-1 text-left font-medium text-muted-foreground">{{ c }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, r) in state.metrics.rows" :key="r" class="hover:bg-accent/30">
                  <td class="px-1"><input type="checkbox" class="h-3.5 w-3.5 accent-highlight" :checked="row.visible" @change="setVisibility(($event.target as HTMLInputElement).checked, [r])" /></td>
                  <td v-for="(cell, c) in row.cells" :key="c" class="whitespace-nowrap px-2 py-0.5">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="flex flex-wrap items-center gap-1">
            <SwButton text="Show all" @clicked="setVisibility(true)" />
            <SwButton text="Hide all" @clicked="setVisibility(false)" />
            <SwButton :text="state.legendVisible ? 'Hide legend' : 'Show legend'" @clicked="set({ legendVisible: !state!.legendVisible })" />
          </div>
          <SwFormRow label="Switch layout">
            <div class="flex flex-wrap gap-1">
              <SwButton v-if="hasLayout('FourUpPlot')" text="Four-up quantitative" @clicked="setLayout('FourUpPlot')" />
              <SwButton v-if="hasLayout('OneUpPlot')" text="One-up quantitative" @clicked="setLayout('OneUpPlot')" />
            </div>
          </SwFormRow>
        </template>
      </SwCollapsible>

      <SwCollapsible text="Advanced options" collapsed>
        <SwFormRow label="V metric for dose values">
          <div class="flex items-center gap-2">
            <SwLineEdit class="flex-1" :text="state.vDoseValues" placeholder-text="5,20" :enabled="computed_" data-name="dvhVDose"
              title="Enter dose values you want to compute V metrics for here, separated with commas"
              @editing-finished="set({ vDoseValues: $event })" />
            <span class="text-[12px] text-muted-foreground">{{ state.doseUnit }}</span>
            <SwCheckBox text="cc" :checked="state.showVMetricsCc" :enabled="computed_" data-name="dvhVCc" @toggled="set({ showVMetricsCc: $event })" />
            <SwCheckBox text="%" :checked="state.showVMetricsPercent" :enabled="computed_" @toggled="set({ showVMetricsPercent: $event })" />
          </div>
        </SwFormRow>
        <SwFormRow label="D metric for volumes">
          <div class="flex items-center gap-2">
            <SwLineEdit class="flex-1" :text="state.dVolumeValuesCc" placeholder-text="2,5" :enabled="computed_"
              title="Enter volume sizes in cc you want to compute D metrics for here, separated with commas"
              @editing-finished="set({ dVolumeValuesCc: $event })" />
            <span class="text-[12px] text-muted-foreground">cc</span>
            <SwLineEdit class="flex-1" :text="state.dVolumeValuesPercent" placeholder-text="5,10" :enabled="computed_"
              title="Enter volume percentages you want to compute D metrics for here, separated with commas"
              @editing-finished="set({ dVolumeValuesPercent: $event })" />
            <span class="text-[12px] text-muted-foreground">%</span>
            <SwCheckBox :text="state.doseUnit" tool-tip="Show D metrics" :checked="state.showDMetrics" :enabled="computed_" @toggled="set({ showDMetrics: $event })" />
          </div>
        </SwFormRow>
        <SwCheckBox text="Use fractional labelmap" :checked="state.useFractionalLabelmap" @toggled="set({ useFractionalLabelmap: $event })" />
        <div class="flex flex-wrap gap-1">
          <SwButton text="Export DVH to file (CSV)" :enabled="computed_" @clicked="exportTo('dvh', true)" />
          <SwButton text="Export DVH metrics to file (CSV)" :enabled="computed_" @clicked="exportTo('metrics', true)" />
        </div>
      </SwCollapsible>
    </template>
  </div>
</template>

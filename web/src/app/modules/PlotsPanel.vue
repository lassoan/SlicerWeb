<script setup lang="ts">
// Plots module: a chart, the series drawn in it, and where each series takes its values from.
import { inject, ref, watch } from "vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwCheckBox, SwFormRow, SwNodeSelector } from "@/widgets";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface SeriesInfo {
  id: string;
  name: string;
  tableNodeID: string | null;
  xColumn: string;
  yColumn: string;
  type: number;
  color: string;
}
interface ChartInfo {
  name: string;
  title: string;
  xAxisTitle: string;
  yAxisTitle: string;
  grid: boolean;
  legend: boolean;
  series: SeriesInfo[];
}

const PLOT_TYPES = ["Line", "Bar", "Scatter", "Scatter bar"];
const bridge = inject<SlicerBridge>("bridge")!;
const nodeID = useSelectedNode("PlotChart");
const { state } = useNodeState<ChartInfo>("plotChartInfo", nodeID);
const columns = ref<Record<string, string[]>>({});

// Column names of the tables the series use, to choose the x and y of each
watch(state, async (chart) => {
  for (const s of chart?.series ?? []) {
    if (!s.tableNodeID || columns.value[s.tableNodeID]) continue;
    const table = await bridge.call<{ columns: string[] }>("tableNodeInfo", [s.tableNodeID]);
    columns.value = { ...columns.value, [s.tableNodeID]: table.columns };
  }
});

const setChart = (properties: Record<string, unknown>) =>
  nodeID.value && bridge.call("setPlotChartProperties", [nodeID.value, properties]);
const setSeries = (series: SeriesInfo, properties: Record<string, unknown>) =>
  bridge.call("setPlotSeriesProperties", [series.id, properties]);
const addSeries = () =>
  nodeID.value && bridge.call("addPlotSeries", [nodeID.value, state.value?.series[0]?.tableNodeID ?? null, null]);
const removeSeries = (series: SeriesInfo) =>
  nodeID.value && bridge.call("removePlotSeries", [nodeID.value, series.id]);
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Chart">
      <SwNodeSelector node-types="vtkMRMLPlotChartNode" :current-node-id="nodeID" add-enabled rename-enabled remove-enabled
        base-name="Chart" @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <SwFormRow label="Title">
        <input :value="state.title" class="h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus:border-primary"
          @change="setChart({ title: ($event.target as HTMLInputElement).value })" />
      </SwFormRow>
      <SwFormRow label="X axis">
        <input :value="state.xAxisTitle" class="h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus:border-primary"
          @change="setChart({ xAxisTitle: ($event.target as HTMLInputElement).value })" />
      </SwFormRow>
      <SwFormRow label="Y axis">
        <input :value="state.yAxisTitle" class="h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus:border-primary"
          @change="setChart({ yAxisTitle: ($event.target as HTMLInputElement).value })" />
      </SwFormRow>
      <div class="flex gap-3">
        <SwCheckBox text="Grid" :checked="state.grid" @toggled="setChart({ grid: $event })" />
        <SwCheckBox text="Legend" :checked="state.legend" @toggled="setChart({ legend: $event })" />
      </div>

      <div class="flex items-center gap-2">
        <span class="text-[12px] font-semibold">Series</span>
        <button type="button" class="rounded bg-secondary/60 px-2 py-0.5 text-[12px] hover:bg-secondary" @click="addSeries">Add</button>
      </div>
      <div v-for="s in state.series" :key="s.id" class="rounded-md bg-card/70 p-2" :data-name="'series:' + s.name">
        <div class="mb-1 flex items-center gap-2">
          <input type="color" :value="s.color" class="h-5 w-8 shrink-0 cursor-pointer rounded border border-input bg-transparent"
            @change="setSeries(s, { color: ($event.target as HTMLInputElement).value })" />
          <input :value="s.name" class="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1 text-[12px] outline-none focus:border-primary"
            @change="setSeries(s, { name: ($event.target as HTMLInputElement).value })" />
          <button type="button" class="shrink-0 text-[12px] text-muted-foreground hover:text-destructive-foreground"
            @click="removeSeries(s)">Remove</button>
        </div>
        <div class="grid grid-cols-3 gap-1">
          <select class="h-6 rounded border border-input bg-background px-1 text-[12px]" :value="s.type"
            @change="setSeries(s, { type: Number(($event.target as HTMLSelectElement).value) })">
            <option v-for="(t, i) in PLOT_TYPES" :key="t" :value="i">{{ t }}</option>
          </select>
          <select class="h-6 rounded border border-input bg-background px-1 text-[12px]" :value="s.xColumn"
            @change="setSeries(s, { xColumn: ($event.target as HTMLSelectElement).value })">
            <option value="">(index)</option>
            <option v-for="c in columns[s.tableNodeID ?? ''] ?? []" :key="c" :value="c">{{ c }}</option>
          </select>
          <select class="h-6 rounded border border-input bg-background px-1 text-[12px]" :value="s.yColumn"
            @change="setSeries(s, { yColumn: ($event.target as HTMLSelectElement).value })">
            <option v-for="c in columns[s.tableNodeID ?? ''] ?? []" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
      </div>
      <div v-if="!state.series.length" class="text-[12px] text-muted-foreground">No series yet. Add one to plot a table column.</div>
      <div class="text-[11px] text-muted-foreground">Switch to a plot layout to see the chart in a view.</div>
    </template>
  </div>
</template>

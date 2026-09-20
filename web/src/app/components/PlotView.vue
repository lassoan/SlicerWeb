<script setup lang="ts">
// Plot view of the layout (qMRMLPlotView): the chart chosen in the view is drawn from its plot
// series - the same MRML nodes as in desktop Slicer, where VTK charts draw them.
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SlicerBridge } from "@/core/bridge";

const props = defineProps<{ layoutName: string }>();
const bridge = inject<SlicerBridge>("bridge")!;

interface Series {
  nodeID: string;
  name: string;
  type: number; // 0 line, 1 bar, 2 scatter, 3 scatter bar
  color: string;
  lineWidth: number;
  markerSize: number;
  points: [number, number][];
}
interface PlotState {
  chartNodeID: string | null;
  title: string;
  xAxisTitle: string;
  yAxisTitle: string;
  grid: boolean;
  legend: boolean;
  series: Series[];
}

const MARGIN = { left: 54, right: 12, top: 26, bottom: 34 };
const state = ref<PlotState | null>(null);
const charts = ref<{ id: string; name: string }[]>([]);
const size = ref({ width: 320, height: 240 });
const plot = ref<HTMLElement>();

async function refresh() {
  state.value = await bridge.call<PlotState>("plotViewState", [props.layoutName]);
  charts.value = await bridge.call<{ id: string; name: string }[]>("getNodes", ["vtkMRMLPlotChartNode", false]);
}

async function showChart(nodeID: string) {
  await bridge.call("setPlotViewChart", [props.layoutName, nodeID || null]);
  await refresh();
}

/** Value range of all series, padded a little so that points are not drawn on the frame. */
const range = computed(() => {
  const points = (state.value?.series ?? []).flatMap((s) => s.points);
  if (!points.length) return { x0: 0, x1: 1, y0: 0, y1: 1 };
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const pad = (lo: number, hi: number) => {
    const margin = (hi - lo) * 0.05 || Math.abs(hi) * 0.05 || 1;
    return [lo - margin, hi + margin] as const;
  };
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
  const [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  return { x0, x1, y0, y1 };
});

const plotArea = computed(() => ({
  left: MARGIN.left,
  top: MARGIN.top,
  width: Math.max(10, size.value.width - MARGIN.left - MARGIN.right),
  height: Math.max(10, size.value.height - MARGIN.top - MARGIN.bottom),
}));

function toX(value: number) {
  const { x0, x1 } = range.value;
  return plotArea.value.left + ((value - x0) / (x1 - x0 || 1)) * plotArea.value.width;
}
function toY(value: number) {
  const { y0, y1 } = range.value;
  return plotArea.value.top + plotArea.value.height - ((value - y0) / (y1 - y0 || 1)) * plotArea.value.height;
}

/** Round tick values, as an axis of a chart has. */
function ticks(lo: number, hi: number, count = 5) {
  const span = hi - lo || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= count) ?? step * 10;
  const first = Math.ceil(lo / nice) * nice;
  const values: number[] = [];
  for (let v = first; v <= hi + nice * 1e-6; v += nice) values.push(Number(v.toFixed(10)));
  return values;
}
const xTicks = computed(() => ticks(range.value.x0, range.value.x1));
const yTicks = computed(() => ticks(range.value.y0, range.value.y1));
const tickLabel = (v: number) => (Math.abs(v) >= 10000 || (v !== 0 && Math.abs(v) < 0.01) ? v.toExponential(1) : String(Number(v.toFixed(4))));

function linePath(series: Series) {
  return series.points.map((p, i) => `${i ? "L" : "M"}${toX(p[0]).toFixed(1)},${toY(p[1]).toFixed(1)}`).join(" ");
}
function barWidth(series: Series) {
  return Math.max(1, (plotArea.value.width / Math.max(series.points.length, 1)) * 0.7);
}

let observer: ResizeObserver | undefined;
let off: (() => void) | undefined;
onMounted(() => {
  refresh();
  off = bridge.events.on("scene-changed", refresh);
  observer = new ResizeObserver(([entry]) => {
    size.value = { width: entry.contentRect.width, height: entry.contentRect.height };
  });
  if (plot.value) observer.observe(plot.value);
});
onBeforeUnmount(() => {
  off?.();
  observer?.disconnect();
});
watch(() => props.layoutName, refresh);
</script>

<template>
  <div class="flex h-full flex-col bg-background" data-name="plotView">
    <div class="flex h-[26px] shrink-0 items-center gap-1.5 border-b border-input/40 bg-card px-1.5 text-[12px]">
      <span class="shrink-0 text-muted-foreground">Chart</span>
      <select class="h-5 min-w-0 flex-1 rounded bg-input/60 px-1 text-[11px] text-foreground outline-none"
        :value="state?.chartNodeID ?? ''" @change="showChart(($event.target as HTMLSelectElement).value)">
        <option value="">None</option>
        <option v-for="c in charts" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
    </div>

    <div ref="plot" class="min-h-0 flex-1">
      <svg v-if="state?.series.length" :width="size.width" :height="size.height" class="block">
        <text v-if="state.title" :x="size.width / 2" :y="16" text-anchor="middle" class="fill-foreground text-[12px] font-semibold">{{ state.title }}</text>

        <!-- axes and grid -->
        <g class="text-[10px]">
          <line :x1="plotArea.left" :y1="plotArea.top + plotArea.height" :x2="plotArea.left + plotArea.width" :y2="plotArea.top + plotArea.height" class="stroke-muted-foreground" />
          <line :x1="plotArea.left" :y1="plotArea.top" :x2="plotArea.left" :y2="plotArea.top + plotArea.height" class="stroke-muted-foreground" />
          <g v-for="t in xTicks" :key="'x' + t">
            <line v-if="state.grid" :x1="toX(t)" :y1="plotArea.top" :x2="toX(t)" :y2="plotArea.top + plotArea.height" class="stroke-input" />
            <text :x="toX(t)" :y="plotArea.top + plotArea.height + 13" text-anchor="middle" class="fill-muted-foreground">{{ tickLabel(t) }}</text>
          </g>
          <g v-for="t in yTicks" :key="'y' + t">
            <line v-if="state.grid" :x1="plotArea.left" :y1="toY(t)" :x2="plotArea.left + plotArea.width" :y2="toY(t)" class="stroke-input" />
            <text :x="plotArea.left - 5" :y="toY(t) + 3" text-anchor="end" class="fill-muted-foreground">{{ tickLabel(t) }}</text>
          </g>
          <text v-if="state.xAxisTitle" :x="plotArea.left + plotArea.width / 2" :y="size.height - 4" text-anchor="middle" class="fill-muted-foreground">{{ state.xAxisTitle }}</text>
          <text v-if="state.yAxisTitle" :x="12" :y="plotArea.top + plotArea.height / 2" text-anchor="middle" class="fill-muted-foreground"
            :transform="`rotate(-90 12 ${plotArea.top + plotArea.height / 2})`">{{ state.yAxisTitle }}</text>
        </g>

        <!-- the series themselves -->
        <g v-for="s in state.series" :key="s.nodeID" :data-name="'series:' + s.name">
          <template v-if="s.type === 1 || s.type === 3">
            <rect v-for="(p, i) in s.points" :key="i" :x="toX(p[0]) - barWidth(s) / 2" :y="Math.min(toY(p[1]), toY(0))"
              :width="barWidth(s)" :height="Math.abs(toY(p[1]) - toY(0))" :fill="s.color" opacity="0.85" />
          </template>
          <path v-else-if="s.type === 0" :d="linePath(s)" fill="none" :stroke="s.color" :stroke-width="Math.max(1, s.lineWidth)" />
          <circle v-for="(p, i) in (s.type === 0 && s.markerSize <= 0 ? [] : s.points)" :key="'p' + i"
            :cx="toX(p[0])" :cy="toY(p[1])" :r="Math.max(1.5, s.markerSize / 2)" :fill="s.color" />
        </g>

        <!-- legend -->
        <g v-if="state.legend" class="text-[10px]">
          <g v-for="(s, i) in state.series" :key="'l' + s.nodeID" :transform="`translate(${plotArea.left + plotArea.width - 8}, ${plotArea.top + 10 + i * 13})`">
            <text text-anchor="end" class="fill-foreground">{{ s.name }}</text>
            <rect x="4" y="-7" width="8" height="8" :fill="s.color" />
          </g>
        </g>
      </svg>
      <div v-else class="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        {{ charts.length ? "Choose a chart to show." : "No chart in the scene." }}
      </div>
    </div>
  </div>
</template>

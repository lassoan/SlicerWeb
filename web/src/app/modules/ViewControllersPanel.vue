<script setup lang="ts">
// View Controllers: the properties of one view of the layout, chosen here or by clicking a view.
// A slice view offers what its own bar offers and more (qMRMLSliceControllerWidget); a 3D view
// what qMRMLThreeDViewControllerWidget offers.
import { inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SwButton, SwCheckBox, SwCollapsible, SwColorPicker, SwComboBox, SwFormRow, SwSlider } from "@/widgets";
import type { SlicerBridge } from "@/core/bridge";
import { store } from "../store";

interface ViewEntry { layoutName: string; kind: "slice" | "threeD"; label: string; color?: number[] }
interface ViewInfo {
  layoutName: string;
  kind: "slice" | "threeD";
  label: string;
  color: number[];
  orientationMarker: string;
  orientationMarkerSize: string;
  ruler: string;
  orientationMarkers: string[];
  orientationMarkerSizes: string[];
  rulers: string[];
  linked: boolean;
  // slice
  orientation?: string;
  orientations?: string[];
  offset?: number;
  offsetRange?: number[];
  offsetResolution?: number;
  backgroundVolumeID?: string | null;
  foregroundVolumeID?: string | null;
  labelVolumeID?: string | null;
  foregroundOpacity?: number;
  labelOpacity?: number;
  sliceVisible?: boolean;
  volumes?: { id: string; name: string }[];
  // 3D
  boxVisible?: boolean;
  axisLabelsVisible?: boolean;
  backgroundColor?: number[];
  backgroundColor2?: number[];
  renderMode?: "perspective" | "orthographic";
}

const bridge = inject<SlicerBridge>("bridge")!;
const views = ref<ViewEntry[]>([]);
const selected = ref<string>("");
const info = ref<ViewInfo | null>(null);
const trouble = ref("");

async function refreshViews() {
  // An empty menu says nothing. Where the views cannot be listed - an application whose Python
  // side is older than this page, say - the reason is shown instead.
  try {
    views.value = await bridge.call<ViewEntry[]>("listViews");
    trouble.value = views.value.length ? "" : "The layout has no views.";
  } catch (e: any) {
    views.value = [];
    trouble.value = `The views could not be listed: ${e?.message ?? e}`;
  }
  if (!views.value.some((v) => v.layoutName === selected.value)) {
    selected.value = (store.activeView && views.value.some((v) => v.layoutName === store.activeView) ? store.activeView : views.value[0]?.layoutName) ?? "";
  }
}

async function refresh() {
  if (!selected.value) {
    info.value = null;
    return;
  }
  info.value = await bridge.call<ViewInfo | null>("viewControllerInfo", [selected.value]).catch(() => null);
}

async function set(props: Record<string, unknown>) {
  if (!selected.value) return;
  await bridge.call("setViewControllerProperties", [selected.value, props]);
  await refresh();
}

const hex = (rgb: number[] | undefined) =>
  "#" + (rgb ?? [0, 0, 0]).map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
const rgb = (color: string) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
const volumeItems = () => [{ text: "None", data: "" }, ...(info.value?.volumes ?? []).map((v) => ({ text: v.name, data: v.id }))];
const volumeIndex = (id: string | null | undefined) => Math.max(0, (info.value?.volumes ?? []).findIndex((v) => v.id === id) + 1);
const viewTitle = (v: ViewEntry) => `${v.label} (${v.kind === "slice" ? "slice" : "3D"} view)`;

// The view clicked in the layout becomes the one edited here, as in desktop Slicer's module.
watch(() => store.activeView, (name) => { if (name && views.value.some((v) => v.layoutName === name)) selected.value = name; });
watch(selected, refresh);
const offs: (() => void)[] = [];
onMounted(async () => {
  await refreshViews();
  await refresh();
  offs.push(bridge.events.on("layout-changed", async () => { await refreshViews(); await refresh(); }));
  offs.push(bridge.events.on("scene-changed", refresh));
  offs.push(bridge.events.on("node-modified", refresh));
});
onBeforeUnmount(() => offs.forEach((off) => off()));
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="View">
      <SwComboBox :items="views.map(viewTitle)" :current-index="Math.max(0, views.findIndex((v) => v.layoutName === selected))"
        @current-index-changed="selected = views[$event]?.layoutName ?? ''" />
    </SwFormRow>
    <template v-if="info">
      <div class="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span class="inline-block h-3 w-3 rounded-sm" :style="{ background: hex(info.color) }" />{{ info.label }} · {{ info.layoutName }}
        <span class="flex-1" />
        <SwButton text="Fit" @clicked="bridge.call('fitView', [selected])" />
      </div>

      <SwCollapsible v-if="info.kind === 'slice'" text="Slice">
        <SwFormRow label="Orientation">
          <SwComboBox :items="info.orientations ?? []" :current-index="Math.max(0, (info.orientations ?? []).indexOf(info.orientation ?? ''))"
            @current-index-changed="set({ orientation: info!.orientations![$event] })" />
        </SwFormRow>
        <SwFormRow label="Offset">
          <SwSlider :value="info.offset ?? 0" :minimum="info.offsetRange?.[0] ?? -100" :maximum="info.offsetRange?.[1] ?? 100"
            :single-step="info.offsetResolution ?? 1" :decimals="2" suffix="mm" @value-changed="set({ offset: $event })" />
        </SwFormRow>
        <SwCheckBox text="Link with other slice views" :checked="info.linked" @toggled="set({ linked: $event })" />
        <SwCheckBox text="Show slice in 3D views" :checked="info.sliceVisible" @toggled="set({ sliceVisible: $event })" />
      </SwCollapsible>
      <SwCollapsible v-if="info.kind === 'slice'" text="Layers">
        <SwFormRow label="Background">
          <SwComboBox :items="volumeItems()" :current-index="volumeIndex(info.backgroundVolumeID)"
            @current-index-changed="set({ backgroundVolumeID: volumeItems()[$event].data })" />
        </SwFormRow>
        <SwFormRow label="Foreground">
          <SwComboBox :items="volumeItems()" :current-index="volumeIndex(info.foregroundVolumeID)"
            @current-index-changed="set({ foregroundVolumeID: volumeItems()[$event].data })" />
        </SwFormRow>
        <SwFormRow label="Foreground opacity">
          <SwSlider :value="info.foregroundOpacity ?? 0" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2"
            @value-changed="set({ foregroundOpacity: $event })" />
        </SwFormRow>
        <SwFormRow label="Label">
          <SwComboBox :items="volumeItems()" :current-index="volumeIndex(info.labelVolumeID)"
            @current-index-changed="set({ labelVolumeID: volumeItems()[$event].data })" />
        </SwFormRow>
        <SwFormRow label="Label opacity">
          <SwSlider :value="info.labelOpacity ?? 1" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2"
            @value-changed="set({ labelOpacity: $event })" />
        </SwFormRow>
      </SwCollapsible>

      <SwCollapsible v-if="info.kind === 'threeD'" text="3D view">
        <SwCheckBox text="Link cameras with other 3D views" :checked="info.linked" @toggled="set({ linked: $event })" />
        <SwCheckBox text="Show bounding box" :checked="info.boxVisible" @toggled="set({ boxVisible: $event })" />
        <SwCheckBox text="Show axis labels" :checked="info.axisLabelsVisible" @toggled="set({ axisLabelsVisible: $event })" />
        <SwFormRow label="Projection">
          <SwComboBox :items="['Perspective', 'Orthographic']" :current-index="info.renderMode === 'orthographic' ? 1 : 0"
            @current-index-changed="set({ renderMode: $event === 1 ? 'orthographic' : 'perspective' })" />
        </SwFormRow>
        <SwFormRow label="Background">
          <div class="flex items-center gap-3">
            <SwColorPicker :color="hex(info.backgroundColor)" text="top" @color-changed="set({ backgroundColor: rgb($event) })" />
            <SwColorPicker :color="hex(info.backgroundColor2)" text="bottom" @color-changed="set({ backgroundColor2: rgb($event) })" />
          </div>
        </SwFormRow>
      </SwCollapsible>

      <SwCollapsible text="Annotations">
        <SwFormRow label="Orientation marker">
          <SwComboBox :items="info.orientationMarkers" :current-index="info.orientationMarkers.indexOf(info.orientationMarker)"
            @current-index-changed="set({ orientationMarker: info!.orientationMarkers[$event] })" />
        </SwFormRow>
        <SwFormRow label="Marker size">
          <SwComboBox :items="info.orientationMarkerSizes" :current-index="info.orientationMarkerSizes.indexOf(info.orientationMarkerSize)"
            @current-index-changed="set({ orientationMarkerSize: info!.orientationMarkerSizes[$event] })" />
        </SwFormRow>
        <SwFormRow label="Ruler">
          <SwComboBox :items="info.rulers" :current-index="info.rulers.indexOf(info.ruler)"
            @current-index-changed="set({ ruler: info!.rulers[$event] })" />
        </SwFormRow>
      </SwCollapsible>
    </template>
    <div v-else class="py-6 text-center text-[12px] text-muted-foreground">{{ trouble || "Choose a view to edit its properties." }}</div>
  </div>
</template>

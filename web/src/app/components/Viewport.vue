<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Pin, RotateCcw, Maximize2 } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { store, type LayoutTreeNode } from "../store";

const props = defineProps<{ view: LayoutTreeNode }>();
const bridge = inject<SlicerBridge>("bridge")!;

const container = ref<HTMLDivElement>();
const canvasId = computed(() => `slicer-view-${props.view.layoutName}`);
const isSlice = computed(() => props.view.kind === "slice");
const isThreeD = computed(() => props.view.kind === "threeD");
const isActive = computed(() => store.activeView === props.view.layoutName);

interface SliceState {
  orientation: string;
  offset: number;
  offsetRange: [number, number];
  offsetResolution: number;
  backgroundVolumeID: string | null;
  foregroundVolumeID: string | null;
  labelVolumeID: string | null;
  foregroundOpacity: number;
  labelOpacity: number;
  fieldOfView: number[];
}
const slice = reactive<Partial<SliceState>>({});
const volumes = ref<{ id: string; name: string }[]>([]);
let attached = false;
let resizeObserver: ResizeObserver | null = null;
let offs: (() => void)[] = [];

async function refreshSliceState() {
  if (!isSlice.value || !attached) return;
  const s = await bridge.call<SliceState | null>("getSliceViewState", [props.view.layoutName]);
  if (s) Object.assign(slice, s);
}

function deviceSize() {
  const rect = container.value!.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return [Math.max(1, Math.round(rect.width * dpr)), Math.max(1, Math.round(rect.height * dpr))];
}

async function attach() {
  const [w, h] = deviceSize();
  attached = await bridge.call<boolean>("attachView", [props.view.layoutName, "#" + canvasId.value, w, h]);
  if (!attached) return;
  if (props.view.nodeID) await bridge.call("observeNode", [props.view.nodeID, true]);
  await refreshSliceState();
  await refreshVolumes();
}

let resizeFrame = 0;
function onResize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(async () => {
    if (!attached || !container.value) return;
    const [w, h] = deviceSize();
    await bridge.call("resizeView", [props.view.layoutName, w, h]);
  });
}

async function refreshVolumes() {
  if (!isSlice.value) return;
  const nodes = await bridge.call<{ id: string; name: string }[]>("getNodes", ["vtkMRMLVolumeNode"]);
  volumes.value = nodes;
}

onMounted(async () => {
  resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(container.value!);
  offs.push(
    bridge.events.on<{ id: string }>("node-modified", (p) => {
      if (p?.id === props.view.nodeID) refreshSliceState();
    }),
    bridge.events.on("scene-changed", () => {
      refreshVolumes();
      refreshSliceState();
    }),
  );
  await attach();
});

onBeforeUnmount(async () => {
  resizeObserver?.disconnect();
  offs.forEach((off) => off());
  if (attached) await bridge.call("detachView", [props.view.layoutName]);
});

async function setOffset(value: number) {
  slice.offset = value;
  await bridge.call("setSliceOffset", [props.view.layoutName, value]);
}

async function setOrientation(orientation: string) {
  await bridge.call("setSliceOrientation", [props.view.layoutName, orientation]);
  await refreshSliceState();
}

async function setLayer(layer: "background" | "foreground" | "label", id: string) {
  await bridge.call("setSliceLayerVolume", [props.view.layoutName, layer, id || null]);
  await refreshSliceState();
}

async function resetView() {
  if (isSlice.value) {
    await bridge.evalPython(`slicer.app.layoutManager().sliceWidget(${JSON.stringify(props.view.layoutName)}).sliceLogic().FitSliceToAll()`);
  } else {
    await bridge.evalPython(`slicer.app.layoutManager().view(${JSON.stringify(props.view.layoutName)}).ResetCamera(-1)`);
  }
}

async function rotateTo(direction: number) {
  await bridge.evalPython(`slicer.app.layoutManager().view(${JSON.stringify(props.view.layoutName)}).ResetCamera(${direction})`);
}

async function maximize() {
  if (!props.view.nodeID) return;
  await bridge.invoke("layout", "maximizeView", [{ __node__: props.view.nodeID }]);
}

const orientations = ["Axial", "Sagittal", "Coronal", "Reformat"];
// vtkMRMLCameraNode::Direction: Left=0, Right, Posterior, Anterior, Inferior, Superior
const directions = [
  ["L", 0],
  ["R", 1],
  ["P", 2],
  ["A", 3],
  ["I", 4],
  ["S", 5],
] as const;
const offsetText = computed(() => (slice.offset !== undefined ? `${slice.offset.toFixed(2)} mm` : ""));
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-col rounded-[4px] border bg-black"
    :class="isActive ? 'border-highlight' : 'border-input/60 hover:border-input'"
    @pointerdown="store.activeView = view.layoutName ?? ''">
    <!-- Slice / 3D view controller bar (Slicer's colored view controller, OHIF styling) -->
    <div class="flex h-[26px] shrink-0 items-center gap-1.5 border-b border-input/40 bg-card px-1.5 text-[12px]">
      <span class="inline-block h-3 w-3 shrink-0 rounded-sm" :style="{ background: view.color ?? '#888' }" />
      <span class="shrink-0 font-medium text-foreground">{{ view.label ?? view.layoutName }}</span>
      <template v-if="isSlice">
        <select class="h-5 shrink-0 rounded bg-input/60 px-1 text-[11px] text-foreground outline-none"
          :value="slice.orientation" @change="setOrientation(($event.target as HTMLSelectElement).value)">
          <option v-for="o in orientations" :key="o" :value="o">{{ o }}</option>
        </select>
        <input type="range" class="h-1 min-w-10 flex-1 cursor-pointer accent-highlight"
          :min="slice.offsetRange?.[0] ?? 0" :max="slice.offsetRange?.[1] ?? 0"
          :step="slice.offsetResolution || 0.1" :value="slice.offset ?? 0"
          @input="setOffset(Number(($event.target as HTMLInputElement).value))" />
        <span class="w-[74px] shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{{ offsetText }}</span>
        <select class="h-5 max-w-[110px] shrink rounded bg-input/60 px-1 text-[11px] text-foreground outline-none"
          title="Background volume" :value="slice.backgroundVolumeID ?? ''"
          @change="setLayer('background', ($event.target as HTMLSelectElement).value)">
          <option value="">None</option>
          <option v-for="v in volumes" :key="v.id" :value="v.id">{{ v.name }}</option>
        </select>
      </template>
      <template v-else-if="isThreeD">
        <div class="flex-1" />
        <button v-for="[l, d] in directions" :key="l" type="button"
          class="h-5 w-5 rounded text-[11px] text-muted-foreground hover:bg-accent hover:text-highlight" :title="`View from ${l}`"
          @click="rotateTo(d)">{{ l }}</button>
      </template>
      <div v-else class="flex-1" />
      <button type="button" class="text-muted-foreground hover:text-highlight" title="Reset view" @click="resetView"><RotateCcw :size="13" /></button>
      <button type="button" class="text-muted-foreground hover:text-highlight" title="Maximize view" @click="maximize"><Maximize2 :size="13" /></button>
      <Pin v-if="false" :size="13" />
    </div>
    <div ref="container" class="relative min-h-0 flex-1 overflow-hidden">
      <canvas v-if="isSlice || isThreeD" :id="canvasId" class="sw-view-canvas" tabindex="-1"
        @contextmenu.prevent @pointerdown="($event.target as HTMLCanvasElement).focus()" />
      <div v-else class="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        {{ view.className }} is shown in the module panel
      </div>
    </div>
  </div>
</template>

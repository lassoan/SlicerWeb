<script setup lang="ts">
// Web GUI of the Segmentations module: what qSlicerSegmentationsModuleWidget offers - the segments
// and their display, the representations, copying and moving segments between segmentations,
// exporting them to a labelmap or to models and importing them back, exporting them to files,
// and the binary labelmap layers.
import { computed, inject, ref, watch } from "vue";
import { Minus, MoreHorizontal, Plus } from "@lucide/vue";
import { SwButton, SwCheckBox, SwCollapsible, SwComboBox, SwFormRow, SwNodeSelector, SwSlider, SwSpinBox } from "@/widgets";
import type { SlicerRuntime } from "@/core/runtime";
import PopupMenu from "../components/PopupMenu.vue";
import SegmentList from "../components/SegmentList.vue";
import { openModule } from "../store";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface SegmentationInfo {
  name: string;
  segments: { id: string; name: string; color: string; visible: boolean; opacity: number }[];
  sourceRepresentation: string;
  hasClosedSurface: boolean;
  visible: boolean;
  opacity2DFill: number;
  opacity3D: number;
}
interface ViewEntry { id: string; name: string; kind: "slice" | "threeD"; checked: boolean }
interface DisplayInfo {
  visible: boolean; opacity: number; opacity2DFill: number; opacity2DOutline: number; opacity3D: number;
  visibility2DFill: boolean; visibility2DOutline: boolean; visibility3D: boolean; sliceIntersectionThickness: number;
  representation2D: string; representation3D: string; allViews: boolean; views: ViewEntry[];
}
interface ModuleInfo { sourceGeometry: string; layers: { segmentCount: number; layerCount: number }; representations: string[]; display: DisplayInfo | null }
interface SegmentDisplay {
  visible: boolean; visibility2DFill: boolean; visibility2DOutline: boolean; visibility3D: boolean;
  opacity2DFill: number; opacity2DOutline: number; opacity3D: number;
}
interface ConversionPath { cost: number; description: string; parameters: { name: string; value: string; description: string }[] }
interface Representation { name: string; present: boolean; isSource: boolean; paths: ConversionPath[] }
interface Representations { source: string; segmentCount: number; representations: Representation[] }
interface Target { id: string; name: string; kind: "labelmap" | "model" | "folder" }

const runtime = inject<SlicerRuntime>("runtime")!;
const nodeID = useSelectedNode("Segmentation");
const { state, bridge } = useNodeState<SegmentationInfo>("segmentationInfo", nodeID);
const { state: info, refresh: refreshInfo } = useNodeState<ModuleInfo>("segmentationModuleInfo", nodeID);
// The representations, as qMRMLSegmentationRepresentationsListView lists them: read with the
// segmentation, since a conversion changes what it holds.
const { state: representations, refresh: refreshRepresentations } = useNodeState<Representations>("segmentationRepresentations", nodeID);
const setDisplay = (props: Record<string, unknown>) => nodeID.value && bridge.call("setSegmentationDisplay", [nodeID.value, props]);

// ------------------------------------------------------------------ segments
// The segment chosen in the list; Add chooses the new one, Remove takes the chosen one away
const currentSegment = ref<string | null>(null);
async function addSegment() {
  if (!nodeID.value) return;
  currentSegment.value = await bridge.call<string>("addSegment", [nodeID.value]);
}
async function removeSegment() {
  if (!nodeID.value || !currentSegment.value) return;
  await bridge.call("removeSegment", [nodeID.value, currentSegment.value]);
  currentSegment.value = null;
}

// ------------------------------------------------------------------ display
const display = computed(() => info.value?.display ?? null);
async function setDisplayProperties(props: Record<string, unknown>) {
  if (!nodeID.value) return;
  await bridge.call("setSegmentationDisplayProperties", [nodeID.value, props]);
  refreshInfo();
}
function setViews(view: ViewEntry | null, checked: boolean) {
  const views = display.value?.views ?? [];
  if (!view) return setDisplayProperties({ views: checked ? null : [] });
  const chosen = views.filter((v) => (v.id === view.id ? checked : v.checked)).map((v) => v.id);
  return setDisplayProperties({ views: chosen.length === views.length ? null : chosen });
}
// The chosen segment's own display settings, read whenever it or the segmentation changes
const segmentDisplay = ref<SegmentDisplay | null>(null);
async function refreshSegmentDisplay() {
  segmentDisplay.value = nodeID.value && currentSegment.value
    ? await bridge.call<SegmentDisplay | null>("segmentDisplayInfo", [nodeID.value, currentSegment.value]).catch(() => null)
    : null;
}
watch([currentSegment, info], refreshSegmentDisplay);
async function setSegmentDisplay(props: Record<string, unknown>) {
  if (!nodeID.value || !currentSegment.value) return;
  await bridge.call("setSegmentDisplayProperties", [nodeID.value, currentSegment.value, props]);
  refreshSegmentDisplay();
}
const representationItems = computed(() => info.value?.representations ?? []);

// ------------------------------------------------------------------ representations
const conversionError = ref("");
const busy = ref("");
/** The representation whose conversion is being set up (the desktop's advanced conversion dialog), and the choices made. */
const advanced = ref<{ name: string; pathIndex: number; values: Record<string, string> } | null>(null);

async function convert(name: string, pathIndex: number | null = null, parameters: Record<string, string> | null = null) {
  if (!nodeID.value) return;
  conversionError.value = "";
  busy.value = name;
  try {
    await bridge.call("convertSegmentationRepresentation", [nodeID.value, name, pathIndex, parameters]);
    advanced.value = null;
  } catch (e: any) {
    conversionError.value = e.message ?? String(e);
  }
  busy.value = "";
  refreshRepresentations();
  refreshInfo();
}

async function remove(name: string) {
  if (!nodeID.value) return;
  await bridge.call("removeSegmentationRepresentation", [nodeID.value, name]);
  refreshRepresentations();
  refreshInfo();
}

async function makeSource(name: string) {
  if (!nodeID.value) return;
  if ((representations.value?.segmentCount ?? 0) > 0 && !window.confirm(
    "Changing source representation will make the 'gold standard' representation the selected one, " +
    "and will result in deletion of all the other representations.\n" +
    "This may mean losing important data that cannot be created again from the new source representation.\n\n" +
    "(Reminder: Source representation is the data type which is saved to disk, and which is used as input when creating other representations)\n\n" +
    "Do you wish to proceed with changing source representation?")) return;
  await bridge.call("setSegmentationSourceRepresentation", [nodeID.value, name]);
  refreshRepresentations();
  refreshInfo();
}

function openAdvanced(r: Representation) {
  const path = r.paths[0];
  advanced.value = { name: r.name, pathIndex: 0, values: Object.fromEntries((path?.parameters ?? []).map((p) => [p.name, p.value])) };
}
function choosePath(r: Representation, index: number) {
  if (!advanced.value) return;
  advanced.value = { ...advanced.value, pathIndex: index, values: Object.fromEntries(r.paths[index].parameters.map((p) => [p.name, p.value])) };
}
const pathLabel = (p: ConversionPath) => `${p.description} (cost ${p.cost})`;

// ------------------------------------------------------------------ copy and move
const otherNodeID = ref<string | null>(null);
const otherSegment = ref<string | null>(null);
const copyError = ref("");
/** Copy or move the chosen segment: from here to the other segmentation, or the other way. */
async function copySegments(fromCurrent: boolean, remove: boolean) {
  const from = fromCurrent ? nodeID.value : otherNodeID.value;
  const to = fromCurrent ? otherNodeID.value : nodeID.value;
  const segment = fromCurrent ? currentSegment.value : otherSegment.value;
  if (!from || !to || !segment) return;
  copyError.value = "";
  try {
    await bridge.call("copySegments", [from, to, [segment], remove, false]);
  } catch (e: any) {
    const message = e?.message ?? String(e);
    // The other segmentation cannot take the segment as it is: the desktop asks whether to
    // change its source representation, and so does this
    if (/Would you like to change the source representation/.test(message) && window.confirm(message)) {
      try {
        await bridge.call("copySegments", [from, to, [segment], remove, true]);
      } catch (again: any) {
        copyError.value = again?.message ?? String(again);
      }
    } else copyError.value = message;
  }
  if (remove) (fromCurrent ? currentSegment : otherSegment).value = null;
}

// ------------------------------------------------------------------ export and import
const operation = ref(0);           // 0 export, 1 import
const exportType = ref(0);          // 0 labelmap, 1 models
const targets = ref<Target[]>([]);
const sources = ref<Target[]>([]);
const target = ref<string | null>(null);   // null: a new labelmap or folder
const source = ref<string | null>(null);
const exportedSegments = ref(0);    // 0 all, 1 visible
const referenceVolumeID = ref<string | null>(null);
const useColorTable = ref(false);
const colorTableID = ref<string | null>(null);
const terminologies = ref<string[]>([]);
const terminologyContext = ref("");
const exportMessage = ref("");
const exportError = ref("");
const targetItems = computed(() => [
  { text: exportType.value === 0 ? "New labelmap" : "New folder", data: null as string | null },
  ...targets.value.filter((t) => (exportType.value === 0 ? t.kind === "labelmap" : t.kind === "folder")).map((t) => ({ text: t.name, data: t.id as string | null })),
]);
const sourceItems = computed(() => sources.value.map((t) => ({ text: `${t.name} (${t.kind})`, data: t.id })));
async function refreshTargets() {
  targets.value = await bridge.call<Target[]>("segmentationExportTargets").catch(() => []);
  sources.value = await bridge.call<Target[]>("segmentationImportSources").catch(() => []);
  if (!targets.value.some((t) => t.id === target.value)) target.value = null;
  if (!sources.value.some((t) => t.id === source.value)) source.value = sources.value[0]?.id ?? null;
  if (!terminologies.value.length) terminologies.value = await bridge.call<string[]>("terminologyNames").catch(() => []);
}
watch(info, refreshTargets, { immediate: true });
async function applyImportExport() {
  if (!nodeID.value) return;
  exportError.value = "";
  exportMessage.value = "";
  try {
    if (operation.value === 0) {
      const made = await bridge.call<Target>("exportSegmentation", [nodeID.value, {
        type: exportType.value === 0 ? "labelmap" : "models", target: target.value,
        segments: exportedSegments.value === 1 ? "visible" : "all",
        referenceVolumeID: referenceVolumeID.value, colorTableID: useColorTable.value ? colorTableID.value : null,
      }]);
      exportMessage.value = `Exported to ${made.name}.`;
      target.value = made.id;
    } else {
      if (!source.value) throw new Error("Choose what to import");
      await bridge.call("importToSegmentation", [nodeID.value, source.value, terminologyContext.value]);
      exportMessage.value = "Imported.";
    }
  } catch (e: any) {
    exportError.value = e?.message ?? String(e);
  }
  refreshInfo();
  refreshTargets();
}

// ------------------------------------------------------------------ export to files
const FORMATS = ["STL", "OBJ", "NRRD", "NIFTI"];
const fileFormat = ref(0);
const visibleOnly = ref(false);
const mergeFiles = ref(false);
const sizeScale = ref(1.0);
const coordinateSystem = ref(0);    // 0 LPS, 1 RAS
const compression = ref(false);
const filesMessage = ref("");
const filesError = ref("");
const surfaceFormat = computed(() => fileFormat.value < 2);
async function exportToFiles() {
  if (!nodeID.value) return;
  filesError.value = "";
  filesMessage.value = "";
  try {
    const made = await bridge.call<{ path: string; files: string[] }>("exportSegmentationToFiles", [nodeID.value, {
      format: FORMATS[fileFormat.value], visibleOnly: visibleOnly.value, merge: mergeFiles.value, sizeScale: sizeScale.value,
      lps: coordinateSystem.value === 0, compression: compression.value,
      referenceVolumeID: referenceVolumeID.value, colorTableID: useColorTable.value ? colorTableID.value : null,
    }]);
    runtime.saveFileToDisk(made.path);
    filesMessage.value = `${made.files.length} file${made.files.length === 1 ? "" : "s"}: ${made.files.join(", ")}`;
  } catch (e: any) {
    filesError.value = e?.message ?? String(e);
  }
}

// ------------------------------------------------------------------ layers
const forceSingleLayer = ref(false);
async function collapseLayers() {
  if (!nodeID.value) return;
  await bridge.call("collapseSegmentationLayers", [nodeID.value, forceSingleLayer.value]);
  refreshInfo();
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Segmentation">
      <SwNodeSelector node-types="vtkMRMLSegmentationNode" :current-node-id="nodeID" add-enabled rename-enabled remove-enabled
        base-name="Segmentation" @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <div class="text-[12px] text-muted-foreground" title="Node that was used for setting the segmentation geometry (origin, spacing, axis directions, and default extent)"
        data-name="sourceGeometry">Source geometry: {{ info?.sourceGeometry || "none" }}</div>
      <div class="flex flex-wrap items-center gap-1">
        <SwButton data-name="addSegment" tool-tip="Add empty segment" @clicked="addSegment"><Plus :size="14" />Add</SwButton>
        <SwButton data-name="removeSegment" tool-tip="Remove selected segment" :enabled="!!currentSegment" @clicked="removeSegment"><Minus :size="14" />Remove</SwButton>
        <SwButton text="Show 3D" :primary="state.hasClosedSurface" data-name="show3D"
          :tool-tip="state.hasClosedSurface ? 'Hide the segments in the 3D views' : 'Show the segments in the 3D views'"
          @clicked="setDisplay({ showSurfaces: !state.hasClosedSurface })" />
        <span class="flex-1" />
        <SwButton text="Edit…" tool-tip="Go to Segment Editor module" @clicked="openModule('SegmentEditor')" />
      </div>
      <!-- The same list as the Segment Editor's: choose, rename, colour and terminology, status, show, remove -->
      <SegmentList :segmentation-node-id="nodeID" :current-id="currentSegment" @select="currentSegment = $event" @changed="refreshInfo" />

      <SwCollapsible text="Display" data-name="displaySection">
        <template v-if="display">
          <SwCheckBox text="Visible" :checked="display.visible" @toggled="setDisplayProperties({ visible: $event })" />
          <SwFormRow label="Overall opacity">
            <SwSlider :value="display.opacity" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2" data-name="overallOpacity"
              @value-changed="setDisplayProperties({ opacity: $event })" />
          </SwFormRow>
          <SwCollapsible text="Advanced" collapsed>
            <SwFormRow label="Views">
              <div class="flex flex-wrap gap-x-3 gap-y-1" data-name="displayViews">
                <SwCheckBox text="All" :checked="display.allViews" @toggled="setViews(null, $event)" />
                <SwCheckBox v-for="v in display.views" :key="v.id" :text="v.name" :checked="v.checked" :data-view="v.id" @toggled="setViews(v, $event)" />
              </div>
            </SwFormRow>
            <SwFormRow label="Representation in 3D views">
              <SwComboBox :items="representationItems" :current-index="Math.max(0, representationItems.indexOf(display.representation3D))"
                tool-tip="Representation that is shown as a model in 3D and as slice intersections in 2D if exists"
                @current-index-changed="setDisplayProperties({ representation3D: representationItems[$event] })" />
            </SwFormRow>
            <SwFormRow label="Representation in 2D views">
              <SwComboBox :items="representationItems" :current-index="Math.max(0, representationItems.indexOf(display.representation2D))"
                tool-tip="Representation that is shown in the 2D slice views"
                @current-index-changed="setDisplayProperties({ representation2D: representationItems[$event] })" />
            </SwFormRow>
            <SwFormRow label="Slice intersection thickness">
              <SwSpinBox :value="display.sliceIntersectionThickness" :minimum="1" :maximum="20" suffix=" px" data-name="sliceIntersectionThickness"
                @value-changed="setDisplayProperties({ sliceIntersectionThickness: $event })" />
            </SwFormRow>
            <div class="mt-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">All segments</div>
            <div class="grid grid-cols-[auto_auto_1fr] items-center gap-x-2 gap-y-1 text-[12px]">
              <span>Slice fill</span><SwCheckBox :checked="display.visibility2DFill" @toggled="setDisplayProperties({ visibility2DFill: $event })" />
              <SwSlider :value="display.opacity2DFill" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2" @value-changed="setDisplayProperties({ opacity2DFill: $event })" />
              <span>Slice outline</span><SwCheckBox :checked="display.visibility2DOutline" @toggled="setDisplayProperties({ visibility2DOutline: $event })" />
              <SwSlider :value="display.opacity2DOutline" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2" @value-changed="setDisplayProperties({ opacity2DOutline: $event })" />
              <span>3D</span><SwCheckBox :checked="display.visibility3D" @toggled="setDisplayProperties({ visibility3D: $event })" />
              <SwSlider :value="display.opacity3D" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2" @value-changed="setDisplayProperties({ opacity3D: $event })" />
            </div>
            <template v-if="segmentDisplay">
              <div class="mt-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Selected segment</div>
              <div class="grid grid-cols-[auto_auto_1fr] items-center gap-x-2 gap-y-1 text-[12px]" data-name="selectedSegmentDisplay"
                title="Value relative to other segments. The final opacity depends both on the per-segment opacity and the overall opacity (above)">
                <span>Slice fill</span><SwCheckBox :checked="segmentDisplay.visibility2DFill" @toggled="setSegmentDisplay({ visibility2DFill: $event })" />
                <SwSlider :value="segmentDisplay.opacity2DFill" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2" @value-changed="setSegmentDisplay({ opacity2DFill: $event })" />
                <span>Slice outline</span><SwCheckBox :checked="segmentDisplay.visibility2DOutline" @toggled="setSegmentDisplay({ visibility2DOutline: $event })" />
                <SwSlider :value="segmentDisplay.opacity2DOutline" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2" @value-changed="setSegmentDisplay({ opacity2DOutline: $event })" />
                <span>3D</span><SwCheckBox :checked="segmentDisplay.visibility3D" @toggled="setSegmentDisplay({ visibility3D: $event })" />
                <SwSlider :value="segmentDisplay.opacity3D" :minimum="0" :maximum="1" :single-step="0.05" :decimals="2" @value-changed="setSegmentDisplay({ opacity3D: $event })" />
              </div>
            </template>
          </SwCollapsible>
        </template>
        <div v-else class="text-[12px] text-muted-foreground">The segmentation has no display node.</div>
      </SwCollapsible>

      <!-- The representations the segmentation holds: the source (saved to disk, converted from),
           the ones made from it, and the ones that could be. As on the desktop, a missing one is
           created with the default conversion or with a chosen path and parameters; a present one
           is updated the same way, removed, or made the source. -->
      <SwCollapsible v-if="representations" text="Representations" collapsed>
        <div v-for="r in representations.representations" :key="r.name" class="rounded px-1 py-1 text-[13px] hover:bg-accent/30" data-name="representation" :data-representation="r.name">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ r.name }}</span>
            <span v-if="r.isSource" class="rounded bg-primary/30 px-1.5 text-[11px] text-highlight" title="This is the source representation: it is saved on disk, and if it is modified the others are cleared">Source</span>
            <span v-else-if="r.present" class="rounded bg-emerald-900/50 px-1.5 text-[11px] text-emerald-200" title="This representation is present">Present</span>
            <span v-else class="text-[11px] text-muted-foreground" title="This representation is not present">not present</span>
            <span class="flex-1" />
            <!-- What can be done with the representation, behind one button, as with a segment or a node -->
            <PopupMenu v-if="!r.isSource" align="right">
              <template #trigger="{ open, toggle }">
                <button type="button" class="sw-row-action text-muted-foreground hover:text-highlight disabled:opacity-40" :class="open ? 'text-highlight' : ''"
                  :title="`More for ${r.name}`" :disabled="!!busy" data-name="representationMore" @click.stop="toggle()"><MoreHorizontal :size="14" /></button>
              </template>
              <template v-if="r.present">
                <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
                  :title="`Update ${r.name} representation using custom conversion parameters`" @click="openAdvanced(r)">Update…</button>
                <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-red-300 hover:bg-accent/60"
                  :title="`Remove ${r.name} representation from segmentation`" @click="remove(r.name)">Remove</button>
              </template>
              <template v-else-if="r.paths.length">
                <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
                  :title="`Create ${r.name} representation using default conversion parameters`" @click="convert(r.name)">Create</button>
                <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
                  :title="`Create ${r.name} representation using custom conversion parameters`" @click="openAdvanced(r)">Advanced create…</button>
              </template>
              <button v-if="r.present || representations.segmentCount === 0" type="button" role="menuitem"
                class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
                title="Make this the source representation: the one saved to disk and converted from; the others are then made anew" @click="makeSource(r.name)">Make source</button>
            </PopupMenu>
          </div>
          <div v-if="advanced?.name === r.name" class="mt-1 flex flex-col gap-1 rounded border border-input bg-background/40 p-2" data-name="advancedConversion">
            <SwFormRow label="Path">
              <SwComboBox :items="r.paths.map(pathLabel)" :current-index="advanced.pathIndex" @current-index-changed="choosePath(r, $event)" />
            </SwFormRow>
            <div v-if="!r.paths[advanced.pathIndex]?.parameters.length" class="text-[12px] text-muted-foreground">This conversion has no parameters.</div>
            <div v-for="p in r.paths[advanced.pathIndex]?.parameters ?? []" :key="p.name" class="flex items-center gap-2" :title="p.description">
              <span class="w-44 shrink-0 truncate text-[12px]">{{ p.name }}</span>
              <input class="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1 text-[12px] outline-none focus:border-primary"
                :value="advanced.values[p.name]" :data-parameter="p.name" @input="advanced!.values[p.name] = ($event.target as HTMLInputElement).value" />
            </div>
            <div class="flex gap-1">
              <SwButton text="Convert" primary :enabled="!busy" @clicked="convert(r.name, advanced!.pathIndex, advanced!.values)" />
              <SwButton text="Cancel" @clicked="advanced = null" />
            </div>
          </div>
        </div>
        <div v-if="busy" class="text-[12px] text-muted-foreground">Converting to {{ busy }}…</div>
        <div v-if="conversionError" class="rounded bg-destructive/40 px-2 py-1 text-[12px] whitespace-pre-wrap">{{ conversionError }}</div>
      </SwCollapsible>

      <!-- Copying and moving segments to and from another segmentation, as the desktop's two lists -->
      <SwCollapsible text="Copy/move segments" collapsed data-name="copyMoveSection">
        <SwFormRow label="Other segmentation">
          <SwNodeSelector node-types="vtkMRMLSegmentationNode" :current-node-id="otherNodeID" none-enabled :hidden-node-i-ds="nodeID ? [nodeID] : []"
            data-name="otherSegmentation" @current-node-changed="otherNodeID = $event; otherSegment = null" />
        </SwFormRow>
        <div class="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_1fr]">
          <div>
            <div class="text-[11px] text-muted-foreground">Current segmentation</div>
            <SegmentList :segmentation-node-id="nodeID" :current-id="currentSegment" @select="currentSegment = $event" @changed="refreshInfo" />
          </div>
          <div class="flex flex-row items-center justify-center gap-1 md:flex-col" data-name="copyMoveButtons">
            <SwButton text="Move >" tool-tip="Move from current segmentation to other segmentation" :enabled="!!otherNodeID && !!currentSegment" @clicked="copySegments(true, true)" />
            <SwButton text="Copy +>" tool-tip="Copy from current segmentation to other segmentation" :enabled="!!otherNodeID && !!currentSegment" @clicked="copySegments(true, false)" />
            <SwButton text="<+ Copy" tool-tip="Copy to current segmentation from other segmentation" :enabled="!!otherNodeID && !!otherSegment" @clicked="copySegments(false, false)" />
            <SwButton text="< Move" tool-tip="Move to current segmentation from other segmentation" :enabled="!!otherNodeID && !!otherSegment" @clicked="copySegments(false, true)" />
          </div>
          <div>
            <div class="text-[11px] text-muted-foreground">Other segmentation</div>
            <SegmentList v-if="otherNodeID" :segmentation-node-id="otherNodeID" :current-id="otherSegment" data-name="otherSegments" @select="otherSegment = $event" />
            <div v-else class="rounded-md border border-input/60 p-2 text-[12px] text-muted-foreground">Choose another segmentation to copy or move segments to or from.</div>
          </div>
        </div>
        <div v-if="copyError" class="rounded bg-destructive/40 px-2 py-1 text-[12px] whitespace-pre-wrap">{{ copyError }}</div>
      </SwCollapsible>

      <!-- Export to a labelmap or to models, import from a labelmap, a model or a folder of models -->
      <SwCollapsible text="Export/import models and labelmaps" collapsed data-name="importExportSection">
        <SwFormRow label="Operation">
          <SwComboBox :items="['Export', 'Import']" :current-index="operation" data-name="importExportOperation" @current-index-changed="operation = $event" />
        </SwFormRow>
        <template v-if="operation === 0">
          <SwFormRow label="Type">
            <SwComboBox :items="['Labelmap', 'Models']" :current-index="exportType" data-name="exportType" @current-index-changed="exportType = $event; target = null" />
          </SwFormRow>
          <SwFormRow label="Output">
            <SwComboBox :items="targetItems" :current-index="Math.max(0, targetItems.findIndex((t) => t.data === target))" data-name="exportTarget"
              @current-index-changed="target = targetItems[$event]?.data ?? null" />
          </SwFormRow>
        </template>
        <SwFormRow v-else label="Input">
          <SwComboBox :items="sourceItems" :current-index="Math.max(0, sourceItems.findIndex((t) => t.data === source))" data-name="importSource"
            @current-index-changed="source = sourceItems[$event]?.data ?? null" />
        </SwFormRow>
        <SwCollapsible text="Advanced" collapsed>
          <template v-if="operation === 0">
            <SwFormRow label="Exported segments">
              <SwComboBox :items="['All', 'Visible']" :current-index="exportedSegments" @current-index-changed="exportedSegments = $event" />
            </SwFormRow>
            <SwFormRow label="Reference volume">
              <SwNodeSelector node-types="vtkMRMLVolumeNode" :current-node-id="referenceVolumeID" none-enabled data-name="referenceVolume"
                @current-node-changed="referenceVolumeID = $event" />
            </SwFormRow>
            <SwFormRow label="Use color table values">
              <div class="flex items-center gap-2">
                <SwCheckBox :checked="useColorTable" @toggled="useColorTable = $event" />
                <SwNodeSelector class="flex-1" node-types="vtkMRMLColorTableNode" :current-node-id="colorTableID" none-enabled :enabled="useColorTable"
                  @current-node-changed="colorTableID = $event" />
              </div>
            </SwFormRow>
          </template>
          <SwFormRow v-else label="Terminology context">
            <SwComboBox :items="['(none)', ...terminologies]" :current-index="Math.max(0, terminologies.indexOf(terminologyContext) + 1)"
              tool-tip="Labels of the imported labelmap will be mapped to terminology entries of this context"
              @current-index-changed="terminologyContext = $event === 0 ? '' : terminologies[$event - 1]" />
          </SwFormRow>
        </SwCollapsible>
        <div class="flex items-center gap-2">
          <SwButton text="Apply" primary data-name="importExportApply" @clicked="applyImportExport" />
          <span v-if="exportMessage" class="text-[12px] text-muted-foreground" data-name="importExportMessage">{{ exportMessage }}</span>
        </div>
        <div v-if="exportError" class="rounded bg-destructive/40 px-2 py-1 text-[12px] whitespace-pre-wrap">{{ exportError }}</div>
      </SwCollapsible>

      <!-- Export to files: STL, OBJ, NRRD or NIfTI, handed to the browser as a download -->
      <SwCollapsible text="Export to files" collapsed data-name="exportFilesSection">
        <SwFormRow label="File format">
          <SwComboBox :items="FORMATS" :current-index="fileFormat" data-name="fileFormat" @current-index-changed="fileFormat = $event" />
        </SwFormRow>
        <SwCheckBox text="Visible segments only" :checked="visibleOnly" @toggled="visibleOnly = $event" />
        <template v-if="surfaceFormat">
          <SwCheckBox text="Merge into single file" :checked="mergeFiles || fileFormat === 1" :enabled="fileFormat === 0"
            tool-tip="Export all segments to a single output file (always so for OBJ, as segments can be told apart by their material)"
            @toggled="mergeFiles = $event" />
          <SwFormRow label="Size scale">
            <SwSpinBox :value="sizeScale" :minimum="0.001" :maximum="1000" :single-step="0.1" :decimals="3"
              tool-tip="Adjust the exported model size. Point coordinates in the exported model will be multiplied by this number. By default Slicer uses millimeter unit for coordinates."
              @value-changed="sizeScale = $event" />
          </SwFormRow>
          <SwFormRow label="Coordinate system">
            <SwComboBox :items="['LPS', 'RAS']" :current-index="coordinateSystem"
              tool-tip="Output model XYZ axes are mapped to LPS (left-posterior-superior) or RAS (right-anterior-superior) patient axis directions. LPS is used more commonly."
              @current-index-changed="coordinateSystem = $event" />
          </SwFormRow>
        </template>
        <template v-else>
          <SwCheckBox text="Use compression" :checked="compression" @toggled="compression = $event" />
          <SwFormRow label="Reference volume">
            <SwNodeSelector node-types="vtkMRMLVolumeNode" :current-node-id="referenceVolumeID" none-enabled @current-node-changed="referenceVolumeID = $event" />
          </SwFormRow>
          <SwFormRow label="Use color table values">
            <div class="flex items-center gap-2">
              <SwCheckBox :checked="useColorTable" @toggled="useColorTable = $event" />
              <SwNodeSelector class="flex-1" node-types="vtkMRMLColorTableNode" :current-node-id="colorTableID" none-enabled :enabled="useColorTable"
                @current-node-changed="colorTableID = $event" />
            </div>
          </SwFormRow>
        </template>
        <div class="flex items-center gap-2">
          <SwButton text="Export" primary data-name="exportToFiles" @clicked="exportToFiles" />
          <span v-if="filesMessage" class="min-w-0 truncate text-[12px] text-muted-foreground" data-name="exportFilesMessage">{{ filesMessage }}</span>
        </div>
        <div v-if="filesError" class="rounded bg-destructive/40 px-2 py-1 text-[12px] whitespace-pre-wrap">{{ filesError }}</div>
      </SwCollapsible>

      <SwCollapsible text="Binary labelmap layers" collapsed data-name="layersSection">
        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <span class="text-muted-foreground">Number of segments:</span><span data-name="segmentCount">{{ info?.layers.segmentCount ?? 0 }}</span>
          <span class="text-muted-foreground">Number of layers:</span><span data-name="layerCount">{{ info?.layers.layerCount ?? 0 }}</span>
        </div>
        <SwCheckBox text="Force collapse to single layer" :checked="forceSingleLayer" data-name="forceSingleLayer"
          tool-tip="Forcing all segments to a single layer will modify overlapping segments. Regions where multiple segments overlap will be assigned to the segment closest to the end of the segment list."
          @toggled="forceSingleLayer = $event" />
        <SwButton text="Collapse labelmap layers" data-name="collapseLayers"
          tool-tip="Minimize the number of layers by moving segments to shared layers to minimize memory usage. Contents of segments are not modified unless there are overlapping segments and collapsing to a single layer is forced."
          @clicked="collapseLayers" />
      </SwCollapsible>
    </template>
  </div>
</template>

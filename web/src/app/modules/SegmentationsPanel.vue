<script setup lang="ts">
import { ref } from "vue";
import { Eye, EyeOff, Trash2 } from "@lucide/vue";
import { SwButton, SwCheckBox, SwCollapsible, SwComboBox, SwFormRow, SwNodeSelector, SwSlider } from "@/widgets";
import { openModule, store } from "../store";
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
interface ConversionPath { cost: number; description: string; parameters: { name: string; value: string; description: string }[] }
interface Representation { name: string; present: boolean; isSource: boolean; paths: ConversionPath[] }
interface Representations { source: string; segmentCount: number; representations: Representation[] }

const nodeID = useSelectedNode("Segmentation");
const { state, bridge } = useNodeState<SegmentationInfo>("segmentationInfo", nodeID);
// The representations, as qMRMLSegmentationRepresentationsListView lists them: read with the
// segmentation, since a conversion changes what it holds.
const { state: representations, refresh: refreshRepresentations } = useNodeState<Representations>("segmentationRepresentations", nodeID);
const setSeg = (id: string, props: Record<string, unknown>) => nodeID.value && bridge.call("setSegment", [nodeID.value, id, props]);
const setDisplay = (props: Record<string, unknown>) => nodeID.value && bridge.call("setSegmentationDisplay", [nodeID.value, props]);

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
}

async function remove(name: string) {
  if (!nodeID.value) return;
  await bridge.call("removeSegmentationRepresentation", [nodeID.value, name]);
  refreshRepresentations();
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
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Segmentation">
      <SwNodeSelector node-types="vtkMRMLSegmentationNode" :current-node-id="nodeID" add-enabled rename-enabled remove-enabled
        base-name="Segmentation" @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <SwButton text="Edit segments…" primary @clicked="openModule('SegmentEditor')" />
      <SwCollapsible :text="`Segments (${state.segments.length})`">
        <div v-for="s in state.segments" :key="s.id" class="group flex h-7 items-center gap-2 rounded px-1 text-[13px] hover:bg-accent/40">
          <input type="color" class="h-4 w-5 cursor-pointer border-0 bg-transparent p-0" :value="s.color" @input="setSeg(s.id, { color: ($event.target as HTMLInputElement).value })" />
          <input class="min-w-0 flex-1 bg-transparent outline-none focus:bg-background" :value="s.name" @change="setSeg(s.id, { name: ($event.target as HTMLInputElement).value })" />
          <button type="button" class="text-muted-foreground hover:text-highlight" @click="setSeg(s.id, { visible: !s.visible })">
            <Eye v-if="s.visible" :size="14" /><EyeOff v-else :size="14" />
          </button>
          <button type="button" class="hidden text-muted-foreground group-hover:inline hover:text-red-400" @click="bridge.call('removeSegment', [nodeID, s.id])"><Trash2 :size="14" /></button>
        </div>
      </SwCollapsible>
      <SwCollapsible text="Display">
        <SwCheckBox text="Visible" :checked="state.visible" @toggled="setDisplay({ visible: $event })" />
        <SwCheckBox text="Show 3D (closed surfaces)" :checked="state.hasClosedSurface" @toggled="setDisplay({ showSurfaces: $event })" />
        <SwFormRow label="Slice fill opacity"><SwSlider :value="state.opacity2DFill" :minimum="0" :maximum="1" :single-step="0.05" @value-changed="setDisplay({ opacity2DFill: $event })" /></SwFormRow>
        <SwFormRow label="3D opacity"><SwSlider :value="state.opacity3D" :minimum="0" :maximum="1" :single-step="0.05" @value-changed="setDisplay({ opacity3D: $event })" /></SwFormRow>
      </SwCollapsible>

      <!-- The representations the segmentation holds: the source (saved to disk, converted from),
           the ones made from it, and the ones that could be. As on the desktop, a missing one is
           created with the default conversion or with a chosen path and parameters; a present one
           is updated the same way, removed, or made the source. -->
      <SwCollapsible v-if="representations" text="Representations">
        <div v-for="r in representations.representations" :key="r.name" class="rounded px-1 py-1 text-[13px] hover:bg-accent/30" data-name="representation" :data-representation="r.name">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ r.name }}</span>
            <span v-if="r.isSource" class="rounded bg-primary/30 px-1.5 text-[11px] text-highlight" title="This is the source representation: it is saved on disk, and if it is modified the others are cleared">Source</span>
            <span v-else-if="r.present" class="rounded bg-emerald-900/50 px-1.5 text-[11px] text-emerald-200" title="This representation is present">Present</span>
            <span v-else class="text-[11px] text-muted-foreground" title="This representation is not present">not present</span>
            <span class="flex-1" />
            <template v-if="!r.isSource">
              <template v-if="r.present">
                <SwButton text="Update" :tool-tip="`Update ${r.name} representation using custom conversion parameters`" :enabled="!busy" @clicked="openAdvanced(r)" />
                <SwButton text="Remove" :tool-tip="`Remove ${r.name} representation from segmentation`" :enabled="!busy" @clicked="remove(r.name)" />
              </template>
              <template v-else-if="r.paths.length">
                <SwButton text="Create" :tool-tip="`Create ${r.name} representation using default conversion parameters`" :enabled="!busy" @clicked="convert(r.name)" />
                <SwButton text="Advanced…" :tool-tip="`Create ${r.name} representation using custom conversion parameters`" :enabled="!busy" @clicked="openAdvanced(r)" />
              </template>
              <SwButton v-if="r.present || representations.segmentCount === 0" text="Make source" :enabled="!busy" @clicked="makeSource(r.name)" />
            </template>
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
    </template>
  </div>
</template>

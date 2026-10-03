<script setup lang="ts">
import { ref, watch } from "vue";
import { Crosshair, Trash2, Lock, Unlock } from "@lucide/vue";
import { SwCheckBox, SwCollapsible, SwColorPicker, SwFormRow, SwNodeSelector, SwSlider, SwButton } from "@/widgets";
import { store } from "../store";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface MarkupsInfo {
  name: string;
  markupType: string;
  controlPoints: { index: number; label: string; position: number[]; selected: boolean; visible: boolean; locked: boolean }[];
  measurements: { name: string; value: number; units: string; text: string }[];
  locked: boolean;
  visible: boolean;
  color: string;
  glyphScale: number;
  textScale: number;
  fillOpacity: number;
  handles: Handles | null;
}
/** Interaction handles of the markup (desktop Slicer's "Interaction Handles" of the markups display settings). */
interface HandleKind { visible: boolean; components: boolean[] }
interface Handles {
  visible: boolean; canScale: boolean; size: number; opacity: number;
  translation: HandleKind; rotation: HandleKind; scale: HandleKind;
}
type HandleKindName = "translation" | "rotation" | "scale";
const HANDLE_KINDS: { kind: HandleKindName; label: string }[] = [
  { kind: "translation", label: "Enable translation" },
  { kind: "rotation", label: "Enable rotation" },
  { kind: "scale", label: "Enable scaling" },
];
const HANDLE_COMPONENTS = ["X", "Y", "Z", "View plane"];

const nodeID = useSelectedNode("Markups");
const { state, bridge } = useNodeState<MarkupsInfo>("markupsInfo", nodeID);
// The markup chosen here is the one that placed points go to, as in the Markups module of desktop
// Slicer: placing a point then adds to it rather than making a new one
watch(nodeID, (id) => { if (id) bridge.call("setActivePlaceNode", [id]).catch(() => {}); }, { immediate: true });

const set = (props: Record<string, unknown>) => nodeID.value && bridge.call("setMarkupsDisplay", [nodeID.value, props]);
/** The per-axis settings of the handles are shown on request, as desktop Slicer's "More options..." does. */
const handleComponentsShown = ref(false);
function setHandles(properties: Record<string, unknown>) {
  return set({ handles: properties });
}
function setHandleComponent(kind: HandleKindName, component: number, visible: boolean) {
  const components = [...(state.value?.handles?.[kind].components ?? [true, true, true, true])];
  components[component] = visible;
  return setHandles({ [kind]: { components } });
}
const point = (index: number, action: string, value?: unknown) => nodeID.value && bridge.call("markupsControlPoint", [nodeID.value, index, action, value]);

async function placeMore() {
  if (!nodeID.value) return;
  await bridge.evalPython(`
import slicer
n = slicer.mrmlScene.GetNodeByID(${JSON.stringify(nodeID.value)})
sel = slicer.app.applicationLogic().GetSelectionNode()
sel.SetReferenceActivePlaceNodeClassName(n.GetClassName())
sel.SetActivePlaceNodeID(n.GetID())
i = slicer.app.applicationLogic().GetInteractionNode()
i.SetPlaceModePersistence(1)
i.SetCurrentInteractionMode(i.Place)
`);
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Markups">
      <SwNodeSelector node-types="vtkMRMLMarkupsNode" :current-node-id="nodeID" rename-enabled remove-enabled @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <div class="flex gap-1">
        <SwButton text="Place points" @clicked="placeMore" />
        <SwButton text="Clear points" @clicked="point(0, 'clear')" />
        <SwButton :text="state.locked ? 'Unlock' : 'Lock'" @clicked="set({ locked: !state!.locked })" />
      </div>
      <SwCollapsible v-if="state.measurements.length" text="Measurements">
        <div v-for="m in state.measurements" :key="m.name" class="flex justify-between text-[13px]">
          <span class="text-muted-foreground">{{ m.name }}</span><span class="font-medium text-highlight tabular-nums">{{ m.text }}</span>
        </div>
      </SwCollapsible>
      <SwCollapsible :text="`Control points (${state.controlPoints.length})`">
        <table class="w-full text-[12px]">
          <tbody>
            <tr v-for="p in state.controlPoints" :key="p.index" class="group hover:bg-accent/40">
              <td class="py-0.5"><input class="w-20 rounded bg-transparent px-1 outline-none focus:bg-background" :value="p.label"
                @change="point(p.index, 'label', ($event.target as HTMLInputElement).value)" /></td>
              <td class="text-right text-muted-foreground tabular-nums">{{ p.position.map((v) => v.toFixed(1)).join(", ") }}</td>
              <td class="w-16 text-right">
                <button type="button" class="px-0.5 text-muted-foreground hover:text-highlight" title="Jump slices" @click="point(p.index, 'jump')"><Crosshair :size="13" /></button>
                <button type="button" class="px-0.5 text-muted-foreground hover:text-highlight" :title="p.locked ? 'Unlock' : 'Lock'" @click="point(p.index, 'locked', !p.locked)">
                  <Lock v-if="p.locked" :size="13" /><Unlock v-else :size="13" />
                </button>
                <button type="button" class="px-0.5 text-muted-foreground hover:text-red-400" title="Delete" @click="point(p.index, 'delete')"><Trash2 :size="13" /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </SwCollapsible>
      <SwCollapsible text="Display" collapsed>
        <SwCheckBox text="Visible" :checked="state.visible" @toggled="set({ visible: $event })" />
        <SwFormRow label="Color"><SwColorPicker :color="state.color" @color-changed="set({ color: $event })" /></SwFormRow>
        <SwFormRow label="Glyph size"><SwSlider :value="state.glyphScale" :minimum="0.5" :maximum="15" :single-step="0.5" :decimals="1" @value-changed="set({ glyphScale: $event })" /></SwFormRow>
        <SwFormRow label="Text size"><SwSlider :value="state.textScale" :minimum="0" :maximum="15" :single-step="0.5" :decimals="1" @value-changed="set({ textScale: $event })" /></SwFormRow>
        <SwFormRow label="Fill opacity"><SwSlider :value="state.fillOpacity" :minimum="0" :maximum="1" :single-step="0.05" @value-changed="set({ fillOpacity: $event })" /></SwFormRow>
        <SwCollapsible v-if="state.handles" text="Interaction handles" collapsed data-name="interactionHandles">
          <div class="flex items-center gap-2">
            <SwCheckBox text="Visibility" :checked="state.handles.visible" data-name="handlesVisible"
              tool-tip="Show the handles for moving, rotating and scaling the markup in the views"
              @toggled="setHandles({ visible: $event })" />
            <span class="flex-1" />
            <SwButton text="More options..." checkable :checked="handleComponentsShown" data-name="handlesMoreOptions"
              tool-tip="Choose the axes of the handles" @toggled="handleComponentsShown = $event" />
          </div>
          <table class="w-full text-[12px]" data-name="handleKinds">
            <thead v-if="handleComponentsShown">
              <tr class="text-muted-foreground">
                <th /><th class="font-normal">Visibility</th>
                <th v-for="c in HANDLE_COMPONENTS" :key="c" class="font-normal">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in HANDLE_KINDS" :key="h.kind" :data-kind="h.kind"
                :class="h.kind === 'scale' && !state.handles.canScale ? 'opacity-40 pointer-events-none' : ''">
                <td class="py-0.5 pr-2">{{ h.label }}</td>
                <td class="text-center"><input type="checkbox" data-name="handleKindVisible" :checked="state.handles[h.kind].visible"
                  @change="setHandles({ [h.kind]: { visible: ($event.target as HTMLInputElement).checked } })" /></td>
                <template v-if="handleComponentsShown">
                  <td v-for="(c, i) in HANDLE_COMPONENTS" :key="c" class="text-center">
                    <input type="checkbox" :data-name="`handleComponent${i}`" :checked="state.handles[h.kind].components[i]"
                      @change="setHandleComponent(h.kind, i, ($event.target as HTMLInputElement).checked)" /></td>
                </template>
              </tr>
            </tbody>
          </table>
          <SwFormRow label="Size">
            <SwSlider :value="state.handles.size" :minimum="0" :maximum="20" :single-step="0.1" :decimals="1" suffix="%" data-name="handlesSize"
              @value-changed="setHandles({ size: $event })" />
          </SwFormRow>
          <SwFormRow label="Opacity">
            <SwSlider :value="state.handles.opacity" :minimum="0" :maximum="1" :single-step="0.01" :decimals="2" data-name="handlesOpacity"
              @value-changed="setHandles({ opacity: $event })" />
          </SwFormRow>
        </SwCollapsible>
      </SwCollapsible>
    </template>
    <div v-else class="py-6 text-center text-[12px] text-muted-foreground">Use the markups tools in the toolbar to place points, lines, angles, curves, planes or ROIs.</div>
  </div>
</template>

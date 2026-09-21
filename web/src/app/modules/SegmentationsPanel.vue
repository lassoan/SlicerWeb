<script setup lang="ts">
import { ref } from "vue";
import { Eye, EyeOff, Trash2 } from "@lucide/vue";
import { SwCheckBox, SwCollapsible, SwFormRow, SwNodeSelector, SwSlider, SwButton } from "@/widgets";
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

const nodeID = useSelectedNode("Segmentation");
const { state, bridge } = useNodeState<SegmentationInfo>("segmentationInfo", nodeID);
const setSeg = (id: string, props: Record<string, unknown>) => nodeID.value && bridge.call("setSegment", [nodeID.value, id, props]);
const setDisplay = (props: Record<string, unknown>) => nodeID.value && bridge.call("setSegmentationDisplay", [nodeID.value, props]);
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
      <div class="text-[11px] text-muted-foreground">Source representation: {{ state.sourceRepresentation }}</div>
    </template>
  </div>
</template>

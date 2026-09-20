<script setup lang="ts">
import { ref } from "vue";
import { SwCheckBox, SwCollapsible, SwColorPicker, SwComboBox, SwFormRow, SwNodeSelector, SwSlider } from "@/widgets";
import { store } from "../store";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface ModelInfo {
  name: string;
  points: number;
  cells: number;
  visible: boolean;
  visible2D: boolean;
  color: string;
  opacity: number;
  representation: number;
  edgeVisibility: boolean;
  backfaceCulling: boolean;
  sliceIntersectionThickness: number;
  scalarVisibility: boolean;
  activeScalarName: string | null;
  scalars: string[];
}

const nodeID = useSelectedNode("Model");
const { state, bridge } = useNodeState<ModelInfo>("modelInfo", nodeID);
const representations = ["Points", "Wireframe", "Surface"];

function set(props: Record<string, unknown>) {
  if (nodeID.value) bridge.call("setModelDisplay", [nodeID.value, props]);
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Model">
      <SwNodeSelector node-types="vtkMRMLModelNode" :current-node-id="nodeID" rename-enabled remove-enabled @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <div class="text-[12px] text-muted-foreground">{{ state.points.toLocaleString() }} points, {{ state.cells.toLocaleString() }} cells</div>
      <SwCollapsible text="3D display">
        <SwCheckBox text="Visible" :checked="state.visible" @toggled="set({ visible: $event })" />
        <SwFormRow label="Color"><SwColorPicker :color="state.color" @color-changed="set({ color: $event })" /></SwFormRow>
        <SwFormRow label="Opacity"><SwSlider :value="state.opacity" :minimum="0" :maximum="1" :single-step="0.01" @value-changed="set({ opacity: $event })" /></SwFormRow>
        <SwFormRow label="Representation">
          <SwComboBox :items="representations" :current-index="state.representation" @current-index-changed="set({ representation: $event })" />
        </SwFormRow>
        <SwCheckBox text="Show edges" :checked="state.edgeVisibility" @toggled="set({ edgeVisibility: $event })" />
        <SwCheckBox text="Backface culling" :checked="state.backfaceCulling" @toggled="set({ backfaceCulling: $event })" />
      </SwCollapsible>
      <SwCollapsible text="Slice display">
        <SwCheckBox text="Visible in slice views" :checked="state.visible2D" @toggled="set({ visible2D: $event })" />
        <SwFormRow label="Line width">
          <SwSlider :value="state.sliceIntersectionThickness" :minimum="1" :maximum="10" :decimals="0" @value-changed="set({ sliceIntersectionThickness: $event })" />
        </SwFormRow>
      </SwCollapsible>
      <SwCollapsible v-if="state.scalars.length" text="Scalars" collapsed>
        <SwCheckBox text="Show scalars" :checked="state.scalarVisibility" @toggled="set({ scalarVisibility: $event })" />
        <SwComboBox :items="state.scalars" :current-index="Math.max(0, state.scalars.indexOf(state.activeScalarName ?? ''))"
          @current-text-changed="set({ activeScalarName: $event })" />
      </SwCollapsible>
    </template>
    <div v-else class="py-6 text-center text-[12px] text-muted-foreground">Load a model (VTK, STL, OBJ, PLY) to edit its display.</div>
  </div>
</template>

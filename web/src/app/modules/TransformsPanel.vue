<script setup lang="ts">
import { ref } from "vue";
import { SwButton, SwCollapsible, SwFormRow, SwNodeSelector, SwSlider } from "@/widgets";
import { store } from "../store";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface TransformInfo {
  name: string;
  isLinear: boolean;
  matrix: number[][];
}

const nodeID = useSelectedNode("Transform");
const { state, bridge } = useNodeState<TransformInfo>("transformInfo", nodeID);
const targetID = ref<string | null>(null);

function setElement(r: number, c: number, v: number) {
  if (!state.value || !nodeID.value) return;
  const m = state.value.matrix.map((row) => [...row]);
  m[r][c] = v;
  bridge.call("setTransformMatrix", [nodeID.value, m]);
}

function identity() {
  if (nodeID.value) bridge.call("setTransformMatrix", [nodeID.value, [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]]);
}
const axes = ["LR", "PA", "IS"];
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Transform">
      <SwNodeSelector node-types="vtkMRMLTransformNode" :current-node-id="nodeID" add-enabled rename-enabled remove-enabled
        base-name="LinearTransform" @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <template v-if="state.isLinear">
        <SwCollapsible text="Translation">
          <SwFormRow v-for="(a, i) in axes" :key="a" :label="a">
            <SwSlider :value="state.matrix[i][3]" :minimum="-500" :maximum="500" :single-step="0.5" :decimals="1" suffix="mm"
              @value-changed="setElement(i, 3, $event)" />
          </SwFormRow>
        </SwCollapsible>
        <SwCollapsible text="Transform matrix">
          <div class="grid grid-cols-4 gap-1">
            <template v-for="(row, r) in state.matrix" :key="r">
              <input v-for="(v, c) in row" :key="c" type="number" step="0.01"
                class="w-full rounded border border-input bg-background px-1 py-0.5 text-right text-[12px] tabular-nums outline-none"
                :value="v.toFixed(4)" @change="setElement(r, c, Number(($event.target as HTMLInputElement).value))" />
            </template>
          </div>
          <SwButton text="Identity" @clicked="identity" />
        </SwCollapsible>
      </template>
      <div v-else class="text-[12px] text-muted-foreground">Non-linear transform (displayed with the transform visualization in the views).</div>
      <SwCollapsible text="Apply transform">
        <SwFormRow label="Node">
          <SwNodeSelector :node-types="['vtkMRMLTransformableNode']" none-enabled :current-node-id="targetID" @current-node-changed="targetID = $event" />
        </SwFormRow>
        <div class="flex gap-1">
          <SwButton text="Apply" @clicked="targetID && bridge.call('applyTransformToNode', [targetID, nodeID])" />
          <SwButton text="Remove" @clicked="targetID && bridge.call('applyTransformToNode', [targetID, null])" />
          <SwButton text="Harden" @clicked="targetID && bridge.call('applyTransformToNode', [targetID, nodeID, true])" />
        </div>
      </SwCollapsible>
    </template>
  </div>
</template>

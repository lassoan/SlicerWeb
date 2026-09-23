<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SwButton, SwCheckBox, SwCollapsible, SwFormRow, SwNodeSelector, SwSlider } from "@/widgets";
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

/**
 * The interaction handles of the transform (vtkMRMLTransformDisplayNode's editor), and the nodes
 * it is applied to. Both are the transform's own, so they follow the chosen transform.
 */
interface DisplayInfo { visible: boolean; handlesVisible: boolean; handlesIn3D: boolean; handlesInSlices: boolean; translation: boolean; rotation: boolean; scaling: boolean }
interface Transformable { id: string; name: string; className: string; transformed: boolean }
const display = ref<DisplayInfo | null>(null);
const transformables = ref<Transformable[]>([]);

async function refreshTransform() {
  if (!nodeID.value) {
    display.value = null;
    transformables.value = [];
    return;
  }
  [display.value, transformables.value] = await Promise.all([
    bridge.call<DisplayInfo | null>("transformDisplayInfo", [nodeID.value]).catch(() => null),
    bridge.call<Transformable[]>("transformableNodes", [nodeID.value]).catch(() => []),
  ]);
}

async function setDisplay(props: Record<string, boolean>) {
  if (!nodeID.value) return;
  await bridge.call("setTransformDisplay", [nodeID.value, props]);
  await refreshTransform();
}

async function transformNode(node: Transformable, apply: boolean) {
  await bridge.call("applyTransformToNode", [node.id, apply ? nodeID.value : null]);
  await refreshTransform();
}

const offs: (() => void)[] = [];
watch(nodeID, refreshTransform);
onMounted(() => {
  refreshTransform();
  offs.push(bridge.events.on("scene-changed", refreshTransform));
});
onBeforeUnmount(() => offs.forEach((off) => off()));
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
      <SwCollapsible v-if="display" text="Display">
        <SwCheckBox text="Show interaction handles" :checked="display.handlesVisible" data-name="handlesVisible"
          @toggled="setDisplay({ handlesVisible: $event })" />
        <div class="ml-5 flex flex-col gap-1" :class="{ 'pointer-events-none opacity-40': !display.handlesVisible }">
          <SwCheckBox text="In 3D views" :checked="display.handlesIn3D" @toggled="setDisplay({ handlesIn3D: $event })" />
          <SwCheckBox text="In slice views" :checked="display.handlesInSlices" @toggled="setDisplay({ handlesInSlices: $event })" />
          <SwCheckBox text="Translation" :checked="display.translation" @toggled="setDisplay({ translation: $event })" />
          <SwCheckBox text="Rotation" :checked="display.rotation" @toggled="setDisplay({ rotation: $event })" />
          <SwCheckBox text="Scaling" :checked="display.scaling" @toggled="setDisplay({ scaling: $event })" />
        </div>
        <SwCheckBox text="Show transform (glyphs, grid or contours)" :checked="display.visible" @toggled="setDisplay({ visible: $event })" />
      </SwCollapsible>
      <!-- The nodes this transform is applied to, and the ones it could be: one list, ticked where
           it applies, rather than the two lists and arrows of the desktop. -->
      <SwCollapsible text="Apply transform">
        <div v-if="!transformables.length" class="text-[12px] text-muted-foreground">Nothing in the scene can be transformed yet.</div>
        <div v-for="node in transformables" :key="node.id" class="flex items-center gap-2">
          <SwCheckBox :text="node.name" :checked="node.transformed" :data-name="'transform:' + node.id" @toggled="transformNode(node, $event)" />
          <span class="flex-1 truncate text-[11px] text-muted-foreground">{{ node.className.replace(/^vtkMRML|Node$/g, "") }}</span>
        </div>
        <div class="mt-1 flex gap-1">
          <SwButton text="Harden on transformed nodes" @clicked="transformables.filter((n) => n.transformed).forEach((n) => bridge.call('applyTransformToNode', [n.id, nodeID, true]))" />
        </div>
      </SwCollapsible>
    </template>
  </div>
</template>

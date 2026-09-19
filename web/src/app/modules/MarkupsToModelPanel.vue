<script setup lang="ts">
// Web GUI of the MarkupsToModel module (MarkupsToModel extension): same features as the desktop
// qSlicerMarkupsToModelModuleWidget, driven by the vtkMRMLMarkupsToModelNode parameter node.
import { computed, ref, watch } from "vue";
import { SwButton, SwCheckBox, SwCollapsible, SwColorPicker, SwComboBox, SwFormRow, SwNodeSelector, SwSlider, SwSpinBox } from "@/widgets";
import { store } from "../store";
import { useNodeState } from "./useNodeState";

interface MarkupsToModelInfo {
  modelType: number;
  curveType: number;
  pointParameterType: number;
  polynomialOrder: number;
  polynomialFitType: number;
  polynomialSampleWidth: number;
  polynomialWeightType: number;
  kochanekTension: number;
  kochanekBias: number;
  kochanekContinuity: number;
  kochanekEndsCopyNearestDerivatives: boolean;
  tubeRadius: number;
  tubeSegmentsBetweenControlPoints: number;
  tubeNumberOfSides: number;
  tubeLoop: boolean;
  tubeCapping: boolean;
  autoUpdateOutput: boolean;
  cleanMarkups: boolean;
  butterflySubdivision: boolean;
  delaunayAlpha: number;
  convexHull: boolean;
  inputNodeID: string | null;
  inputPoints: number;
  outputModelNodeID: string | null;
  outputPoints: number;
  curveLength: number;
  display: { visible: boolean; color: string; opacity: number; sliceIntersection: boolean } | null;
}

const nodeID = ref<string | null>(null);
const { state, bridge, refresh } = useNodeState<MarkupsToModelInfo>("markupsToModelInfo", nodeID);
const error = ref("");

// Select the first parameter node, or create one (desktop: the module creates a parameter node on enter)
(async () => {
  const nodes = await bridge.call<{ id: string }[]>("getNodes", ["vtkMRMLMarkupsToModelNode"]);
  if (nodes.length) nodeID.value = nodes[0].id;
  else nodeID.value = await bridge.evalPython(
    'slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsToModelNode", "MarkupsToModel").GetID()', "eval",
  ).then((id) => (id ? String(id).replace(/^'|'$/g, "") : null));
})();

// Input point list: observe it so that the point count follows placement
const inputID = computed(() => state.value?.inputNodeID ?? null);
const { state: inputState } = useNodeState<unknown>("getNode", inputID);
watch(inputState, () => refresh());

async function set(props: Record<string, unknown>) {
  if (!nodeID.value) return;
  error.value = "";
  try {
    await bridge.call("setMarkupsToModel", [nodeID.value, props]);
  } catch (e: any) {
    error.value = e.message ?? String(e);
  }
  refresh();
}

async function update() {
  if (!nodeID.value) return;
  error.value = "";
  try {
    await bridge.call("markupsToModelUpdate", [nodeID.value]);
  } catch (e: any) {
    error.value = e.message ?? String(e);
  }
  refresh();
}

const placing = computed(() => store.interactionMode === "Place:MarkupsToModel");
async function togglePlace(enable: boolean) {
  if (!nodeID.value) return;
  if (enable && !state.value?.inputNodeID) await bridge.call("markupsToModelCreateInput", [nodeID.value]);
  await bridge.call("markupsToModelPlace", [nodeID.value, enable]);
  store.interactionMode = enable ? "Place:MarkupsToModel" : "ViewTransform";
  refresh();
}

const modelTypes = ["Closed surface", "Curve"];
const curveTypes = ["Linear", "Cardinal spline", "Kochanek spline", "Polynomial"];
const pointOrders = ["Indices", "Minimum spanning tree"];
const fitTypes = ["Global least squares", "Moving least squares"];
const weightTypes = ["Rectangular", "Triangular", "Cosine", "Gaussian"];
const isCurve = computed(() => state.value?.modelType === 1);
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Parameter node">
      <SwNodeSelector node-types="vtkMRMLMarkupsToModelNode" :current-node-id="nodeID" add-enabled rename-enabled remove-enabled
        base-name="MarkupsToModel" @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <SwFormRow label="Input points">
        <SwNodeSelector :node-types="['vtkMRMLMarkupsFiducialNode', 'vtkMRMLMarkupsCurveNode', 'vtkMRMLMarkupsClosedCurveNode']"
          :current-node-id="state.inputNodeID" none-enabled add-enabled rename-enabled base-name="Points"
          @current-node-changed="set({ inputNodeID: $event })" />
      </SwFormRow>
      <div class="flex items-center gap-2">
        <SwButton checkable :checked="placing" :text="placing ? 'Stop placing' : 'Place points'" @toggled="togglePlace" />
        <span class="text-[12px] text-muted-foreground">{{ state.inputPoints }} point{{ state.inputPoints === 1 ? "" : "s" }}</span>
      </div>
      <SwFormRow label="Output model">
        <SwNodeSelector node-types="vtkMRMLModelNode" :current-node-id="state.outputModelNodeID" none-enabled add-enabled rename-enabled
          base-name="Model" none-display="Create on update" @current-node-changed="set({ outputModelNodeID: $event })" />
      </SwFormRow>
      <SwFormRow label="Mode">
        <SwComboBox :items="modelTypes" :current-index="state.modelType" @current-index-changed="set({ modelType: $event })" />
      </SwFormRow>

      <SwCollapsible v-if="!isCurve" text="Closed surface">
        <SwCheckBox text="Clean duplicate input points" :checked="state.cleanMarkups" @toggled="set({ cleanMarkups: $event })" />
        <SwCheckBox text="Butterfly subdivision" :checked="state.butterflySubdivision" @toggled="set({ butterflySubdivision: $event })" />
        <SwCheckBox text="Convex hull" :checked="state.convexHull" @toggled="set({ convexHull: $event })" />
        <SwFormRow label="Delaunay alpha">
          <SwSpinBox :value="state.delaunayAlpha" :minimum="0" :maximum="1000" :single-step="0.1" :decimals="2"
            :enabled="!state.convexHull" @value-changed="set({ delaunayAlpha: $event })" />
        </SwFormRow>
      </SwCollapsible>

      <template v-else>
        <SwCollapsible text="Curve">
          <SwFormRow label="Curve type">
            <SwComboBox :items="curveTypes" :current-index="state.curveType" @current-index-changed="set({ curveType: $event })" />
          </SwFormRow>
          <SwFormRow label="Point order">
            <SwComboBox :items="pointOrders" :current-index="state.pointParameterType" @current-index-changed="set({ pointParameterType: $event })" />
          </SwFormRow>
          <template v-if="state.curveType === 2">
            <SwFormRow label="Tension">
              <SwSlider :value="state.kochanekTension" :minimum="-1" :maximum="1" :single-step="0.01" :decimals="2" @value-changed="set({ kochanekTension: $event })" />
            </SwFormRow>
            <SwFormRow label="Bias">
              <SwSlider :value="state.kochanekBias" :minimum="-1" :maximum="1" :single-step="0.01" :decimals="2" @value-changed="set({ kochanekBias: $event })" />
            </SwFormRow>
            <SwFormRow label="Continuity">
              <SwSlider :value="state.kochanekContinuity" :minimum="-1" :maximum="1" :single-step="0.01" :decimals="2" @value-changed="set({ kochanekContinuity: $event })" />
            </SwFormRow>
            <SwCheckBox text="Ends copy nearest derivatives" :checked="state.kochanekEndsCopyNearestDerivatives"
              @toggled="set({ kochanekEndsCopyNearestDerivatives: $event })" />
          </template>
          <template v-if="state.curveType === 3">
            <SwFormRow label="Polynomial order">
              <SwSpinBox :value="state.polynomialOrder" :minimum="1" :maximum="20" @value-changed="set({ polynomialOrder: $event })" />
            </SwFormRow>
            <SwFormRow label="Fitting">
              <SwComboBox :items="fitTypes" :current-index="state.polynomialFitType" @current-index-changed="set({ polynomialFitType: $event })" />
            </SwFormRow>
            <template v-if="state.polynomialFitType === 1">
              <SwFormRow label="Sample width">
                <SwSlider :value="state.polynomialSampleWidth" :minimum="0" :maximum="1" :single-step="0.01" :decimals="2"
                  @value-changed="set({ polynomialSampleWidth: $event })" />
              </SwFormRow>
              <SwFormRow label="Weight function">
                <SwComboBox :items="weightTypes" :current-index="state.polynomialWeightType" @current-index-changed="set({ polynomialWeightType: $event })" />
              </SwFormRow>
            </template>
          </template>
        </SwCollapsible>
        <SwCollapsible text="Tube">
          <SwFormRow label="Radius">
            <SwSpinBox :value="state.tubeRadius" :minimum="0" :maximum="1000" :single-step="0.5" :decimals="2" suffix=" mm"
              @value-changed="set({ tubeRadius: $event })" />
          </SwFormRow>
          <SwFormRow label="Sides">
            <SwSpinBox :value="state.tubeNumberOfSides" :minimum="3" :maximum="100" @value-changed="set({ tubeNumberOfSides: $event })" />
          </SwFormRow>
          <SwFormRow label="Segments between points">
            <SwSpinBox :value="state.tubeSegmentsBetweenControlPoints" :minimum="1" :maximum="100"
              @value-changed="set({ tubeSegmentsBetweenControlPoints: $event })" />
          </SwFormRow>
          <SwCheckBox text="Loop (closed curve)" :checked="state.tubeLoop" @toggled="set({ tubeLoop: $event })" />
          <SwCheckBox text="Cap ends" :checked="state.tubeCapping" :enabled="!state.tubeLoop" @toggled="set({ tubeCapping: $event })" />
        </SwCollapsible>
        <div v-if="state.curveLength" class="text-[12px] text-muted-foreground">Curve length: {{ state.curveLength.toFixed(1) }} mm</div>
      </template>

      <SwCollapsible v-if="state.display" text="Display">
        <SwCheckBox text="Visible" :checked="state.display.visible" @toggled="set({ display: { visible: $event } })" />
        <SwCheckBox text="Show in slice views" :checked="state.display.sliceIntersection" @toggled="set({ display: { sliceIntersection: $event } })" />
        <SwFormRow label="Color"><SwColorPicker :color="state.display.color" @color-changed="set({ display: { color: $event } })" /></SwFormRow>
        <SwFormRow label="Opacity">
          <SwSlider :value="state.display.opacity" :minimum="0" :maximum="1" :single-step="0.01" :decimals="2" @value-changed="set({ display: { opacity: $event } })" />
        </SwFormRow>
      </SwCollapsible>

      <SwCheckBox text="Auto-update" :checked="state.autoUpdateOutput" @toggled="set({ autoUpdateOutput: $event })" />
      <SwButton primary text="Update" :enabled="!!state.inputNodeID && state.inputPoints > 0" @clicked="update" />
      <div v-if="state.outputPoints" class="text-[12px] text-muted-foreground">Output: {{ state.outputPoints.toLocaleString() }} points</div>
      <div v-if="error" class="rounded bg-red-900/40 px-2 py-1 text-[12px] text-red-200">{{ error }}</div>
    </template>
  </div>
</template>

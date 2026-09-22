<script setup lang="ts">
// The panel of a CLI module, built from the description the module ships, the way Slicer builds a
// CLI module's GUI from the same XML. One panel serves every CLI module.
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwButton, SwCheckBox, SwCollapsible, SwComboBox, SwFormRow, SwLineEdit, SwNodeSelector, SwProgressBar, SwSpinBox } from "@/widgets";

interface CliParameter {
  name: string;
  label: string;
  description: string;
  tag: string;
  channel: string | null;
  default: string | null;
  elements: string[];
  nodeType: string | null;
  minimum?: string | null;
  maximum?: string | null;
  step?: string | null;
}
interface CliGroup { label: string; description: string; advanced: boolean; parameters: CliParameter[] }
interface CliDescription {
  name: string; title: string; category: string; description: string; contributor: string;
  documentationUrl: string; groups: CliGroup[]; values: Record<string, string | null>;
  /** Whether it will run in a worker, away from the page, or here because there is no worker. */
  runsInWorker: boolean;
}

const props = defineProps<{ name: string }>();
const bridge = inject<SlicerBridge>("bridge")!;

const description = ref<CliDescription | null>(null);
const values = ref<Record<string, unknown>>({});
const busy = ref(false);
const error = ref("");
const result = ref("");
const progress = ref("");
const fraction = ref(0);
/** The output nodes of the run that is going on, to describe once it is done. */
let running: Record<string, string> = {};
let off: (() => void) | null = null;

const NUMBERS = ["integer", "float", "double"];
const VECTORS = ["integer-vector", "float-vector", "double-vector"];

async function load() {
  error.value = "";
  result.value = "";
  description.value = await bridge.call<CliDescription | null>("cliModuleDescription", [props.name]);
  values.value = { ...(description.value?.values ?? {}) };
}

watch(() => props.name, load, { immediate: true });

const outputs = computed(() => (description.value?.groups ?? [])
  .flatMap((g) => g.parameters).filter((p) => p.nodeType && p.channel === "output"));

function set(name: string, value: unknown) {
  values.value = { ...values.value, [name]: value };
}

function numberOf(parameter: CliParameter): number {
  const value = values.value[parameter.name];
  return Number(value ?? parameter.default ?? 0) || 0;
}

function decimalsOf(parameter: CliParameter): number {
  return parameter.tag === "integer" ? 0 : 2;
}

/** A CLI module's enumerations are lists of strings; the panel shows them as they are written. */
function indexOf(parameter: CliParameter): number {
  const current = String(values.value[parameter.name] ?? parameter.default ?? "");
  return Math.max(0, parameter.elements.indexOf(current));
}

/** Say what came out, and keep it selected so that it can be used again. */
async function describeOutputs(outputs: Record<string, string>, seconds: number) {
  values.value = { ...values.value, ...outputs };
  const summaries = await Promise.all(Object.values(outputs).map((id) => bridge.call<string>("cliOutputSummary", [id])));
  result.value = `${summaries.filter(Boolean).join("; ")} (${seconds} s)`;
}

async function apply() {
  if (!description.value) return;
  busy.value = true;
  error.value = "";
  result.value = "";
  progress.value = description.value.runsInWorker ? "Starting" : "";
  fraction.value = 0;
  try {
    const run = await bridge.call<{ outputs: Record<string, string>; seconds?: number; worker: boolean }>(
      "runCliModule", [description.value.name, values.value]);
    running = run.outputs;
    values.value = { ...values.value, ...run.outputs };
    if (!run.worker) {
      // No worker to be had: it ran in the page and is already done
      await describeOutputs(run.outputs, run.seconds ?? 0);
      busy.value = false;
    }
  } catch (e: any) {
    error.value = e?.message ?? String(e);
    busy.value = false;
  }
}

async function cancel() {
  await bridge.call("cancelCliModule", []);
}

/** How the run in the worker is going. */
async function onJobEvent(event: { state: string; name?: string; message?: string; fraction?: number; seconds?: number }) {
  if (!description.value || (event.name && event.name !== description.value.name)) return;
  if (!busy.value) return;  // something else's run, or one this panel has already heard about
  if (event.state === "running") {
    progress.value = event.message ?? "";
    fraction.value = event.fraction ?? fraction.value;
  } else if (event.state === "finished") {
    progress.value = "";
    busy.value = false;
    await describeOutputs(running, event.seconds ?? 0);
  } else if (event.state === "failed" || event.state === "cancelled") {
    progress.value = "";
    busy.value = false;
    error.value = event.state === "cancelled" ? "Stopped." : (event.message ?? "It did not finish.");
  }
}

onMounted(() => {
  // Loading Python and the wheels into the worker takes a few seconds; asking for it now means the
  // wait happens while the parameters are being chosen rather than after Apply is pressed.
  bridge.call("prepareCliWorker", []).catch(() => {});
  off = bridge.events.on("cli-module", onJobEvent);
});
onBeforeUnmount(() => off?.());
</script>

<template>
  <div v-if="description" class="flex flex-col gap-2" data-name="cliModulePanel">
    <SwCollapsible v-for="(group, index) in description.groups" :key="group.label" :text="group.label"
      :collapsed="group.advanced || index > 1">
      <div class="flex flex-col gap-2 px-2 pb-2">
        <SwFormRow v-for="parameter in group.parameters" :key="parameter.name"
          :label="parameter.label || parameter.name" :title="parameter.description">
          <SwNodeSelector v-if="parameter.nodeType" :node-types="parameter.nodeType"
            :current-node-id="(values[parameter.name] as string) ?? null"
            :none-enabled="parameter.channel === 'output'"
            :none-display="parameter.channel === 'output' ? '(create new)' : 'None'"
            :data-name="'cli:' + parameter.name"
            @current-node-changed="set(parameter.name, $event)" />
          <SwCheckBox v-else-if="parameter.tag === 'boolean'" text=""
            :checked="String(values[parameter.name]) === 'true'"
            :data-name="'cli:' + parameter.name"
            @toggled="set(parameter.name, $event ? 'true' : 'false')" />
          <SwComboBox v-else-if="parameter.elements.length" :items="parameter.elements" :current-index="indexOf(parameter)"
            :data-name="'cli:' + parameter.name"
            @current-index-changed="set(parameter.name, parameter.elements[$event])" />
          <SwSpinBox v-else-if="NUMBERS.includes(parameter.tag)" :value="numberOf(parameter)"
            :minimum="parameter.minimum !== undefined && parameter.minimum !== null ? Number(parameter.minimum) : -1e9"
            :maximum="parameter.maximum !== undefined && parameter.maximum !== null ? Number(parameter.maximum) : 1e9"
            :single-step="parameter.step ? Number(parameter.step) : (parameter.tag === 'integer' ? 1 : 0.1)"
            :decimals="decimalsOf(parameter)" :data-name="'cli:' + parameter.name"
            @value-changed="set(parameter.name, String($event))" />
          <SwLineEdit v-else :text="String(values[parameter.name] ?? '')"
            :placeholder-text="VECTORS.includes(parameter.tag) ? 'x, y, z' : ''"
            :data-name="'cli:' + parameter.name"
            @text-changed="set(parameter.name, $event)" />
        </SwFormRow>
      </div>
    </SwCollapsible>

    <!-- One button: it starts the work, and stops it while the work is going on -->
    <SwButton :text="busy ? 'Cancel' : 'Apply'" :primary="!busy" data-name="cliApply"
      @clicked="busy ? cancel() : apply()" />
    <template v-if="busy">
      <SwProgressBar :value="fraction * 100" data-name="cliProgressBar" />
      <p class="text-[12px] text-muted-foreground" data-name="cliProgress">
        {{ progress || "Running" }} {{ description.runsInWorker ? "in the background" : "" }}…
      </p>
    </template>
    <p v-if="result" class="rounded bg-card/70 p-2 text-[12px] text-muted-foreground" data-name="cliResult">{{ result }}</p>
    <p v-if="error" class="rounded bg-card/70 p-2 text-[12px] text-red-400" data-name="cliError">{{ error }}</p>
    <p v-if="!outputs.length" class="text-[12px] text-muted-foreground">
      This module has no output this panel can show.
    </p>
  </div>
  <p v-else class="text-[13px] text-muted-foreground">{{ name }} is not a CLI module of this application.</p>
</template>

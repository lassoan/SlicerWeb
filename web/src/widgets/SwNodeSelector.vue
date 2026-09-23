<script setup lang="ts">
// qMRMLNodeComboBox: lists MRML nodes of the given classes, keeps the list updated when nodes are
// added/removed/renamed, and can create, rename and delete nodes.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { bridge, type NodeSummary } from "@/core/bridge";

const props = withDefaults(
  defineProps<{
    nodeTypes?: string[] | string;
    currentNodeID?: string | null;
    /** Same as currentNodeID (templates write current-node-id, which maps to currentNodeId). */
    currentNodeId?: string | null;
    noneEnabled?: boolean;
    addEnabled?: boolean;
    removeEnabled?: boolean;
    renameEnabled?: boolean;
    showHidden?: boolean;
    /** Only list nodes with these attributes (qMRMLNodeComboBox::addAttribute). */
    nodeAttributes?: Record<string, string | null>;
    /** Nodes left out by their ID (qMRMLSortFilterProxyModel::hiddenNodeIDs). */
    hiddenNodeIDs?: string[];
    baseName?: string;
    noneDisplay?: string;
    enabled?: boolean;
  }>(),
  {
    nodeTypes: () => ["vtkMRMLNode"],
    currentNodeID: undefined,
    currentNodeId: undefined,
    noneEnabled: false,
    addEnabled: false,
    removeEnabled: false,
    renameEnabled: false,
    showHidden: false,
    nodeAttributes: undefined,
    baseName: "",
    noneDisplay: "None",
    enabled: true,
  },
);
const emit = defineEmits<{ currentNodeChanged: [string | null]; nodeAdded: [string] }>();

const nodes = ref<NodeSummary[]>([]);
const current = () => (props.currentNodeID !== undefined ? props.currentNodeID : props.currentNodeId) ?? null;
const selected = ref<string | null>(current());
watch(current, (v) => {
  selected.value = v;
  // a node created after the last list update (e.g. by module logic): update the list
  if (v && !nodes.value.some((n) => n.id === v)) refresh();
});

function types(): string[] {
  const t = props.nodeTypes;
  return Array.isArray(t) ? t : String(t).split(/[,;\s]+/).filter(Boolean);
}

let refreshing = 0;
async function refresh() {
  const token = ++refreshing;
  const all: NodeSummary[] = [];
  for (const t of types()) {
    all.push(...(await bridge().call<NodeSummary[]>("getNodes", [t, props.showHidden, props.nodeAttributes ?? null])));
  }
  if (token !== refreshing) return;   // a newer refresh is on its way with a newer list
  const seen = new Set<string>();
  const hidden = new Set(props.hiddenNodeIDs ?? []);
  nodes.value = all.filter((n) => !hidden.has(n.id) && (seen.has(n.id) ? false : (seen.add(n.id), true)));
  // The list is fetched asynchronously, so the module may have chosen a node in the meantime (it
  // does so while a scene is loaded or a test runs): that choice wins, and is never reported back
  // as a change of the selection, which would overwrite it with what this list happens to hold.
  const chosen = current();
  if (chosen) {
    selected.value = chosen;
    return;
  }
  if (!props.noneEnabled && !selected.value && nodes.value.length) select(nodes.value[0].id);
  if (selected.value && !nodes.value.some((n) => n.id === selected.value)) select(props.noneEnabled ? null : nodes.value[0]?.id ?? null);
}

function select(id: string | null) {
  selected.value = id;
  emit("currentNodeChanged", id);
}

async function onChange(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  if (value === "__create__") {
    const ref = await bridge().invoke<{ id: string }>("scene", "AddNewNodeByClass", [types()[0], props.baseName || ""]);
    await refresh();
    select(ref.id);
    emit("nodeAdded", ref.id);
  } else if (value === "__rename__" && selected.value) {
    const current = nodes.value.find((n) => n.id === selected.value);
    const name = window.prompt("New name", current?.name ?? "");
    if (name) await bridge().call("setNodeProperties", [selected.value, { Name: name }]);
    await refresh();
  } else if (value === "__delete__" && selected.value) {
    await bridge().call("removeNode", [selected.value]);
    await refresh();
  } else {
    select(value || null);
  }
  (e.target as HTMLSelectElement).value = selected.value ?? "";
}

let off: (() => void) | undefined;
onMounted(() => {
  refresh();
  off = bridge().events.on("scene-changed", refresh);
});
watch(() => props.nodeAttributes, refresh, { deep: true });
watch(() => props.hiddenNodeIDs, refresh, { deep: true });
onBeforeUnmount(() => off?.());
</script>

<template>
  <select class="sw-node-selector h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-40"
    :disabled="!enabled" :value="selected ?? ''" @change="onChange">
    <!-- selection is set on the options: a value bound on the select is lost when options arrive later -->
    <option v-if="noneEnabled" value="" :selected="!selected">{{ noneDisplay }}</option>
    <option v-for="n in nodes" :key="n.id" :value="n.id" :selected="n.id === selected">{{ n.name }}</option>
    <option v-if="addEnabled" value="__create__">Create new {{ baseName || types()[0].replace('vtkMRML', '').replace('Node', '') }}…</option>
    <option v-if="renameEnabled && selected" value="__rename__">Rename current node…</option>
    <option v-if="removeEnabled && selected" value="__delete__">Delete current node</option>
  </select>
</template>

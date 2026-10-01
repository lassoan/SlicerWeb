<script setup lang="ts">
// qMRMLNodeComboBox: lists MRML nodes of the given classes, keeps the list updated when nodes are
// added/removed/renamed, and can create, rename and delete nodes. Checkable (qMRMLCheckableNodeComboBox):
// each node is checked on and off in a drop-down list instead, and no node is current.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
    /** qMRMLCheckableNodeComboBox: the nodes are checked on and off rather than one chosen. */
    checkable?: boolean;
    /** The nodes checked (checkable). */
    checkedNodeIDs?: string[];
    /** Nodes the user may not check on or off (qMRMLCheckableNodeComboBox::setUserCheckable). */
    uncheckableNodeIDs?: string[];
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
    checkable: false,
    checkedNodeIDs: () => [],
    uncheckableNodeIDs: () => [],
  },
);
const emit = defineEmits<{ currentNodeChanged: [string | null]; nodeAdded: [string]; checkedNodesChanged: [string[]] }>();

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
  if (props.checkable) return;   // no node is current
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

// --- checkable
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const checked = computed(() => new Set(props.checkedNodeIDs ?? []));
/** What the closed list shows: the checked nodes, as ctkCheckableComboBox does. */
const summary = computed(() => {
  const names = nodes.value.filter((n) => checked.value.has(n.id)).map((n) => n.name);
  return names.length ? names.join(", ") : "None";
});
function toggle(id: string, on: boolean) {
  const ids = nodes.value.map((n) => n.id).filter((n) => (n === id ? on : checked.value.has(n)));
  emit("checkedNodesChanged", ids);
}
function closeOutside(e: Event) {
  if (open.value && root.value && !e.composedPath().includes(root.value)) open.value = false;
}
watch(open, (isOpen) => {
  if (isOpen) {
    refresh();
    document.addEventListener("pointerdown", closeOutside, true);
  } else {
    document.removeEventListener("pointerdown", closeOutside, true);
  }
});
onBeforeUnmount(() => document.removeEventListener("pointerdown", closeOutside, true));

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
  <div v-if="checkable" ref="root" class="sw-node-selector relative w-full min-w-0">
    <button type="button" :disabled="!enabled" :title="summary" :aria-expanded="open"
      class="flex h-7 w-full min-w-0 items-center rounded-md border border-input bg-background px-2 text-left text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-40"
      @click="open = !open" @keydown.escape="open = false">
      <span class="min-w-0 flex-1 truncate">{{ summary }}</span>
      <span class="ml-1 text-muted-foreground">▾</span>
    </button>
    <div v-if="open" role="listbox" aria-multiselectable="true"
      class="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-auto rounded-md border border-input bg-background py-1 shadow-lg"
      @keydown.escape="open = false">
      <label v-for="n in nodes" :key="n.id"
        class="flex cursor-pointer items-center gap-2 px-2 py-1 text-[13px] text-foreground hover:bg-accent"
        :class="{ 'cursor-default opacity-60': uncheckableNodeIDs.includes(n.id) }">
        <input type="checkbox" :checked="checked.has(n.id)" :disabled="uncheckableNodeIDs.includes(n.id)"
          @change="toggle(n.id, ($event.target as HTMLInputElement).checked)" />
        <span class="min-w-0 truncate">{{ n.name }}</span>
      </label>
      <div v-if="!nodes.length" class="px-2 py-1 text-[13px] text-muted-foreground">No nodes</div>
    </div>
  </div>
  <select v-else class="sw-node-selector h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-40"
    :disabled="!enabled" :value="selected ?? ''" @change="onChange">
    <!-- selection is set on the options: a value bound on the select is lost when options arrive later -->
    <option v-if="noneEnabled" value="" :selected="!selected">{{ noneDisplay }}</option>
    <option v-for="n in nodes" :key="n.id" :value="n.id" :selected="n.id === selected">{{ n.name }}</option>
    <option v-if="addEnabled" value="__create__">Create new {{ baseName || types()[0].replace('vtkMRML', '').replace('Node', '') }}…</option>
    <option v-if="renameEnabled && selected" value="__rename__">Rename current node…</option>
    <option v-if="removeEnabled && selected" value="__delete__">Delete current node</option>
  </select>
</template>

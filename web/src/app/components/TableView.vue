<script setup lang="ts">
// Table view of the layout (qMRMLTableView): the table chosen in the view is shown as a table, and
// its cells can be edited unless the table is locked.
import { inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SlicerBridge } from "@/core/bridge";

const props = defineProps<{ layoutName: string }>();
const bridge = inject<SlicerBridge>("bridge")!;

interface TableState {
  viewNodeID: string | null;
  tableNodeID: string | null;
  name: string | null;
  locked: boolean;
  maxRows: number;
  columns: string[];
  rows: string[][];
  rowCount: number;
}

const state = ref<TableState | null>(null);
const tables = ref<{ id: string; name: string }[]>([]);

async function refresh() {
  state.value = await bridge.call<TableState>("tableViewState", [props.layoutName]);
  tables.value = await bridge.call<{ id: string; name: string }[]>("getNodes", ["vtkMRMLTableNode", false]);
}

async function showTable(nodeID: string) {
  await bridge.call("setTableViewNode", [props.layoutName, nodeID || null]);
  await refresh();
}

async function edit(row: number, column: number, event: Event) {
  const value = (event.target as HTMLElement).innerText.trim();
  if (!state.value?.tableNodeID) return;
  await bridge.call("setTableCell", [state.value.tableNodeID, row, column, value]);
}

let off: (() => void) | undefined;
onMounted(() => {
  refresh();
  off = bridge.events.on("scene-changed", refresh);
});
onBeforeUnmount(() => off?.());
watch(() => props.layoutName, refresh);
</script>

<template>
  <div class="flex h-full flex-col bg-background" data-name="tableView">
    <div class="flex h-[26px] shrink-0 items-center gap-1.5 border-b border-input/40 bg-card px-1.5 text-[12px]">
      <span class="shrink-0 text-muted-foreground">Table</span>
      <select class="h-5 min-w-0 flex-1 rounded bg-input/60 px-1 text-[11px] text-foreground outline-none"
        :value="state?.tableNodeID ?? ''" @change="showTable(($event.target as HTMLSelectElement).value)">
        <option value="">None</option>
        <option v-for="t in tables" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>
      <span v-if="state?.rowCount" class="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {{ state.rowCount }} rows × {{ state.columns.length }}
      </span>
    </div>

    <div v-if="state?.columns.length" class="min-h-0 flex-1 overflow-auto">
      <table class="w-full border-collapse text-[12px]">
        <thead class="sticky top-0 bg-card">
          <tr>
            <th v-for="(c, i) in state.columns" :key="i" class="border-b border-input px-2 py-1 text-left font-semibold whitespace-nowrap">{{ c }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, r) in state.rows" :key="r" class="odd:bg-card/40">
            <td v-for="(cell, c) in row" :key="c" class="border-b border-input/40 px-2 py-0.5 whitespace-nowrap tabular-nums"
              :contenteditable="!state.locked" @blur="edit(r, c, $event)">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="state.rowCount > state.rows.length" class="p-2 text-[11px] text-muted-foreground">
        The first {{ state.rows.length }} of {{ state.rowCount }} rows are shown.
      </div>
    </div>
    <div v-else class="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
      {{ tables.length ? "Choose a table to show." : "No table in the scene." }}
    </div>
  </div>
</template>

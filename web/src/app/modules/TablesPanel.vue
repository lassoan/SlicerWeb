<script setup lang="ts">
// Tables module: the shape of a table and the rows and columns it is made of.
import { SwCheckBox, SwFormRow, SwNodeSelector } from "@/widgets";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";
import TableView from "../components/TableView.vue";

interface TableInfo { name: string; locked: boolean; columns: string[]; rowCount: number }

const nodeID = useSelectedNode("Table");
const { state, bridge } = useNodeState<TableInfo>("tableNodeInfo", nodeID);

function edit(action: string) {
  if (nodeID.value) bridge.call("editTable", [nodeID.value, action]);
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Table">
      <SwNodeSelector node-types="vtkMRMLTableNode" :current-node-id="nodeID" add-enabled rename-enabled remove-enabled
        base-name="Table" @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <div class="text-[12px] text-muted-foreground">{{ state.rowCount }} rows × {{ state.columns.length }} columns</div>
      <SwCheckBox text="Locked (read only)" :checked="state.locked" @toggled="bridge.call('setTableLocked', [nodeID, $event])" />
      <div class="flex flex-wrap gap-1">
        <button v-for="a in [['addRow', 'Add row'], ['removeRow', 'Remove row'], ['addColumn', 'Add column'], ['removeColumn', 'Remove column']]"
          :key="a[0]" type="button" class="rounded bg-secondary/60 px-2 py-1 text-[12px] hover:bg-secondary disabled:opacity-40"
          :disabled="state.locked" @click="edit(a[0])">{{ a[1] }}</button>
      </div>
      <div class="h-80 overflow-hidden rounded-md border border-input/60">
        <TableView layout-name="TableView1" />
      </div>
      <div class="text-[11px] text-muted-foreground">Switch to a table layout to see the table in a view.</div>
    </template>
  </div>
</template>

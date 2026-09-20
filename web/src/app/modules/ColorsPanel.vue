<script setup lang="ts">
// Colors module: the colour tables of the application and what is in them.
import { computed, ref } from "vue";
import { SwFormRow, SwNodeSelector } from "@/widgets";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface ColorEntry { index: number; name: string; color: string; opacity: number }
interface ColorInfo {
  name: string; type: string; category: string; count: number; shown: number;
  range: number[]; colors: ColorEntry[]; editable: boolean;
}

const nodeID = useSelectedNode("Color");
const { state, bridge } = useNodeState<ColorInfo>("colorNodeInfo", nodeID);
const filter = ref("");
const entries = computed(() => {
  const text = filter.value.trim().toLowerCase();
  return (state.value?.colors ?? []).filter((c) => !text || c.name.toLowerCase().includes(text) || String(c.index) === text);
});

function setColor(entry: ColorEntry, color: string) {
  if (nodeID.value) bridge.call("setColorNodeColor", [nodeID.value, entry.index, color, null]);
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Colour table">
      <!-- The colour tables of the application are hidden nodes, as in desktop Slicer -->
      <SwNodeSelector node-types="vtkMRMLColorNode" :current-node-id="nodeID" show-hidden
        @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <div class="text-[12px] text-muted-foreground">
        {{ state.type }}<span v-if="state.category"> · {{ state.category }}</span> · {{ state.count }} colours
        <span v-if="state.range[1] > state.range[0]"> · values {{ state.range[0] }} to {{ state.range[1] }}</span>
      </div>
      <input v-model="filter" placeholder="Search colours"
        class="h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus:border-primary" />
      <div class="max-h-96 overflow-y-auto rounded-md border border-input/60">
        <div v-for="c in entries" :key="c.index" class="flex items-center gap-2 border-b border-input/30 px-2 py-1 text-[12px] last:border-b-0">
          <span class="w-8 shrink-0 text-right tabular-nums text-muted-foreground">{{ c.index }}</span>
          <input v-if="state.editable" type="color" :value="c.color" class="h-5 w-8 shrink-0 cursor-pointer rounded border border-input bg-transparent"
            @change="setColor(c, ($event.target as HTMLInputElement).value)" />
          <span v-else class="h-4 w-8 shrink-0 rounded-sm border border-input/60" :style="{ background: c.color }" />
          <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
          <span class="shrink-0 tabular-nums text-muted-foreground">{{ c.color }}</span>
        </div>
        <div v-if="!entries.length" class="p-2 text-[12px] text-muted-foreground">No colour matches.</div>
      </div>
      <div v-if="state.count > state.shown" class="text-[11px] text-muted-foreground">
        The first {{ state.shown }} of {{ state.count }} colours are listed.
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// The segments of a segmentation, as the Segmentations module and the Segment Editor both list
// them: a click chooses one, a double-click on the name renames it, the colour opens the
// terminology selector (what the segment is), the eye shows or hides it, and the bin removes it.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Eye, EyeOff, Trash2 } from "@lucide/vue";
import TerminologySelector from "./TerminologySelector.vue";
import { useNodeState } from "../modules/useNodeState";

interface Segment { id: string; name: string; color: string; visible: boolean; opacity: number }
interface SegmentationInfo { segments: Segment[] }

const props = defineProps<{ segmentationNodeId: string | null; currentId?: string | null }>();
const emit = defineEmits<{ select: [string]; changed: [] }>();

const nodeID = computed(() => props.segmentationNodeId);
const { state, bridge, refresh } = useNodeState<SegmentationInfo>("segmentationInfo", nodeID);
const segments = computed(() => state.value?.segments ?? []);
const terminologyFor = ref<{ id: string; name: string } | null>(null);
const renaming = ref<string | null>(null);

async function set(id: string, props: Record<string, unknown>) {
  if (!nodeID.value) return;
  await bridge.call("setSegment", [nodeID.value, id, props]);
  refresh();
  emit("changed");
}

async function rename(id: string, name: string) {
  renaming.value = null;
  if (name.trim()) await set(id, { name: name.trim() });
}

async function remove(id: string) {
  if (!nodeID.value) return;
  await bridge.call("removeSegment", [nodeID.value, id]);
  refresh();
  emit("changed");
}

function startRenaming(id: string) {
  renaming.value = id;
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(`[data-name=segmentNameInput][data-segment="${id}"]`);
    input?.focus();
    input?.select();
  });
}

// What the terminology selector changed shows here and where the list is used
watch(terminologyFor, (v) => { if (!v) refresh(); });
// The Segment Editor adds, removes and chooses segments through its own logic: the list follows
const off = bridge.events.on("segment-editor-changed", () => refresh());
onBeforeUnmount(off);
</script>

<template>
  <div class="max-h-48 overflow-y-auto rounded-md border border-input/60" data-name="segmentList">
    <TerminologySelector v-if="terminologyFor && nodeID" :segmentation-node-id="nodeID" :segment-id="terminologyFor.id"
      :segment-name="terminologyFor.name" @close="terminologyFor = null" @applied="emit('changed')" />
    <div v-for="s in segments" :key="s.id" data-name="segmentRow" :data-segment="s.id"
      class="group flex h-7 cursor-pointer items-center gap-2 px-2 text-[13px] [@media(hover:none)]:h-9"
      :class="s.id === currentId ? 'bg-accent text-foreground' : 'hover:bg-accent/40'"
      @click="emit('select', s.id)" @dblclick.self="terminologyFor = { id: s.id, name: s.name }">
      <button type="button" class="h-3.5 w-3.5 shrink-0 rounded-sm border border-black/30" :style="{ background: s.color }"
        title="What is this segment? (terminology, name and colour)" data-name="segmentColor"
        @click.stop="terminologyFor = { id: s.id, name: s.name }" />
      <input v-if="renaming === s.id" data-name="segmentNameInput" :data-segment="s.id" :value="s.name"
        class="h-5 min-w-0 flex-1 rounded border border-input bg-background px-1 text-[13px] outline-none"
        @click.stop @keydown.enter.prevent="rename(s.id, ($event.target as HTMLInputElement).value)"
        @keydown.escape.prevent="renaming = null" @blur="rename(s.id, ($event.target as HTMLInputElement).value)" />
      <span v-else class="min-w-0 flex-1 truncate" data-name="segmentName" title="Double-click to rename"
        :class="s.visible ? '' : 'text-muted-foreground'" @dblclick.stop="startRenaming(s.id)">{{ s.name }}</span>
      <button type="button" class="shrink-0 text-muted-foreground hover:text-highlight" :title="s.visible ? 'Hide' : 'Show'" data-name="segmentVisible"
        @click.stop="set(s.id, { visible: !s.visible })">
        <Eye v-if="s.visible" :size="14" /><EyeOff v-else :size="14" />
      </button>
      <button type="button" class="hidden shrink-0 text-muted-foreground group-hover:inline hover:text-red-400 [@media(hover:none)]:inline" title="Remove"
        data-name="segmentRemove" @click.stop="remove(s.id)"><Trash2 :size="14" /></button>
    </div>
    <div v-if="!segments.length" class="p-2 text-[12px] text-muted-foreground"><slot name="empty">No segments yet.</slot></div>
  </div>
</template>

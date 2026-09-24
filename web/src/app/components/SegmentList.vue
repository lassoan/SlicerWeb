<script setup lang="ts">
// The segments of a segmentation, as the Segmentations module and the Segment Editor both list
// them: a click chooses one, a double-click on the name renames it, the colour opens the
// terminology selector (what the segment is), the status icon steps the segment's status, the
// eye shows or hides it, and what else can be done - the terminology, renaming, jumping the slices
// to it, the status, clearing, deleting - is behind a ... button (or a right-click, or a long
// press), as in the data tree.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Circle, CircleCheck, CircleDashed, Crosshair, Eraser, Eye, EyeOff, Flag, MoreHorizontal, Pencil, Tag, Trash2 } from "@lucide/vue";
import PopupMenu from "./PopupMenu.vue";
import TerminologySelector from "./TerminologySelector.vue";
import { useNodeState } from "../modules/useNodeState";

interface Segment { id: string; name: string; color: string; visible: boolean; opacity: number; status: number }

// The segment's status, as vtkSlicerSegmentationsModuleLogic keeps it on the segment: a click on
// the icon steps to the next (flagged goes back to completed), as on the desktop
const STATUS = [
  { name: "Not started", icon: Circle, class: "text-muted-foreground/60" },
  { name: "In progress", icon: CircleDashed, class: "text-amber-300" },
  { name: "Completed", icon: CircleCheck, class: "text-emerald-300" },
  { name: "Flagged", icon: Flag, class: "text-red-400" },
];
interface SegmentationInfo { segments: Segment[] }

const props = defineProps<{ segmentationNodeId: string | null; currentId?: string | null }>();
const emit = defineEmits<{ select: [string]; changed: [] }>();

const nodeID = computed(() => props.segmentationNodeId);
const { state, bridge, refresh } = useNodeState<SegmentationInfo>("segmentationInfo", nodeID);
const segments = computed(() => state.value?.segments ?? []);
const terminologyFor = ref<{ id: string; name: string } | null>(null);
const renaming = ref<string | null>(null);
const menus = ref(new Map<string, { show: () => void }>());

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

const call = async (method: string, id: string, ...args: unknown[]) => {
  if (!nodeID.value) return;
  await bridge.call(method, [nodeID.value, id, ...args]);
  refresh();
  emit("changed");
};
const setStatus = (id: string, status: number | null = null) => call("setSegmentStatus", id, status);
const clear = (id: string) => call("clearSegment", id);
const jumpSlices = (id: string) => bridge.call("jumpSlicesToSegment", [nodeID.value, id]);

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

// The row's menu on a right-click, and on a long press (a touch screen has no right button)
function openMenu(id: string) {
  emit("select", id);
  menus.value.get(id)?.show();
}
let hold: number | undefined;
function holdStart(id: string, event: PointerEvent) {
  if (event.pointerType !== "touch") return;
  window.clearTimeout(hold);
  hold = window.setTimeout(() => openMenu(id), 500);
}
function holdEnd() {
  window.clearTimeout(hold);
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
      class="flex h-7 cursor-pointer items-center gap-2 px-2 text-[13px] [@media(hover:none)]:h-9"
      :class="s.id === currentId ? 'bg-accent text-foreground' : 'hover:bg-accent/40'"
      @click="emit('select', s.id)" @dblclick.self="terminologyFor = { id: s.id, name: s.name }"
      @contextmenu.prevent="openMenu(s.id)" @pointerdown="holdStart(s.id, $event)"
      @pointerup="holdEnd" @pointercancel="holdEnd" @pointermove="holdEnd">
      <button type="button" class="h-3.5 w-3.5 shrink-0 rounded-sm border border-black/30" :style="{ background: s.color }"
        title="What is this segment? (terminology, name and colour)" data-name="segmentColor"
        @click.stop="terminologyFor = { id: s.id, name: s.name }" />
      <input v-if="renaming === s.id" data-name="segmentNameInput" :data-segment="s.id" :value="s.name"
        class="h-5 min-w-0 flex-1 rounded border border-input bg-background px-1 text-[13px] outline-none"
        @click.stop @keydown.enter.prevent="rename(s.id, ($event.target as HTMLInputElement).value)"
        @keydown.escape.prevent="renaming = null" @blur="rename(s.id, ($event.target as HTMLInputElement).value)" />
      <span v-else class="min-w-0 flex-1 truncate" data-name="segmentName" title="Double-click to rename"
        :class="s.visible ? '' : 'text-muted-foreground'" @dblclick.stop="startRenaming(s.id)">{{ s.name }}</span>
      <PopupMenu :ref="(el: any) => menus.set(s.id, el)" align="right">
        <template #trigger="{ open, toggle }">
          <button type="button" class="sw-row-action text-muted-foreground hover:text-highlight" :class="open ? 'text-highlight' : ''"
            :title="`More for ${s.name}`" data-name="segmentMore" @click.stop="toggle()"><MoreHorizontal :size="14" /></button>
        </template>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          data-name="segmentTerminology" @click="terminologyFor = { id: s.id, name: s.name }"><Tag :size="14" />What is it…</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          data-name="segmentRename" @click="startRenaming(s.id)"><Pencil :size="14" />Rename</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          data-name="segmentJump" @click="jumpSlices(s.id)"><Crosshair :size="14" />Jump slices</button>
        <div class="my-1 border-t border-input" />
        <button v-for="(st, i) in STATUS" :key="st.name" type="button" role="menuitem"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          :class="s.status === i ? 'text-highlight' : ''" :data-name="`segmentStatus${i}`" @click="setStatus(s.id, i)">
          <component :is="st.icon" :size="14" :class="st.class" />{{ st.name }}</button>
        <div class="my-1 border-t border-input" />
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
          data-name="segmentClear" @click="clear(s.id)"><Eraser :size="14" />Clear</button>
        <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-red-300 hover:bg-accent/60"
          data-name="segmentRemove" @click="remove(s.id)"><Trash2 :size="14" />Delete</button>
      </PopupMenu>
      <button type="button" class="sw-row-action shrink-0 hover:text-highlight" :class="STATUS[s.status]?.class"
        :title="`${STATUS[s.status]?.name ?? 'Status'} (click for the next)`" data-name="segmentStatus" :data-status="s.status"
        @click.stop="setStatus(s.id)"><component :is="STATUS[s.status]?.icon ?? Circle" :size="14" /></button>
      <button type="button" class="sw-row-action shrink-0 text-muted-foreground hover:text-highlight" :title="s.visible ? 'Hide' : 'Show'" data-name="segmentVisible"
        @click.stop="set(s.id, { visible: !s.visible })">
        <Eye v-if="s.visible" :size="14" /><EyeOff v-else :size="14" class="opacity-60" />
      </button>
    </div>
    <div v-if="!segments.length" class="p-2 text-[12px] text-muted-foreground"><slot name="empty">No segments yet.</slot></div>
  </div>
</template>

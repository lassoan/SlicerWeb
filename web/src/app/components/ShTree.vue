<script setup lang="ts">
// Subject hierarchy tree (qMRMLSubjectHierarchyTreeView subset).
import { inject, ref } from "vue";
import { ChevronDown, ChevronRight, Eye, EyeOff, Box, Layers, Image, MapPin, Shapes, Move3d, Table, Folder, User, FileText, Download, MoreHorizontal, Pencil, Trash2 } from "@lucide/vue";
import PopupMenu from "./PopupMenu.vue";
import type { SlicerBridge, SubjectHierarchyItem } from "@/core/bridge";
import type { SlicerRuntime } from "@/core/runtime";
import { store } from "../store";
import { openNodeModule } from "../nodeModules";

defineProps<{ items: SubjectHierarchyItem[]; depth: number }>();
const bridge = inject<SlicerBridge>("bridge")!;
const runtime = inject<SlicerRuntime>("runtime")!;
const collapsed = ref(new Set<number>());

function icon(item: SubjectHierarchyItem) {
  const c = item.className;
  if (c.includes("Segmentation")) return Shapes;
  if (c.includes("Volume")) return Image;
  if (c.includes("Model")) return Box;
  if (c.includes("Markups")) return MapPin;
  if (c.includes("Transform")) return Move3d;
  if (c.includes("Table")) return Table;
  if (c.includes("Text")) return FileText;
  if (c === "Patient") return User;
  if (c === "Study" || c === "Folder") return Folder;
  return Layers;
}

function toggle(item: SubjectHierarchyItem) {
  const s = new Set(collapsed.value);
  s.has(item.id) ? s.delete(item.id) : s.add(item.id);
  collapsed.value = s;
}

/** A volume is shown or hidden in the selected view only (see bridge.setSubjectHierarchyItemVisibility). */
const inSelectedView = (item: SubjectHierarchyItem) => !!store.activeView && item.className.includes("VolumeNode");

async function setVisible(item: SubjectHierarchyItem) {
  item.visible = !item.visible;
  if (item.segmentID && item.segmentationNodeID) {
    await bridge.call("setSegment", [item.segmentationNodeID, item.segmentID, { visible: item.visible }]);
    return;
  }
  await bridge.call("setSubjectHierarchyItemVisibility", [item.id, item.visible, store.activeView || null]);
}

function visibilityTitle(item: SubjectHierarchyItem) {
  const action = item.visible ? "Hide" : "Show";
  return inSelectedView(item) ? `${action} in view ${store.activeView}` : action;
}

// Clicking a node opens the module that node belongs to, and selects it there (see nodeModules.ts)
function select(item: SubjectHierarchyItem) {
  if (item.segmentID && item.segmentationNodeID) {
    if (store.activeModule === "SegmentEditor") {
      // Painting goes on with the segment picked: the Segment Editor on screen takes it
      store.selectedNodeClass = "vtkMRMLSegmentationNode";
      store.selectedNodeID = item.segmentationNodeID;
      store.selectedSegmentID = item.segmentID;
      return;
    }
    // As the segments plugin of desktop Slicer opens a segment: the module of its segmentation,
    // told which segment (slicer.app.openNodeModule(segmentation, "SegmentID", segmentID))
    void bridge.call("openNodeModule", [item.segmentationNodeID, "SegmentID", item.segmentID]);
    return;
  }
  if (!item.nodeID) return;
  openNodeModule(item.nodeID, item.className);
}

/** What the tree shows as selected: the segment picked, or the node picked. */
function isSelected(item: SubjectHierarchyItem) {
  if (item.segmentID) return store.selectedSegmentID === item.segmentID && store.selectedNodeID === item.segmentationNodeID;
  return !!store.selectedNodeID && store.selectedNodeID === item.nodeID && !store.selectedSegmentID;
}

async function rename(item: SubjectHierarchyItem) {
  if (!item.nodeID) return;
  const name = window.prompt("Rename", item.name);
  if (name) await bridge.call("setNodeProperties", [item.nodeID, { Name: name }]);
}

async function remove(item: SubjectHierarchyItem) {
  if (item.nodeID && confirm(`Delete ${item.name}?`)) await bridge.call("removeNode", [item.nodeID]);
}

async function save(item: SubjectHierarchyItem) {
  if (!item.nodeID) return;
  const ext = item.className.includes("Segmentation") ? ".seg.nrrd" : item.className.includes("Volume") ? ".nrrd"
    : item.className.includes("Model") ? ".vtk" : item.className.includes("Markups") ? ".mrk.json"
    : item.className.includes("Transform") ? ".tfm" : item.className.includes("Table") ? ".tsv" : ".txt";
  const path = `/data/save/${item.name.replace(/[^\w.-]+/g, "_")}${ext}`;
  await bridge.evalPython(`import os; os.makedirs("/data/save", exist_ok=True)`);
  if (await bridge.call<boolean>("saveNode", [item.nodeID, path])) runtime.saveFileToDisk(path);
}

/**
 * The menu of a row, which is opened three ways: by the button at its end, by a right click, and
 * by a press held on it - a mouse has the first two out of habit, a finger the first and the last.
 *
 * The menus are kept by item so that a row can open its own; the menu appears under the button
 * either way, which is where a menu belonging to that row is looked for.
 */
const menus = ref(new Map<number, { show: () => void } | null>());
let pressTimer: number | undefined;
let pressed = false;

function openMenu(item: SubjectHierarchyItem) {
  menus.value.get(item.id)?.show();
}

function holdStart(item: SubjectHierarchyItem, event: PointerEvent) {
  if (event.pointerType === "mouse") return;   // a mouse has the right button for this
  pressed = false;
  window.clearTimeout(pressTimer);
  pressTimer = window.setTimeout(() => {
    pressed = true;
    openMenu(item);
  }, 500);
}

function holdEnd() {
  window.clearTimeout(pressTimer);
}

/** A press that opened the menu must not also count as a click on the row. */
function clicked(item: SubjectHierarchyItem) {
  if (pressed) {
    pressed = false;
    return;
  }
  select(item);
}
</script>

<template>
  <ul class="text-[13px]">
    <li v-for="item in items" :key="item.id">
      <div class="sw-row group flex h-7 items-center gap-1 rounded pr-1 hover:bg-accent/60 [@media(hover:none)]:h-9"
        :class="{ 'bg-accent': isSelected(item) }" data-name="shItem" :data-segment="item.segmentID" :data-selected="isSelected(item)"
        :style="{ paddingLeft: depth * 14 + 4 + 'px' }" @click="clicked(item)" @dblclick="rename(item)"
        @contextmenu.prevent="openMenu(item)" @pointerdown="holdStart(item, $event)"
        @pointerup="holdEnd" @pointercancel="holdEnd" @pointermove="holdEnd">
        <button v-if="item.children.length" type="button" class="text-muted-foreground" @click.stop="toggle(item)">
          <ChevronRight v-if="collapsed.has(item.id)" :size="14" /><ChevronDown v-else :size="14" />
        </button>
        <span v-else class="w-[14px]" />
        <span v-if="item.segmentID" class="mx-[2px] h-2.5 w-2.5 shrink-0 rounded-sm border border-black/30" :style="{ background: item.color ?? '#888' }" />
        <component :is="icon(item)" v-else :size="14" class="shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate" :title="item.name">{{ item.name }}</span>
        <!-- What else can be done with this node, behind one button rather than beside the name:
             a row holding every action is a cluttered row, and the two that matter most - deleting
             among them - are better a deliberate tap away. -->
        <PopupMenu v-if="item.nodeID" :ref="(el: any) => menus.set(item.id, el)" align="right">
          <template #trigger="{ open, toggle }">
            <button type="button" class="sw-row-action text-muted-foreground hover:text-highlight"
              :class="open ? 'text-highlight' : ''" :title="`More for ${item.name}`"
              @click.stop="toggle()"><MoreHorizontal :size="14" /></button>
          </template>
          <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
            @click="save(item)"><Download :size="14" />Save to file</button>
          <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60"
            @click="rename(item)"><Pencil :size="14" />Rename</button>
          <button type="button" role="menuitem" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-red-300 hover:bg-accent/60"
            @click="remove(item)"><Trash2 :size="14" />Delete</button>
        </PopupMenu>
        <button type="button" class="text-muted-foreground hover:text-highlight" :title="visibilityTitle(item)" @click.stop="setVisible(item)">
          <Eye v-if="item.visible" :size="14" /><EyeOff v-else :size="14" class="opacity-60" />
        </button>
      </div>
      <ShTree v-if="item.children.length && !collapsed.has(item.id)" :items="item.children" :depth="depth + 1" />
    </li>
  </ul>
</template>

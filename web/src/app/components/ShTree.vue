<script setup lang="ts">
// Subject hierarchy tree (qMRMLSubjectHierarchyTreeView subset).
import { inject, ref } from "vue";
import { ChevronDown, ChevronRight, Eye, EyeOff, Box, Layers, Image, MapPin, Shapes, Move3d, Table, Folder, User, FileText, Download, X } from "@lucide/vue";
import type { SlicerBridge, SubjectHierarchyItem } from "@/core/bridge";
import type { SlicerRuntime } from "@/core/runtime";
import { openModule, store } from "../store";

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

async function setVisible(item: SubjectHierarchyItem) {
  item.visible = !item.visible;
  await bridge.call("setSubjectHierarchyItemVisibility", [item.id, item.visible]);
}

function select(item: SubjectHierarchyItem) {
  if (!item.nodeID) return;
  const c = item.className;
  const module = c.includes("Segmentation") ? "Segmentations" : c.includes("Volume") ? "Volumes" : c.includes("Model") ? "Models"
    : c.includes("Markups") ? "Markups" : c.includes("Transform") ? "Transforms" : store.activeModule;
  openModule(module);
  store.selectedNodeClass = item.className;
  store.selectedNodeID = item.nodeID;
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
</script>

<template>
  <ul class="text-[13px]">
    <li v-for="item in items" :key="item.id">
      <div class="group flex h-7 items-center gap-1 rounded pr-1 hover:bg-accent/60"
        :class="{ 'bg-accent': store.selectedNodeID && store.selectedNodeID === item.nodeID }"
        :style="{ paddingLeft: depth * 14 + 4 + 'px' }" @click="select(item)" @dblclick="rename(item)">
        <button v-if="item.children.length" type="button" class="text-muted-foreground" @click.stop="toggle(item)">
          <ChevronRight v-if="collapsed.has(item.id)" :size="14" /><ChevronDown v-else :size="14" />
        </button>
        <span v-else class="w-[14px]" />
        <component :is="icon(item)" :size="14" class="shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate" :title="item.name">{{ item.name }}</span>
        <button v-if="item.nodeID" type="button" class="hidden text-muted-foreground group-hover:inline hover:text-highlight" title="Save to file" @click.stop="save(item)"><Download :size="14" /></button>
        <button v-if="item.nodeID" type="button" class="hidden text-muted-foreground group-hover:inline hover:text-red-400" title="Delete" @click.stop="remove(item)"><X :size="14" /></button>
        <button type="button" class="text-muted-foreground hover:text-highlight" :title="item.visible ? 'Hide' : 'Show'" @click.stop="setVisible(item)">
          <Eye v-if="item.visible" :size="14" /><EyeOff v-else :size="14" class="opacity-60" />
        </button>
      </div>
      <ShTree v-if="item.children.length && !collapsed.has(item.id)" :items="item.children" :depth="depth + 1" />
    </li>
  </ul>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { LayoutTreeNode } from "../store";
import Viewport from "./Viewport.vue";

// Renders a Slicer layout description (converted from the layout XML by slicerweb.layout).
const props = defineProps<{ node: LayoutTreeNode }>();

const activeTab = ref(0);
const children = computed(() => props.node.children ?? []);

/** A pane's share of the row or column: its split size; equal shares where none is given. A size
 * of 0 is a collapsed pane, as in the desktop application's splitter, which a layout uses for a
 * view rendered off-screen (the fluoroscopy views of Virtual Cath Lab): the view is made, but
 * takes no room. */
function flexOf(child: LayoutTreeNode) {
  if (child.size === 0) return "0 0 0";
  return child.size && child.size > 0 ? `${child.size} 1 0` : "1 1 0";
}

/** What makes a child the same child after the layout changes.
 *
 * A view is known by its name, so that the view of that name keeps its canvas - and, more to the
 * point, so that a cell holding one view is never reused for another: the view in the page would
 * go on drawing into a canvas that now belongs to a different view (a slice in a 3D view's place).
 * A container has no name and is known by where it sits; the views inside it carry their own.
 */
function keyOf(child: LayoutTreeNode, index: number) {
  return child.type === "view" ? `view:${child.layoutName}` : `${child.type}:${index}`;
}

const gridStyle = computed(() => {
  if (props.node.type !== "grid") return {};
  const rows = Math.max(1, ...children.value.map((c) => (c.row ?? 0) + (c.rowSpan ?? 1)));
  const cols = Math.max(1, ...children.value.map((c) => (c.column ?? 0) + (c.columnSpan ?? 1)));
  return { display: "grid", gridTemplateRows: `repeat(${rows}, 1fr)`, gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "2px" };
});
</script>

<template>
  <Viewport v-if="node.type === 'view'" :view="node" />
  <div v-else-if="node.type === 'horizontal' || node.type === 'vertical'" class="flex min-h-0 min-w-0 gap-[2px]"
    :class="node.type === 'horizontal' ? 'flex-row' : 'flex-col'">
    <LayoutNode v-for="(child, i) in children" :key="keyOf(child, i)" :node="child" class="min-h-0 min-w-0"
      :class="{ 'overflow-hidden': child.size === 0 }" :style="{ flex: flexOf(child) }" />
  </div>
  <div v-else-if="node.type === 'grid'" :style="gridStyle">
    <LayoutNode v-for="(child, i) in children" :key="keyOf(child, i)" :node="child" class="min-h-0 min-w-0"
      :style="{ gridRow: `${(child.row ?? 0) + 1} / span ${child.rowSpan ?? 1}`, gridColumn: `${(child.column ?? 0) + 1} / span ${child.columnSpan ?? 1}` }" />
  </div>
  <div v-else-if="node.type === 'tab'" class="flex min-h-0 flex-col">
    <div class="flex h-7 shrink-0 gap-[2px]">
      <button v-for="(child, i) in children" :key="i" type="button" class="px-3 text-[12px]"
        :class="activeTab === i ? 'bg-accent text-foreground' : 'bg-muted text-muted-foreground'" @click="activeTab = i">
        {{ child.label ?? child.layoutName ?? `Tab ${i + 1}` }}
      </button>
    </div>
    <LayoutNode v-if="children[activeTab]" :key="keyOf(children[activeTab], activeTab)" :node="children[activeTab]"
      class="min-h-0 flex-1" />
  </div>
  <div v-else class="flex items-center justify-center text-muted-foreground">No views in this layout</div>
</template>

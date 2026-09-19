<script setup lang="ts">
import type { LayoutTreeNode } from "../store";
import LayoutNode from "./LayoutNode.vue";

defineProps<{ node: LayoutTreeNode }>();
</script>

<template>
  <div class="flex h-full w-full p-[2px]">
    <LayoutNode :node="node" class="h-full w-full" />
  </div>
</template>

<script setup lang="ts">
// Texts module: the text of a text node, which can be edited here.
import { ref, watch } from "vue";
import { SwFormRow, SwNodeSelector, SwTextEdit } from "@/widgets";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface TextInfo { name: string; text: string; encoding: number }

const nodeID = useSelectedNode("Text");
const { state, bridge } = useNodeState<TextInfo>("textNodeInfo", nodeID);
const text = ref("");
watch(state, (value) => (text.value = value?.text ?? ""));

function save() {
  if (nodeID.value) bridge.call("setTextNodeText", [nodeID.value, text.value]);
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Text node">
      <SwNodeSelector node-types="vtkMRMLTextNode" :current-node-id="nodeID" add-enabled rename-enabled remove-enabled
        base-name="Text" @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <SwTextEdit :plain-text="text" class="min-h-48" @text-changed="text = $event" />
      <div class="flex items-center gap-2">
        <button type="button" class="rounded bg-primary px-3 py-1 text-[13px] text-primary-foreground hover:bg-primary/85"
          @click="save">Save text</button>
        <span class="text-[12px] text-muted-foreground">{{ text.length }} characters</span>
      </div>
    </template>
  </div>
</template>

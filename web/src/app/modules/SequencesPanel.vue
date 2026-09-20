<script setup lang="ts">
// Sequences module: play a sequence browser and step through its items.
import { computed } from "vue";
import { Pause, Play, SkipBack, SkipForward } from "@lucide/vue";
import { SwCheckBox, SwFormRow, SwNodeSelector, SwSlider } from "@/widgets";
import { useNodeState } from "./useNodeState";
import { useSelectedNode } from "./useSelectedNode";

interface SequenceInfo {
  name: string;
  masterSequenceID: string | null;
  itemCount: number;
  selectedItem: number;
  indexName: string;
  indexValue: string;
  playing: boolean;
  playbackRate: number;
  loop: boolean;
  sequences: { id: string; name: string; items: number; proxyName: string | null }[];
}

const nodeID = useSelectedNode("SequenceBrowser");
const { state, bridge } = useNodeState<SequenceInfo>("sequenceBrowserInfo", nodeID);
const set = (properties: Record<string, unknown>) =>
  nodeID.value && bridge.call("setSequenceBrowser", [nodeID.value, properties]);
const position = computed(() => (state.value?.itemCount ? `${state.value.selectedItem + 1} / ${state.value.itemCount}` : "—"));
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Sequence browser">
      <SwNodeSelector node-types="vtkMRMLSequenceBrowserNode" :current-node-id="nodeID" rename-enabled remove-enabled
        @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <div class="flex items-center gap-1">
        <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight" title="Previous item"
          @click="set({ step: -1 })"><SkipBack :size="16" /></button>
        <button type="button" class="rounded p-1" :class="state.playing ? 'text-highlight' : 'text-muted-foreground hover:text-highlight'"
          :title="state.playing ? 'Pause' : 'Play'" data-name="playButton" @click="set({ playing: !state.playing })">
          <Pause v-if="state.playing" :size="18" /><Play v-else :size="18" />
        </button>
        <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight" title="Next item"
          @click="set({ step: 1 })"><SkipForward :size="16" /></button>
        <span class="ml-1 text-[12px] tabular-nums text-muted-foreground" data-name="position">{{ position }}</span>
        <span v-if="state.indexName" class="ml-auto text-[12px] text-muted-foreground">{{ state.indexName }}: {{ state.indexValue }}</span>
      </div>
      <input type="range" class="h-1 w-full cursor-pointer accent-highlight" :min="0" :max="Math.max(0, state.itemCount - 1)" :step="1"
        :value="state.selectedItem" @input="set({ selectedItem: Number(($event.target as HTMLInputElement).value) })" />
      <SwFormRow label="Frames per second">
        <SwSlider :value="state.playbackRate" :minimum="0.5" :maximum="60" :single-step="0.5" :decimals="1"
          @value-changed="set({ playbackRate: $event })" />
      </SwFormRow>
      <SwCheckBox text="Repeat" :checked="state.loop" @toggled="set({ loop: $event })" />
      <div class="rounded-md border border-input/60">
        <div v-for="s in state.sequences" :key="s.id"
          class="flex items-center gap-2 border-b border-input/30 px-2 py-1 text-[12px] last:border-b-0">
          <span class="min-w-0 flex-1 truncate">{{ s.name }}</span>
          <span class="shrink-0 truncate text-muted-foreground">{{ s.proxyName ?? "" }}</span>
          <span class="shrink-0 tabular-nums text-muted-foreground">{{ s.items }}</span>
        </div>
        <div v-if="!state.sequences.length" class="p-2 text-[12px] text-muted-foreground">This browser plays no sequence.</div>
      </div>
    </template>
  </div>
</template>

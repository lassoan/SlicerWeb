<script setup lang="ts">
// Sequences module: play a sequence browser, step through its items, and record into it.
// The controls are those of desktop Slicer's browser toolbar (qMRMLSequenceBrowserPlayWidget):
// jump to the start, back a frame, play or pause, on a frame, jump to the end, the frame rate,
// whether it repeats, recording, and a single snapshot.
import { computed } from "vue";
import { Camera, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Circle, Pause, Play, Repeat } from "@lucide/vue";
import { SwFormRow, SwNodeSelector, SwSlider } from "@/widgets";
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
  recording: boolean;
  recordMasterOnly: boolean;
  canRecord: boolean;
  sequences: { id: string; name: string; items: number; proxyName: string | null; playback: boolean; recording: boolean }[];
}

const nodeID = useSelectedNode("SequenceBrowser");
const { state, bridge } = useNodeState<SequenceInfo>("sequenceBrowserInfo", nodeID);
const set = (properties: Record<string, unknown>) =>
  nodeID.value && bridge.call("setSequenceBrowser", [nodeID.value, properties]);
const position = computed(() => (state.value?.itemCount ? `${state.value.selectedItem + 1} / ${state.value.itemCount}` : "—"));
const atStart = computed(() => !state.value?.itemCount || state.value.selectedItem <= 0);
const atEnd = computed(() => !state.value?.itemCount || state.value.selectedItem >= state.value.itemCount - 1);
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Sequence browser">
      <SwNodeSelector node-types="vtkMRMLSequenceBrowserNode" :current-node-id="nodeID" rename-enabled remove-enabled
        @current-node-changed="nodeID = $event" />
    </SwFormRow>
    <template v-if="state">
      <div class="flex flex-wrap items-center gap-0.5" data-name="playControls">
        <button type="button" class="rounded p-1" :class="atStart && !state.loop ? 'text-muted-foreground/40' : 'text-muted-foreground hover:text-highlight'"
          title="Jump to the first frame" data-name="firstItem" @click="set({ selectFirst: true })">
          <ChevronFirst :size="17" />
        </button>
        <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight" title="Previous frame"
          data-name="previousItem" @click="set({ step: -1 })"><ChevronLeft :size="17" /></button>
        <button type="button" class="rounded p-1" :class="state.playing ? 'text-highlight' : 'text-muted-foreground hover:text-highlight'"
          :title="state.playing ? 'Pause' : 'Play'" data-name="playButton" @click="set({ playing: !state.playing })">
          <Pause v-if="state.playing" :size="18" /><Play v-else :size="18" />
        </button>
        <button type="button" class="rounded p-1 text-muted-foreground hover:text-highlight" title="Next frame"
          data-name="nextItem" @click="set({ step: 1 })"><ChevronRight :size="17" /></button>
        <button type="button" class="rounded p-1" :class="atEnd && !state.loop ? 'text-muted-foreground/40' : 'text-muted-foreground hover:text-highlight'"
          title="Jump to the last frame" data-name="lastItem" @click="set({ selectLast: true })">
          <ChevronLast :size="17" />
        </button>

        <div class="mx-1 h-5 w-px bg-input" />
        <button type="button" class="rounded p-1" :class="state.loop ? 'text-highlight' : 'text-muted-foreground hover:text-highlight'"
          :title="state.loop ? 'Playing on repeat' : 'Play once and stop at the last frame'"
          :aria-pressed="state.loop" data-name="loopButton" @click="set({ loop: !state.loop })">
          <Repeat :size="16" />
        </button>
        <button type="button" class="rounded p-1"
          :class="state.recording ? 'text-red-400' : state.canRecord ? 'text-muted-foreground hover:text-highlight' : 'text-muted-foreground/40'"
          :disabled="!state.canRecord || state.playing"
          :title="state.canRecord ? (state.recording ? 'Stop recording' : 'Record what the proxy nodes do into the sequence')
            : 'No sequence is set to record into (tick one in the list below)'"
          :aria-pressed="state.recording" data-name="recordButton" @click="set({ recording: !state.recording })">
          <Circle :size="14" :fill="state.recording ? 'currentColor' : 'none'" />
        </button>
        <button type="button" class="rounded p-1"
          :class="state.canRecord && !state.recording && !state.playing ? 'text-muted-foreground hover:text-highlight' : 'text-muted-foreground/40'"
          :disabled="!state.canRecord || state.recording || state.playing"
          :title="state.canRecord ? 'Add one frame from where the proxy nodes stand now'
            : 'No sequence is set to record into (tick one in the list below)'"
          data-name="snapshotButton" @click="set({ snapshot: true })"><Camera :size="16" /></button>

        <span class="ml-1 text-[12px] tabular-nums text-muted-foreground" data-name="position">{{ position }}</span>
        <span v-if="state.indexName" class="ml-auto text-[12px] text-muted-foreground" data-name="indexValue">
          {{ state.indexName }}: {{ state.indexValue }}
        </span>
      </div>
      <input type="range" class="h-1 w-full cursor-pointer accent-highlight" :min="0" :max="Math.max(0, state.itemCount - 1)" :step="1"
        :value="state.selectedItem" data-name="itemSlider"
        @input="set({ selectedItem: Number(($event.target as HTMLInputElement).value) })" />
      <SwFormRow label="Frames per second">
        <SwSlider :value="state.playbackRate" :minimum="0.5" :maximum="60" :single-step="0.5" :decimals="1"
          @value-changed="set({ playbackRate: $event })" />
      </SwFormRow>
      <div class="rounded-md border border-input/60">
        <div class="flex items-center gap-2 border-b border-input/30 px-2 py-1 text-[11px] text-muted-foreground uppercase">
          <span class="min-w-0 flex-1">Sequence</span>
          <span class="shrink-0" title="Follow the browser">Play</span>
          <span class="shrink-0" title="Write what the proxy node does back into the sequence">Rec</span>
          <span class="w-8 shrink-0 text-right">Items</span>
        </div>
        <div v-for="s in state.sequences" :key="s.id" :data-name="'sequence:' + s.name"
          class="flex items-center gap-2 border-b border-input/30 px-2 py-1 text-[12px] last:border-b-0">
          <span class="min-w-0 flex-1 truncate" :title="s.proxyName ? s.name + ' → ' + s.proxyName : s.name">
            {{ s.name }}<span v-if="s.proxyName" class="text-muted-foreground"> → {{ s.proxyName }}</span>
          </span>
          <input type="checkbox" class="shrink-0 accent-highlight" :checked="s.playback" data-name="playbackEnabled"
            title="Follow the browser" @change="set({ sequencePlayback: { id: s.id, enabled: ($event.target as HTMLInputElement).checked } })" />
          <input type="checkbox" class="shrink-0 accent-highlight" :checked="s.recording" data-name="recordingEnabled"
            title="Record into this sequence" @change="set({ sequenceRecording: { id: s.id, enabled: ($event.target as HTMLInputElement).checked } })" />
          <span class="w-8 shrink-0 text-right tabular-nums text-muted-foreground">{{ s.items }}</span>
        </div>
        <div v-if="!state.sequences.length" class="p-2 text-[12px] text-muted-foreground">This browser plays no sequence.</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// Application log, like the error log of desktop Slicer: what the application, its modules and VTK
// have reported, with the levels to show chosen, a search, and a way to clear it.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Trash2, X } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { store } from "../store";

interface LogEntry { time: number; level: string; origin: string; message: string }

const LEVELS = [
  { name: "ERROR", label: "Errors", match: ["ERROR", "CRITICAL", "FATAL"], color: "text-red-400" },
  { name: "WARNING", label: "Warnings", match: ["WARNING", "WARN"], color: "text-amber-300" },
  { name: "INFO", label: "Info", match: ["INFO"], color: "text-foreground/85" },
  { name: "DEBUG", label: "Debug", match: ["DEBUG", "NOTSET", "TRACE"], color: "text-muted-foreground" },
];

const bridge = inject<SlicerBridge>("bridge")!;
const entries = ref<LogEntry[]>([]);
const shown = ref<Record<string, boolean>>({ ERROR: true, WARNING: true, INFO: true, DEBUG: false });
const search = ref("");
const follow = ref(true);
const list = ref<HTMLElement>();

const levelOf = (entry: LogEntry) =>
  LEVELS.find((l) => l.match.includes((entry.level ?? "").toUpperCase())) ?? LEVELS[2];

const visible = computed(() => {
  const text = search.value.trim().toLowerCase();
  return entries.value.filter((e) => {
    if (!shown.value[levelOf(e).name]) return false;
    return !text || e.message.toLowerCase().includes(text) || (e.origin ?? "").toLowerCase().includes(text);
  });
});

const counts = computed(() => {
  const result: Record<string, number> = { ERROR: 0, WARNING: 0, INFO: 0, DEBUG: 0 };
  for (const e of entries.value) result[levelOf(e).name]++;
  return result;
});

function time(entry: LogEntry) {
  return new Date(entry.time * 1000).toLocaleTimeString(undefined, { hour12: false });
}

async function scrollToEnd() {
  if (!follow.value) return;
  await nextTick();
  if (list.value) list.value.scrollTop = list.value.scrollHeight;
}

/** Debug messages are only logged while they are shown: they are many, and each one is sent here. */
async function toggleLevel(name: string) {
  shown.value[name] = !shown.value[name];
  if (name === "DEBUG") await bridge.call("setLogLevel", [shown.value.DEBUG ? "DEBUG" : "INFO"]);
}

async function clear() {
  await bridge.call("clearErrorLog");
  entries.value = [];
}

function onScroll() {
  const el = list.value;
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}

let off: (() => void) | undefined;
onMounted(async () => {
  entries.value = await bridge.call<LogEntry[]>("errorLogEntries", [1000]);
  off = bridge.events.on("log", (entry: LogEntry) => {
    entries.value.push(entry);
    if (entries.value.length > 5000) entries.value.splice(0, entries.value.length - 5000);
    scrollToEnd();
  });
  scrollToEnd();
});
onBeforeUnmount(() => off?.());
watch(visible, scrollToEnd);
</script>

<template>
  <section class="flex h-64 shrink-0 flex-col border-t border-input bg-background" data-name="logWindow" aria-label="Application log">
    <div class="flex h-8 shrink-0 flex-wrap items-center gap-1 border-b border-input/60 px-2">
      <span class="mr-1 text-[12px] font-semibold">Log</span>
      <button v-for="l in LEVELS" :key="l.name" type="button" :data-name="'level:' + l.name" :aria-pressed="shown[l.name]"
        class="rounded px-1.5 py-0.5 text-[11px]"
        :class="shown[l.name] ? 'bg-accent ' + l.color : 'text-muted-foreground hover:bg-accent/40'"
        @click="toggleLevel(l.name)">
        {{ l.label }}<span class="ml-1 tabular-nums opacity-70">{{ counts[l.name] }}</span>
      </button>
      <input v-model="search" placeholder="Search"
        class="ml-1 h-6 min-w-24 flex-1 rounded border border-input bg-background px-2 text-[12px] outline-none focus:border-primary" />
      <button type="button" title="Clear the log" data-name="clearLog"
        class="rounded p-1 text-muted-foreground hover:text-highlight" @click="clear"><Trash2 :size="14" /></button>
      <button type="button" title="Close" class="rounded p-1 text-muted-foreground hover:text-highlight"
        @click="store.logWindowOpen = false"><X :size="14" /></button>
    </div>
    <div ref="list" class="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-[12px] leading-5" @scroll="onScroll">
      <div v-for="(e, i) in visible" :key="i" class="flex gap-2 whitespace-pre-wrap" :data-level="levelOf(e).name">
        <span class="shrink-0 text-muted-foreground tabular-nums">{{ time(e) }}</span>
        <span class="w-16 shrink-0" :class="levelOf(e).color">{{ e.level }}</span>
        <span class="w-14 shrink-0 truncate text-muted-foreground">{{ e.origin }}</span>
        <span :class="levelOf(e).color">{{ e.message }}</span>
      </div>
      <div v-if="!visible.length" class="py-2 text-muted-foreground">
        {{ entries.length ? "No message matches the filter." : "Nothing has been logged yet." }}
      </div>
    </div>
  </section>
</template>

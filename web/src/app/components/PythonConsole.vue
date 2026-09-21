<script setup lang="ts">
// Python interactor (like Slicer's Python console): the full Slicer Python API is available.
import { inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { X } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { store } from "../store";

const bridge = inject<SlicerBridge>("bridge")!;
const lines = ref<{ kind: "in" | "out" | "err" | "log"; text: string }[]>([
  { kind: "log", text: "Python " + "3.14 (Pyodide) — slicer, vtk, numpy are available. Example: slicer.util.getNodes()" },
]);
const input = ref("");
const history: string[] = [];
let historyIndex = 0;
const output = ref<HTMLDivElement>();
const inputEl = ref<HTMLTextAreaElement>();
const height = ref(260);

function append(kind: "in" | "out" | "err" | "log", text: string) {
  lines.value.push({ kind, text });
  if (lines.value.length > 2000) lines.value.splice(0, 500);
  nextTick(() => output.value && (output.value.scrollTop = output.value.scrollHeight));
}

const offs = [
  bridge.events.on<string>("stdout", (s) => append("out", s)),
  bridge.events.on<string>("stderr", (s) => append("err", s)),
];
onBeforeUnmount(() => offs.forEach((off) => off()));

async function run() {
  const code = input.value;
  if (!code.trim()) return;
  history.push(code);
  historyIndex = history.length;
  input.value = "";
  closeSuggestions();
  window.clearTimeout(completionTimer);
  append("in", ">>> " + code.replace(/\n/g, "\n... "));
  try {
    const isExpression = !code.includes("\n") && !/^\s*(import|from|def|class|for|while|if|with|try|[\w.\[\]'"]+\s*=[^=])/.test(code);
    if (isExpression) {
      const result = await bridge.evalPython(code, "eval").catch(async (e) => {
        if (String(e).includes("SyntaxError")) return bridge.evalPython(code, "exec");
        throw e;
      });
      if (result !== null && result !== "None") append("out", String(result));
    } else {
      await bridge.evalPython(code, "exec");
    }
  } catch (e: any) {
    append("err", e.message ?? String(e));
  }
}

// ---- Auto-completion: suggestions appear after a pause in typing (phones have no Tab key), or
// immediately with Tab. Tap/click a suggestion, or use arrow keys and Enter/Tab to insert it.
interface Completion { text: string; callable: boolean }
const COMPLETION_DELAY_MS = 1000;
const suggestions = ref<Completion[]>([]);
const activeSuggestion = ref(0);
let completionStart = 0;
let completionCursor = 0;
let completionTimer: number | undefined;
let completionRequest = 0;

const suggestionList = ref<HTMLElement>();
watch(activeSuggestion, async () => {
  await nextTick();
  suggestionList.value?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest" });
});

function closeSuggestions() {
  suggestions.value = [];
  activeSuggestion.value = 0;
}

async function requestCompletions(applySingle = false) {
  window.clearTimeout(completionTimer);
  const el = inputEl.value;
  if (!el) return;
  const cursor = el.selectionStart ?? input.value.length;
  const text = input.value;
  if (!/[A-Za-z_][\w.]*$/.test(text.slice(0, cursor))) {
    closeSuggestions();
    return;
  }
  const request = ++completionRequest;
  const result = await bridge
    .call<{ start: number; items: Completion[] }>("completePython", [text, cursor])
    .catch(() => ({ start: cursor, items: [] as Completion[] }));
  // ignore stale results (the text changed while completions were computed)
  if (request !== completionRequest || input.value !== text) return;
  const word = text.slice(result.start, cursor);
  const items = result.items.filter((i) => i.text !== word || i.callable);
  completionStart = result.start;
  completionCursor = cursor;
  if (applySingle && items.length === 1) {
    applyCompletion(items[0]);
    return;
  }
  suggestions.value = items;
  activeSuggestion.value = 0;
}

function applyCompletion(item: Completion) {
  const before = input.value.slice(0, completionStart);
  const after = input.value.slice(completionCursor);
  const inserted = item.text + (item.callable ? "(" : "");
  input.value = before + inserted + after;
  closeSuggestions();
  const position = before.length + inserted.length;
  nextTick(() => {
    const el = inputEl.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(position, position);
  });
}

function onInput() {
  closeSuggestions();
  completionRequest++;
  window.clearTimeout(completionTimer);
  if (input.value.trim()) completionTimer = window.setTimeout(() => requestCompletions(), COMPLETION_DELAY_MS);
}

/** Last part of a dotted name (the list shows "getNode" for "slicer.util.getNode"). */
function shortName(text: string) {
  return text.slice(text.lastIndexOf(".") + 1);
}

onBeforeUnmount(() => window.clearTimeout(completionTimer));

function onKey(e: KeyboardEvent) {
  if (suggestions.value.length) {
    const n = suggestions.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeSuggestion.value = (activeSuggestion.value + 1) % n;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeSuggestion.value = (activeSuggestion.value - 1 + n) % n;
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      applyCompletion(suggestions.value[activeSuggestion.value]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSuggestions();
      return;
    }
  }
  if (e.key === "Tab") {
    e.preventDefault();
    requestCompletions(true);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    run();
  } else if (e.key === "ArrowUp" && !input.value.includes("\n")) {
    historyIndex = Math.max(0, historyIndex - 1);
    input.value = history[historyIndex] ?? input.value;
  } else if (e.key === "ArrowDown" && !input.value.includes("\n")) {
    historyIndex = Math.min(history.length, historyIndex + 1);
    input.value = history[historyIndex] ?? "";
  }
}

function startResize(e: PointerEvent) {
  const startY = e.clientY;
  const startH = height.value;
  const move = (ev: PointerEvent) => (height.value = Math.max(120, Math.min(window.innerHeight * 0.8, startH + startY - ev.clientY)));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
</script>

<template>
  <div class="flex shrink-0 flex-col border-t border-input bg-bkg-low/95 backdrop-blur" :style="{ height: height + 'px' }">
    <div class="h-1 cursor-row-resize hover:bg-primary/50" @pointerdown.prevent="startResize" />
    <div class="flex h-6 items-center justify-between px-2 text-[12px] text-muted-foreground">
      <span>Python console</span>
      <button type="button" class="hover:text-highlight" @click="store.pythonConsoleOpen = false"><X :size="14" /></button>
    </div>
    <div ref="output" class="min-h-0 flex-1 overflow-y-auto px-3 font-mono text-[12px] leading-5 whitespace-pre-wrap select-text">
      <div v-for="(l, i) in lines" :key="i"
        :class="{ 'text-highlight': l.kind === 'in', 'text-red-400': l.kind === 'err', 'text-muted-foreground': l.kind === 'log' }">{{ l.text }}</div>
    </div>
    <!-- Completions: a list above the prompt, as a console on the web usually has, so that long
         names can be read (a row of them along the prompt leaves no room for any of it). -->
    <div v-if="suggestions.length" class="relative h-0">
      <ul ref="suggestionList"
        class="absolute right-2 bottom-1 left-2 z-30 max-h-56 overflow-y-auto rounded-md border border-input bg-popover py-1 shadow-xl"
        role="listbox" aria-label="Completions">
        <li v-for="(s, i) in suggestions" :key="s.text">
          <button type="button" role="option" :aria-selected="i === activeSuggestion" :data-active="i === activeSuggestion"
            class="flex w-full items-baseline gap-3 px-2 py-1 text-left font-mono text-[12px]"
            :class="i === activeSuggestion ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'"
            @pointerdown.prevent @click="applyCompletion(s)">
            <span class="shrink-0 text-foreground/90">{{ shortName(s.text) }}<span v-if="s.callable" class="opacity-60">()</span></span>
            <span class="ml-auto truncate text-[11px] opacity-70">{{ s.text }}</span>
          </button>
        </li>
      </ul>
    </div>
    <textarea ref="inputEl" v-model="input" rows="1" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"
      placeholder=">>> (Shift+Enter for a new line, Tab to complete)"
      class="m-2 resize-none rounded border border-input bg-background px-2 py-1 font-mono text-[12px] outline-none focus:border-primary"
      @keydown="onKey" @input="onInput" @blur="closeSuggestions" />
  </div>
</template>

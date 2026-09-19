<script setup lang="ts">
// Python interactor (like Slicer's Python console): the full Slicer Python API is available.
import { inject, nextTick, onBeforeUnmount, ref } from "vue";
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

function onKey(e: KeyboardEvent) {
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
  <div class="absolute right-0 bottom-0 left-0 z-10 flex flex-col border-t border-input bg-bkg-low/95 backdrop-blur" :style="{ height: height + 'px' }">
    <div class="h-1 cursor-row-resize hover:bg-primary/50" @pointerdown.prevent="startResize" />
    <div class="flex h-6 items-center justify-between px-2 text-[12px] text-muted-foreground">
      <span>Python console</span>
      <button type="button" class="hover:text-highlight" @click="store.pythonConsoleOpen = false"><X :size="14" /></button>
    </div>
    <div ref="output" class="min-h-0 flex-1 overflow-y-auto px-3 font-mono text-[12px] leading-5 whitespace-pre-wrap select-text">
      <div v-for="(l, i) in lines" :key="i"
        :class="{ 'text-highlight': l.kind === 'in', 'text-red-400': l.kind === 'err', 'text-muted-foreground': l.kind === 'log' }">{{ l.text }}</div>
    </div>
    <textarea v-model="input" rows="1" spellcheck="false" placeholder=">>> (Shift+Enter for a new line)"
      class="m-2 resize-none rounded border border-input bg-background px-2 py-1 font-mono text-[12px] outline-none focus:border-primary"
      @keydown="onKey" />
  </div>
</template>

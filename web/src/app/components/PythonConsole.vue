<script setup lang="ts">
// Python interactor (like Slicer's Python console): the full Slicer Python API is available.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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

// Shown (from the menu or with Ctrl+3): ready to type at the prompt. After the frame, so that a menu
// closing on the same click does not take the focus back.
onMounted(() => requestAnimationFrame(() => inputEl.value?.focus()));

async function run() {
  const code = input.value;
  if (!code.trim()) return;
  history.push(code);
  historyIndex = history.length;
  input.value = "";
  closeSuggestions();
  hideCallTip();
  window.clearTimeout(completionTimer);
  append("in", ">>> " + code.replace(/\n/g, "\n... "));
  try {
    const isExpression = !code.includes("\n") && !/^\s*(import|from|def|class|for|while|if|with|try|[\w.\[\]'"]+\s*=[^=])/.test(code);
    if (isExpression) {
      // code typed here may run long: it is let process events (see bridge.callYielding)
      const result = await bridge.callYielding<string | null>("evalPython", [code, "eval"]).catch(async (e) => {
        if (String(e).includes("SyntaxError")) return bridge.callYielding<string | null>("evalPython", [code, "exec"]);
        throw e;
      });
      if (result !== null && result !== "None") append("out", String(result));
    } else {
      await bridge.callYielding("evalPython", [code, "exec"]);
    }
  } catch (e: any) {
    append("err", e.message ?? String(e));
  }
}

// ---- Auto-completion: suggestions appear after a pause in typing (phones have no Tab key), or
// immediately with Tab. Tap/click a suggestion, or use arrow keys and Enter/Tab to insert it.
// summary: the first descriptive line of the docstring; doc: the docstring (both absent for values)
interface Completion { text: string; callable: boolean; takesArguments?: boolean; summary?: string; doc?: string }
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

/** How many suggestions the list shows at a time (at least one). */
function suggestionsPerPage() {
  const list = suggestionList.value;
  const item = list?.querySelector<HTMLElement>("li");
  if (!list || !item || !item.offsetHeight) return 1;
  return Math.max(1, Math.floor(list.clientHeight / item.offsetHeight) - 1);
}

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
  // the part of the name being completed, to show where each suggestion matches it
  completionPrefix.value = word.slice(word.lastIndexOf(".") + 1);
  if (applySingle && items.length === 1) {
    applyCompletion(items[0]);
    return;
  }
  suggestions.value = items;
  activeSuggestion.value = 0;
}

/** Put the completion in place of the word being typed. A function gets both parentheses, and the
 *  cursor goes between them if it takes arguments, after them if it does not (as a call is typed
 *  next); parentheses already there are not doubled. */
function applyCompletion(item: Completion) {
  const before = input.value.slice(0, completionStart);
  const after = input.value.slice(completionCursor);
  const hasParenthesis = after.startsWith("(");
  const parentheses = item.callable && !hasParenthesis ? "()" : "";
  input.value = before + item.text + parentheses + after;
  closeSuggestions();
  let position = before.length + item.text.length;
  if (item.callable) {
    // inside: right after "("; else after the ")" (of the ones added, or of those already there)
    const takesArguments = item.takesArguments ?? true;
    if (takesArguments) position += 1;
    else if (parentheses) position += 2;
    else {
      const close = input.value.indexOf(")", position);
      position = close >= 0 ? close + 1 : position + 1;
    }
  }
  nextTick(() => {
    const el = inputEl.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(position, position);
    updateCallTip();
  });
}

function onInput() {
  closeSuggestions();
  updateCallTip();
  completionRequest++;
  window.clearTimeout(completionTimer);
  if (input.value.trim()) completionTimer = window.setTimeout(() => requestCompletions(), COMPLETION_DELAY_MS);
}

/** Last part of a dotted name (the list shows "getNode" for "slicer.util.getNode"). */
function shortName(text: string) {
  return text.slice(text.lastIndexOf(".") + 1);
}

/** The name of a suggestion in three parts: before the typed text, the typed text as it matched
 *  (at the start if it matches there, else where it first matches, in any case), and after it. */
const completionPrefix = ref("");
function matchParts(name: string): [string, string, string] {
  const typed = completionPrefix.value;
  if (!typed) return [name, "", ""];
  let at = name.startsWith(typed) || name.toLowerCase().startsWith(typed.toLowerCase()) ? 0 : name.toLowerCase().indexOf(typed.toLowerCase());
  if (at < 0) return [name, "", ""];
  return [name.slice(0, at), name.slice(at, at + typed.length), name.slice(at + typed.length)];
}

/** A docstring in blocks to show: the signature lines (a VTK method's "Name(self, ...) -> ..." and
 *  "C++: ...") as code, the rest as paragraphs (separated by blank lines, the line breaks within
 *  kept for lists), each a run of text and inline code (``code``, `name`, :py:meth:`name`). */
interface DocBlock { code: boolean; parts: { text: string; code: boolean }[] }
const SIGNATURE_LINE = /^(\w+\s*\(|C\+\+:|V\.|virtual |static )/;
function formatDoc(doc: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const lines = doc.replace(/\s+$/, "").split("\n");
  let i = 0;
  const signature: string[] = [];
  while (i < lines.length && (SIGNATURE_LINE.test(lines[i]) || (signature.length && /^\s+\S/.test(lines[i])))) signature.push(lines[i++]);
  if (signature.length) blocks.push({ code: true, parts: [{ text: signature.join("\n"), code: true }] });
  for (const paragraph of lines.slice(i).join("\n").split(/\n\s*\n/)) {
    const text = paragraph.replace(/^\n+|\s+$/g, "");
    if (!text) continue;
    const parts = text.split(/(?:(?::\w+)+:)?(``[^`]+``|`[^`]+`)/).map((part, p) =>
      p % 2 ? { text: part.replace(/^`+|`+$/g, ""), code: true } : { text: part, code: false }).filter((part) => part.text);
    blocks.push({ code: false, parts });
  }
  return blocks;
}
const activeDoc = computed(() => {
  const doc = suggestions.value[activeSuggestion.value]?.doc;
  return doc ? formatDoc(doc) : [];
});
// the box has room for the docstring as soon as any suggestion has one, so that it keeps its size
// while going through the list
const suggestionsHaveDocs = computed(() => suggestions.value.some((s) => s.doc));

onBeforeUnmount(() => window.clearTimeout(completionTimer));

// ---- Call tip: inside the parentheses of a call, the docstring of the function (the parameters it
// takes) above the prompt, while its arguments are typed. Escape hides it until the next key typed.
interface CallTip { name: string; argument: number; summary: string; doc: string }
const CALL_TIP_DELAY_MS = 150;
const callTip = ref<CallTip | null>(null);
let callTipTimer: number | undefined;
let callTipRequest = 0;
const callTipDoc = computed(() => (callTip.value ? formatDoc(callTip.value.doc) : []));

function updateCallTip() {
  window.clearTimeout(callTipTimer);
  const request = ++callTipRequest;
  callTipTimer = window.setTimeout(async () => {
    const el = inputEl.value;
    const text = input.value;
    if (!el || !text.includes("(")) {
      callTip.value = null;
      return;
    }
    const cursor = el.selectionStart ?? text.length;
    const tip = await bridge.call<CallTip | null>("callTipPython", [text, cursor]).catch(() => null);
    // a later request (more typed, the cursor moved) has the say
    if (request === callTipRequest) callTip.value = tip;
  }, CALL_TIP_DELAY_MS);
}

function hideCallTip() {
  window.clearTimeout(callTipTimer);
  callTipRequest++;
  callTip.value = null;
}

/** The cursor moved without anything typed (arrow keys, Home/End, a click). */
function onCursorMoved(e: Event) {
  if (e instanceof KeyboardEvent && !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
  if (!suggestions.value.length) updateCallTip();
}

onBeforeUnmount(() => window.clearTimeout(callTipTimer));

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
    if (e.key === "PageDown" || e.key === "PageUp") {
      // a page of the list: as many suggestions as it shows at a time, stopping at its ends
      e.preventDefault();
      const page = suggestionsPerPage();
      const step = e.key === "PageDown" ? page : -page;
      activeSuggestion.value = Math.max(0, Math.min(n - 1, activeSuggestion.value + step));
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
  if (e.key === "Escape" && callTip.value) {
    e.preventDefault();
    hideCallTip();
    return;
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

/**
 * Typing anywhere in the console types at the prompt.
 *
 * The output above the prompt can be selected and copied, so it takes the focus when it is
 * clicked; a key pressed there would otherwise go nowhere. A printable character is put at the
 * prompt and the prompt takes the focus; Enter (and any other key that is not a shortcut) just
 * moves the focus there.
 */
function onConsoleKeydown(event: KeyboardEvent) {
  const el = inputEl.value;
  if (!el || event.target === el || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  // a key that belongs to the browser or to reading the output, not to typing
  if (["Tab", "Escape", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    return;
  }
  el.focus();
  if (event.key.length === 1) {
    event.preventDefault();
    const at = el.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, at) + event.key + input.value.slice(el.selectionEnd ?? at);
    nextTick(() => el.setSelectionRange(at + 1, at + 1));
  } else if (event.key === "Enter") {
    // nothing to run from here: the prompt simply takes over
    event.preventDefault();
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
  <div class="flex shrink-0 flex-col border-t border-input bg-bkg-low/95 backdrop-blur" :style="{ height: height + 'px' }"
    data-name="pythonConsole" @keydown="onConsoleKeydown">
    <div class="h-1 cursor-row-resize hover:bg-primary/50" @pointerdown.prevent="startResize" />
    <div class="flex h-6 items-center justify-between px-2 text-[12px] text-muted-foreground">
      <span>Python console</span>
      <button type="button" class="hover:text-highlight" @click="store.pythonConsoleOpen = false"><X :size="14" /></button>
    </div>
    <div ref="output" tabindex="0" data-name="consoleOutput"
      class="min-h-0 flex-1 overflow-y-auto px-3 font-mono text-[12px] leading-5 whitespace-pre-wrap outline-none select-text">
      <div v-for="(l, i) in lines" :key="i"
        :class="{ 'text-highlight': l.kind === 'in', 'text-red-400': l.kind === 'err', 'text-muted-foreground': l.kind === 'log' }">{{ l.text }}</div>
    </div>
    <!-- Completions: a list above the prompt, as a console on the web usually has, so that long
         names can be read (a row of them along the prompt leaves no room for any of it). -->
    <div v-if="suggestions.length" class="relative h-0">
      <!-- one box above the prompt, as high as the console has room for: the suggestions on the left,
           the docstring of the one the list is on at the right (which does not change the box's size) -->
      <div class="absolute right-2 bottom-1 left-2 z-30 flex overflow-hidden rounded-md border border-input bg-popover shadow-xl"
        :style="{ maxHeight: `${Math.max(120, height - 64)}px`, minHeight: suggestionsHaveDocs ? `${Math.min(160, Math.max(120, height - 64))}px` : undefined }">
      <ul ref="suggestionList" class="min-h-0 overflow-y-auto py-1" :class="suggestionsHaveDocs ? 'w-1/2 shrink-0' : 'flex-1'"
        role="listbox" aria-label="Completions">
        <li v-for="(s, i) in suggestions" :key="s.text">
          <button type="button" role="option" :aria-selected="i === activeSuggestion" :data-active="i === activeSuggestion"
            class="flex w-full items-baseline gap-3 px-2 py-1 text-left font-mono text-[12px]"
            :class="i === activeSuggestion ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'"
            @pointerdown.prevent @click="applyCompletion(s)">
            <span class="shrink-0 text-foreground/90"><template v-for="(part, p) in matchParts(shortName(s.text))" :key="p"><span
              v-if="p === 1" class="font-semibold text-highlight" data-name="completionMatch">{{ part }}</span><template v-else>{{ part }}</template></template><span
              v-if="s.callable" class="opacity-60">()</span></span>
            <!-- what it does: the first line of its docstring (the full name when it has none) -->
            <span class="min-w-0 truncate font-sans text-[11px] opacity-70" :title="s.doc ?? s.text"
              data-name="completionSummary">{{ s.summary ?? s.text }}</span>
          </button>
        </li>
      </ul>
      <div v-if="suggestionsHaveDocs" class="relative min-w-0 flex-1 border-l border-input">
        <div v-if="activeDoc.length" data-name="completionDoc"
          class="absolute inset-0 space-y-2 overflow-y-auto px-3 py-2 text-[12px] leading-[1.15rem] text-muted-foreground">
          <template v-for="(block, b) in activeDoc" :key="b">
            <pre v-if="block.code" class="font-mono text-[11px] whitespace-pre-wrap text-foreground/90">{{ block.parts[0].text }}</pre>
            <p v-else class="whitespace-pre-wrap"><template v-for="(part, p) in block.parts" :key="p"><code
              v-if="part.code" class="rounded bg-accent/60 px-1 font-mono text-[11px] text-foreground/90">{{ part.text }}</code><template
              v-else>{{ part.text }}</template></template></p>
          </template>
        </div>
      </div>
      </div>
    </div>
    <!-- the call tip: the docstring of the function whose arguments are typed, in the place of the
         completions (which take over while they are shown) -->
    <div v-else-if="callTip" class="relative h-0">
      <div data-name="callTip"
        class="absolute right-2 bottom-1 left-2 z-30 space-y-2 overflow-y-auto rounded-md border border-input bg-popover px-3 py-2 text-[12px] leading-[1.15rem] text-muted-foreground shadow-xl"
        :style="{ maxHeight: `${Math.min(224, Math.max(120, height - 64))}px` }">
        <template v-for="(block, b) in callTipDoc" :key="b">
          <pre v-if="block.code" class="font-mono text-[11px] whitespace-pre-wrap text-foreground/90">{{ block.parts[0].text }}</pre>
          <p v-else class="whitespace-pre-wrap"><template v-for="(part, p) in block.parts" :key="p"><code
            v-if="part.code" class="rounded bg-accent/60 px-1 font-mono text-[11px] text-foreground/90">{{ part.text }}</code><template
            v-else>{{ part.text }}</template></template></p>
        </template>
      </div>
    </div>
    <textarea ref="inputEl" v-model="input" rows="1" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"
      placeholder=">>> (Shift+Enter for a new line, Tab to complete)"
      class="m-2 resize-none rounded border border-input bg-background px-2 py-1 font-mono text-[12px] outline-none focus:border-primary"
      @keydown="onKey" @input="onInput" @keyup="onCursorMoved" @click="onCursorMoved" @blur="closeSuggestions(); hideCallTip()" />
  </div>
</template>

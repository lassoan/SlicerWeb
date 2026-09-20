<script setup lang="ts">
// Module finder, as in desktop Slicer: type to search, the first hit is highlighted, the arrow keys
// walk the list, Enter opens the highlighted module and Escape closes. What is highlighted is
// described below the list (category, description, contributors, internal name, type, location).
import { computed, nextTick, ref, watch } from "vue";
import { FileText, Package, Search, X } from "@lucide/vue";
import { store, type ModuleSummary } from "../store";

const props = defineProps<{ modules: ModuleSummary[]; current: string }>();
const emit = defineEmits<{ select: [string]; close: [] }>();

const PAGE = 8; // items PgUp/PgDn move by

const filter = ref("");
const fullText = ref(false); // also search the description, as the "Full text" option does
const builtIn = ref(true); // include the modules of the application itself, not only extensions
const highlighted = ref(0);
const searchBox = ref<HTMLInputElement>();
const list = ref<HTMLElement>();

const results = computed(() => {
  const text = filter.value.trim().toLowerCase();
  return props.modules
    .filter((m) => builtIn.value || m.extension)
    .filter((m) => {
      if (!text) return true;
      if (m.title.toLowerCase().includes(text) || m.name.toLowerCase().includes(text)) return true;
      if (!fullText.value) return false;
      return (m.helpText ?? "").toLowerCase().includes(text) || (m.categories ?? []).join(" ").toLowerCase().includes(text);
    })
    .sort((a, b) => a.title.localeCompare(b.title));
});

const selected = computed(() => results.value[Math.min(highlighted.value, results.value.length - 1)]);

// typing searches again from the first hit
watch([filter, fullText, builtIn], () => (highlighted.value = 0));
watch(highlighted, async () => {
  await nextTick();
  list.value?.querySelector<HTMLElement>("[data-highlighted='true']")?.scrollIntoView({ block: "nearest" });
});

function move(delta: number) {
  if (!results.value.length) return;
  highlighted.value = Math.max(0, Math.min(results.value.length - 1, highlighted.value + delta));
}

function open(module?: ModuleSummary) {
  const target = module ?? selected.value;
  if (target) emit("select", target.name);
}

/** A tap shows what a module is; a tap on the one already shown opens it (no keyboard on a phone). */
function pick(index: number) {
  if (highlighted.value === index) open(results.value[index]);
  else highlighted.value = index;
}

function focus() {
  searchBox.value?.focus();
  searchBox.value?.select();
}

/** Switching an option keeps the cursor in the search box, so that typing can go on. */
function toggle(option: "fullText" | "builtIn") {
  if (option === "fullText") fullText.value = !fullText.value;
  else builtIn.value = !builtIn.value;
  searchBox.value?.focus();
}

const kindLabel = (m: ModuleSummary) =>
  m.kind === "loadable" ? "C++ Loadable" : m.kind === "scripted" ? "Python Scripted" : m.kind;

defineExpose({ focus });
</script>

<template>
  <div class="flex max-h-[80vh] flex-col overflow-hidden rounded-lg border border-input bg-popover shadow-xl">
    <div class="flex items-center gap-1 border-b border-input p-1.5">
      <Search :size="14" class="ml-1 shrink-0 text-muted-foreground" />
      <input ref="searchBox" v-model="filter" placeholder="Search modules" aria-label="Search modules"
        class="h-7 min-w-0 flex-1 rounded border border-transparent bg-background px-2 text-[13px] outline-none focus:border-primary"
        @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)"
        @keydown.page-down.prevent="move(PAGE)" @keydown.page-up.prevent="move(-PAGE)"
        @keydown.home.prevent="highlighted = 0" @keydown.end.prevent="highlighted = results.length - 1"
        @keydown.enter.prevent="open()" @keydown.escape.prevent="emit('close')" />
      <button type="button" title="Full text: search the module descriptions too" :aria-pressed="fullText"
        class="rounded p-1.5" :class="fullText ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-highlight'"
        @click="toggle('fullText')"><FileText :size="14" /></button>
      <button type="button" title="Built-in: include the modules of the application" :aria-pressed="builtIn"
        class="rounded p-1.5" :class="builtIn ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-highlight'"
        @click="toggle('builtIn')"><Package :size="14" /></button>
      <button type="button" title="Close" class="rounded p-1.5 text-muted-foreground hover:text-highlight" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>

    <div ref="list" class="min-h-16 flex-1 overflow-y-auto p-1">
      <button v-for="(m, index) in results" :key="m.name" type="button" :data-highlighted="index === highlighted"
        :data-name="m.name"
        class="block w-full truncate rounded px-2 py-1 text-left text-[13px]"
        :class="index === highlighted ? 'bg-accent text-accent-foreground' : m.name === current ? 'text-highlight' : 'hover:bg-accent/50'"
        @click="pick(index)" @dblclick="open(m)">{{ m.title }}</button>
      <div v-if="!results.length" class="px-2 py-3 text-[13px] text-muted-foreground">No module matches “{{ filter }}”.</div>
    </div>

    <div v-if="selected" class="max-h-[40%] overflow-y-auto border-t border-input bg-card/60 p-2 text-[12px]" data-name="moduleInformation">
      <div class="flex items-center justify-between gap-2">
        <div class="truncate text-[14px] font-semibold text-foreground">{{ selected.title }}</div>
        <button type="button" class="shrink-0 rounded bg-primary px-2 py-1 text-[12px] text-primary-foreground hover:bg-primary/85"
          @click="open()">Switch to module</button>
      </div>
      <p v-if="selected.helpText" class="mt-1 text-muted-foreground" v-html="selected.helpText" />
      <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
        <dt class="font-semibold">Category:</dt><dd class="truncate">{{ selected.categories.join(", ") || "—" }}</dd>
        <template v-if="selected.contributors.length">
          <dt class="font-semibold">Contributors:</dt><dd>{{ selected.contributors.join(", ") }}</dd>
        </template>
        <dt class="font-semibold">Internal name:</dt><dd class="truncate">{{ selected.name }}</dd>
        <dt class="font-semibold">Type:</dt><dd>{{ kindLabel(selected) }}<span v-if="selected.extension"> (extension {{ selected.extension }})</span></dd>
        <template v-if="selected.path">
          <dt class="font-semibold">Location:</dt><dd class="break-all">{{ selected.path }}</dd>
        </template>
      </dl>
    </div>
  </div>
</template>

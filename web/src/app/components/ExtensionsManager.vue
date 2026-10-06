<script setup lang="ts">
// Extensions Manager: browse an extension index, install/uninstall extension wheels.
// Installed extensions are remembered in the browser (localStorage) and loaded at startup.
import { computed, inject, nextTick, onMounted, ref, useTemplateRef, watch } from "vue";
import { X, Download, Trash2, ExternalLink, Puzzle } from "@lucide/vue";
import type { SlicerRuntime } from "@/core/runtime";

interface ExtensionEntry {
  name: string;
  version: string;
  category: string;
  description: string;
  homepage?: string;
  contributors?: string[];
  icon?: string;
  wheel: string; // URL of the wheel, relative to the index
  depends?: string[];
  modules?: string[];
  revision?: string;
  requires?: string[]; // SlicerWeb wheels needed besides the startup wheels (e.g. slicerweb-itk-extra)
}

const emit = defineEmits<{ close: [] }>();
const runtime = inject<SlicerRuntime>("runtime")!;
const indexUrl = ref(localStorage.getItem("slicerweb.extensionIndex") ?? new URL("extensions/index.json", document.baseURI).href);
const extensions = ref<ExtensionEntry[]>([]);
const installed = ref<string[]>(JSON.parse(localStorage.getItem("slicerweb.extensions") ?? "[]"));
const status = ref("");
const filter = ref("");

const shown = computed(() => {
  const f = filter.value.toLowerCase();
  // An extension need not say everything about itself (SimVascular names no category), and a
  // field that is not there must not end the dialog: matching what it says is enough.
  const says = (text: string | undefined) => (text ?? "").toLowerCase().includes(f);
  return extensions.value.filter((e) => !f || says(e.name) || says(e.description) || says(e.category));
});

// Keyboard: the search box keeps the focus all along. Typing filters the list, the arrow keys move
// through it, Enter installs or uninstalls the extension the list is on, and Escape closes the
// dialog - so that extensions can be found and installed one after the other without the mouse.
const search = useTemplateRef<HTMLInputElement>("search");
const list = useTemplateRef<HTMLElement>("list");
const highlighted = ref(0);
const busy = ref(false);
watch(() => shown.value.map((e) => e.name).join(), () => (highlighted.value = 0));
function focusSearch() {
  nextTick(() => search.value?.focus());
}
function moveHighlight(step: number) {
  if (!shown.value.length) return;
  highlighted.value = Math.max(0, Math.min(shown.value.length - 1, highlighted.value + step));
  nextTick(() => list.value?.querySelector("[data-highlighted=true]")?.scrollIntoView({ block: "nearest" }));
}
async function toggle(e: ExtensionEntry) {
  if (busy.value) return;   // one at a time: Enter pressed again while installing is not another
  busy.value = true;
  try {
    if (isInstalled(e)) uninstall(e);
    else await install(e);
  } finally {
    busy.value = false;
    focusSearch();
  }
}
function onSearchKey(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveHighlight(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const e = shown.value[highlighted.value];
    if (e) toggle(e);
  } else if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}

function resolve(path: string) {
  return new URL(path, indexUrl.value).href;
}

// An icon the page cannot load - one in a private repository, say - is replaced by a placeholder,
// with a warning in the log (once for each).
const iconFailed = ref<Record<string, boolean>>({});
function onIconError(e: ExtensionEntry) {
  if (iconFailed.value[e.name]) return;
  iconFailed.value = { ...iconFailed.value, [e.name]: true };
  console.warn(`The icon of extension ${e.name} could not be loaded: ${resolve(e.icon ?? "")} ` +
    `(the extension can name an icon file of its repository as "icon" in its slicerweb-extension.json)`);
}

function wheelUrl(e: ExtensionEntry) {
  return new URL(e.wheel, indexUrl.value).href;
}

async function loadIndex() {
  status.value = "Loading extension index…";
  try {
    const response = await fetch(indexUrl.value);
    extensions.value = (await response.json()).extensions ?? [];
    localStorage.setItem("slicerweb.extensionIndex", indexUrl.value);
    status.value = "";
  } catch (e: any) {
    extensions.value = [];
    status.value = `Extension index is not available (${e.message ?? e}).`;
  }
}

function isInstalled(e: ExtensionEntry) {
  return installed.value.includes(wheelUrl(e));
}

async function install(e: ExtensionEntry) {
  status.value = `Installing ${e.name}…`;
  try {
    const unavailable: string[] = [];
    for (const dep of e.depends ?? []) {
      const d = extensions.value.find((x) => x.name === dep);
      if (!d) unavailable.push(dep);
      else if (!isInstalled(d)) await install(d);
    }
    status.value = `Installing ${e.name}…`;
    for (const base of e.requires ?? []) {
      const baseUrl = await runtime.baseWheelUrl(base);
      if (!baseUrl) throw new Error(`${base} is not available`);
      if (installed.value.includes(baseUrl)) continue;
      status.value = `Installing ${base}…`;
      await runtime.installWheel(baseUrl);
      // installed at startup before the extensions (the list is kept in installation order)
      installed.value = [...installed.value, baseUrl];
      localStorage.setItem("slicerweb.extensions", JSON.stringify(installed.value));
    }
    status.value = `Installing ${e.name}…`;
    const url = wheelUrl(e);
    await runtime.installWheel(url);
    // What the extension asks the browser for (Pyodide packages such as SciPy); a module cannot
    // install one itself, so they are loaded here, before anything of the extension runs.
    const packages = await runtime.loadExtensionPackages();
    if (packages.length) status.value = `Loading ${packages.join(", ")}…`;
    status.value = `Loading ${e.name} modules…`;
    await runtime.loadModulesWithPackages(true);
    installed.value = [...installed.value, url];
    localStorage.setItem("slicerweb.extensions", JSON.stringify(installed.value));
    status.value = `${e.name} installed.` +
      (unavailable.length ? ` Not available in this index: ${unavailable.join(", ")} (features that need them will not work).` : "");
  } catch (err: any) {
    status.value = `Installing ${e.name} failed: ${err.message ?? err}`;
  }
}

async function installFromUrl() {
  const url = window.prompt("URL of an extension wheel (.whl)");
  if (!url) return;
  await install({ name: url.split("/").pop() ?? url, version: "", category: "", description: "", wheel: url });
}

function uninstall(e: ExtensionEntry) {
  installed.value = installed.value.filter((u) => u !== wheelUrl(e));
  localStorage.setItem("slicerweb.extensions", JSON.stringify(installed.value));
  status.value = `${e.name} will be removed after reloading the page.`;
}

onMounted(() => {
  focusSearch();
  loadIndex();
});
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" @click.self="emit('close')">
    <div class="flex h-[80vh] w-[860px] max-w-[95vw] flex-col rounded-lg border border-input bg-bkg-med shadow-2xl">
      <div class="flex items-center justify-between border-b border-input px-4 py-3">
        <div class="text-[16px] font-medium">Extensions Manager</div>
        <button type="button" class="text-muted-foreground hover:text-highlight" @click="emit('close')"><X :size="18" /></button>
      </div>
      <div class="flex flex-wrap gap-2 px-4 py-2">
        <!-- Bound by hand rather than with v-model, which holds its value back while a phone keyboard
             composes a word: the list follows every keystroke. -->
        <input ref="search" :value="filter" placeholder="Search extensions (↑ ↓ to choose, Enter to install or uninstall)"
          data-name="extensionSearch" @input="filter = ($event.target as HTMLInputElement).value" @keydown="onSearchKey"
          class="h-8 flex-1 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus:border-primary" />
        <input v-model="indexUrl" title="Extension index URL" class="h-8 w-80 max-md:hidden rounded-md border border-input bg-background px-2 text-[12px] text-muted-foreground outline-none" @change="loadIndex" />
        <button type="button" class="h-8 rounded-md bg-secondary/60 px-3 text-[13px] hover:bg-secondary" @click="installFromUrl">Install from URL</button>
      </div>
      <div v-if="status" class="mx-4 rounded bg-accent px-2 py-1 text-[12px]">{{ status }}</div>
      <div ref="list" class="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        <div v-for="(e, index) in shown" :key="e.name" class="mb-2 flex gap-3 rounded-lg bg-card p-3 max-md:flex-wrap"
          :class="index === highlighted ? 'ring-2 ring-highlight' : ''" :data-extension="e.name" :data-highlighted="index === highlighted"
          @mouseenter="highlighted = index">
          <img v-if="e.icon && !iconFailed[e.name]" :src="resolve(e.icon)" class="h-12 w-12 shrink-0 rounded" alt=""
            @error="onIconError(e)" />
          <div v-else class="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-accent text-muted-foreground"
            data-name="extensionIconPlaceholder"><Puzzle :size="24" /></div>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <span class="font-medium">{{ e.name }}</span>
              <span class="text-[12px] text-muted-foreground">{{ e.version }} · {{ e.category }}</span>
              <a v-if="e.homepage" :href="e.homepage" target="_blank" rel="noopener" class="text-muted-foreground hover:text-highlight"><ExternalLink :size="12" /></a>
            </div>
            <div class="text-[13px] text-foreground/80">{{ e.description }}</div>
            <div v-if="e.modules?.length" class="mt-1 text-[12px] text-muted-foreground">
              <span class="text-foreground/70">Modules:</span> {{ e.modules.join(", ") }}</div>
            <div v-if="e.depends?.length" class="text-[12px] text-muted-foreground">
              <span class="text-foreground/70">Depends on:</span> {{ e.depends.join(", ") }}</div>
            <div v-if="e.contributors?.length" class="mt-1 text-[11px] text-muted-foreground">{{ e.contributors.join(", ") }}</div>
          </div>
          <button v-if="!isInstalled(e)" type="button" class="flex h-8 items-center gap-1 self-center rounded-md bg-primary px-3 text-[13px] hover:bg-primary/85 disabled:opacity-50"
            :disabled="busy" @click="toggle(e)">
            <Download :size="14" />Install
          </button>
          <button v-else type="button" class="flex h-8 items-center gap-1 self-center rounded-md bg-secondary/60 px-3 text-[13px] hover:bg-secondary disabled:opacity-50"
            :disabled="busy" @click="toggle(e)">
            <Trash2 :size="14" />Uninstall
          </button>
        </div>
        <div v-if="!shown.length && !status" class="py-10 text-center text-[13px] text-muted-foreground">No extensions found.</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { FolderOpen, FileUp, Link, Database, Save, Trash2 } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { formatBytes, type SlicerRuntime } from "@/core/runtime";
import { store } from "../store";
import ShTree from "../components/ShTree.vue";
import { SAMPLE_DATA } from "../sampleData";
import SampleFinder, { type SampleEntry } from "../components/SampleFinder.vue";

const bridge = inject<SlicerBridge>("bridge")!;
const runtime = inject<SlicerRuntime>("runtime")!;
const fileInput = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
const busy = ref("");
const dragOver = ref(false);
const sampleOpen = ref(false);

/**
 * Sample data sets registered by modules (SampleData module registry, e.g. of installed extensions),
 * shown in the Samples menu after the data sets of the application.
 */
interface SampleDataSource {
  category: string;
  categoryTitle: string;
  name: string;
  description: string;
  uris: string[];
  fileNames: (string | null)[];
  nodeNames: (string | null)[];
  loadFiles: boolean[];
  loadFileTypes: (string | null)[];
  loadFileProperties: Record<string, unknown>;
  customDownloader: boolean;
  thumbnail?: string;
}
const moduleSamples = ref<SampleDataSource[]>([]);

/** How a download reports itself: "Downloading X — 240 MB of 1.2 GB (19%)". */
function downloadOptions(what: string) {
  return {
    onProgress(received: number, total: number) {
      const done = formatBytes(received);
      busy.value = total
        ? `Downloading ${what} — ${done} of ${formatBytes(total)} (${Math.round((received / total) * 100)}%)`
        : `Downloading ${what} — ${done}`;
    },
    // A data set of this size needs about as much again to be read into the scene, which is more
    // than a phone, and often a computer, can give a single page.
    tooLarge(total: number, name: string) {
      return window.confirm(
        `${name} is ${formatBytes(total)}.\n\n` +
        "Reading it into the scene needs about twice that in memory, which a browser tab may not " +
        "have - on a phone it almost certainly has not. Desktop Slicer opens it without trouble.\n\n" +
        "Download it anyway?");
    },
  };
}

async function refreshModuleSamples() {
  moduleSamples.value = await bridge.call<SampleDataSource[]>("getSampleDataSources").catch(() => []);
}
// Everything the finder offers, in one list: the data sets the application ships (which are there
// before the runtime has started) and the ones the modules registered, which say more about
// themselves. A data set in both is shown once, as the module's.
const sampleEntries = computed<SampleEntry[]>(() => {
  const fromModules = moduleSamples.value.map((s) => ({
    name: s.name,
    description: s.description,
    categoryTitle: s.categoryTitle || "Sample data",
    thumbnail: s.thumbnail,
    customDownloader: s.customDownloader,
    source: s,
  }));
  const known = new Set(fromModules.map((s) => s.name));
  const fromApplication = SAMPLE_DATA.filter((s) => !known.has(s.name)).map((s) => ({
    name: s.name,
    description: s.description,
    categoryTitle: "Sample data",
    source: s,
  }));
  // Kept in the order the Sample Data module lists them (see slicerweb.sample_data): categories
  // sorted with the built-in one first, and the data sets of a category as they were registered.
  return [...fromModules, ...fromApplication];
});

function loadSampleEntry(entry: SampleEntry) {
  const source = entry.source as SampleDataSource | (typeof SAMPLE_DATA)[number];
  if ("uris" in source) loadModuleSample(source);
  else loadSample(source);
}
const offModules = bridge.events.on("modules-changed", refreshModuleSamples);
onBeforeUnmount(() => offModules());
watch(sampleOpen, (open) => open && refreshModuleSamples(), { immediate: true });

/** Download the files of a registered sample data set and load them with the SampleData module. */
async function loadModuleSample(source: SampleDataSource) {
  sampleOpen.value = false;
  busy.value = `Downloading ${source.name}`;
  try {
    const files = [];
    for (let i = 0; i < source.uris.length; i++) {
      const fileName = source.fileNames[i] ?? undefined;
      const path = await runtime.downloadFile(source.uris[i], fileName, undefined, downloadOptions(source.name));
      files.push({ path, nodeName: source.nodeNames[i], fileType: source.loadFileTypes[i], load: source.loadFiles[i] !== false });
    }
    busy.value = `Loading ${source.name}`;
    const result = await bridge.call<{ loaded: string[]; messages: string[] }>("loadSampleDataFiles", [files, source]);
    // A data set that puts nothing in the scene - an archive of files a module reads itself - says
    // so, rather than leaving the window looking as though nothing happened.
    if (result?.messages?.length) alert(`${source.name}\n\n${result.messages.join("\n")}`);
  } catch (e: any) {
    alert(`${source.name}: ${e.message ?? e}`);
  } finally {
    busy.value = "";
  }
}

async function loadBrowserFiles(files: File[]) {
  if (!files.length) return;
  busy.value = `Loading ${files.length === 1 ? files[0].name : files.length + " files"}`;
  try {
    const paths = await runtime.writeFiles(files);
    await bridge.call("loadFiles", [paths]);
  } catch (e: any) {
    alert(`Loading failed: ${e.message ?? e}`);
  } finally {
    busy.value = "";
  }
}

function onFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  loadBrowserFiles(Array.from(input.files ?? []));
  input.value = "";
}

async function onDrop(e: DragEvent) {
  dragOver.value = false;
  const files: File[] = [];
  const items = Array.from(e.dataTransfer?.items ?? []);
  const readEntry = async (entry: any, path = ""): Promise<void> => {
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      Object.defineProperty(file, "webkitRelativePath", { value: path + file.name });
      files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch: any[];
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await readEntry(child, path + entry.name + "/");
      } while (batch.length);
    }
  };
  for (const item of items) {
    const entry = (item as any).webkitGetAsEntry?.();
    if (entry) await readEntry(entry);
  }
  await loadBrowserFiles(files);
}

async function loadUrl() {
  const url = window.prompt("URL of a file to load (NRRD, NIfTI, VTK, STL, MRB, ...)");
  if (!url) return;
  busy.value = "Downloading";
  try {
    const path = await runtime.downloadFile(url, undefined, undefined, downloadOptions(url.split("/").pop() || "file"));
    await bridge.call("loadFiles", [[path]]);
  } catch (e: any) {
    alert(e.message ?? e);
  } finally {
    busy.value = "";
  }
}

async function loadSample(sample: (typeof SAMPLE_DATA)[number]) {
  sampleOpen.value = false;
  busy.value = `Downloading ${sample.name}`;
  try {
    const path = await runtime.downloadFile(sample.url, sample.fileName, undefined, downloadOptions(sample.name));
    await bridge.call("loadFiles", [[path], sample.properties ?? {}]);
  } catch (e: any) {
    alert(e.message ?? e);
  } finally {
    busy.value = "";
  }
}

async function saveScene() {
  const name = window.prompt("Save scene as (.mrb bundles all data)", "SlicerScene.mrb");
  if (!name) return;
  const path = `/data/save/${name}`;
  await bridge.evalPython(`import os; os.makedirs("/data/save", exist_ok=True)`);
  const ok = await bridge.call<boolean>("saveScene", [path]);
  if (ok) runtime.saveFileToDisk(path);
  else alert("Saving the scene failed; see the Python console for details.");
}

async function closeScene() {
  if (confirm("Close the scene? Unsaved data will be lost.")) await bridge.call("closeScene");
}
</script>

<template>
  <div class="flex h-full flex-col" :class="{ 'ring-2 ring-highlight ring-inset': dragOver }"
    @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="onDrop">
    <div class="flex flex-wrap gap-1 p-2">
      <button type="button" class="sw-data-btn" title="Load files" @click="fileInput?.click()"><FileUp :size="15" />Files</button>
      <button type="button" class="sw-data-btn" title="Load a folder (e.g. a DICOM series)" @click="folderInput?.click()"><FolderOpen :size="15" />Folder</button>
      <button type="button" class="sw-data-btn" title="Load from URL" @click="loadUrl"><Link :size="15" />URL</button>
      <div class="relative">
        <button type="button" class="sw-data-btn" title="Sample data" @click="sampleOpen = !sampleOpen"><Database :size="15" />Samples</button>
        <SampleFinder v-if="sampleOpen" :samples="sampleEntries"
          @load="loadSampleEntry" @close="sampleOpen = false" />
      </div>
      <button type="button" class="sw-data-btn" title="Save scene" @click="saveScene"><Save :size="15" /></button>
      <button type="button" class="sw-data-btn" title="Close scene" @click="closeScene"><Trash2 :size="15" /></button>
      <input ref="fileInput" type="file" multiple class="hidden" @change="onFiles" />
      <input ref="folderInput" type="file" webkitdirectory multiple class="hidden" @change="onFiles" />
    </div>
    <div v-if="busy" class="mx-2 mb-2 rounded bg-accent px-2 py-1 text-[12px] text-accent-foreground">{{ busy }}…</div>
    <div class="px-2 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Subject hierarchy</div>
    <div class="sw-panel-scroll min-h-0 flex-1 px-1 pb-2">
      <ShTree v-if="store.subjectHierarchy.length" :items="store.subjectHierarchy" :depth="0" />
      <div v-else class="px-3 py-6 text-center text-[12px] text-muted-foreground">
        Drop files or folders here, or use the buttons above to load data.
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../../styles/main.css";
.sw-data-btn {
  @apply inline-flex h-7 items-center gap-1 rounded-md bg-secondary/50 px-2 text-[12px] text-secondary-foreground hover:bg-secondary;
}
</style>

<script setup lang="ts">
import { inject, ref } from "vue";
import { FolderOpen, FileUp, Link, Database, Save, Trash2 } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import type { SlicerRuntime } from "@/core/runtime";
import { store } from "../store";
import ShTree from "../components/ShTree.vue";
import { SAMPLE_DATA } from "../sampleData";

const bridge = inject<SlicerBridge>("bridge")!;
const runtime = inject<SlicerRuntime>("runtime")!;
const fileInput = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
const busy = ref("");
const dragOver = ref(false);
const sampleOpen = ref(false);

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
    const path = await runtime.downloadFile(url);
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
    const path = await runtime.downloadFile(sample.url, sample.fileName);
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
        <div v-if="sampleOpen" class="absolute top-8 left-0 z-20 w-60 rounded-lg border border-input bg-popover p-1 shadow-xl">
          <button v-for="s in SAMPLE_DATA" :key="s.name" type="button" class="block w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent"
            @click="loadSample(s)">
            <div>{{ s.name }}</div>
            <div class="text-[11px] text-muted-foreground">{{ s.description }}</div>
          </button>
        </div>
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

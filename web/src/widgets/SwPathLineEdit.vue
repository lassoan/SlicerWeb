<script setup lang="ts">
/**
 * ctkPathLineEdit: a file (or folder) to work on.
 *
 * A browser has no paths of its own - a page cannot look at the disk - so the file is chosen with
 * the file picker of the browser and copied into the virtual file system the application reads
 * from. What the module then sees is an ordinary path, "/data/project.mcs", which it can open.
 */
import { computed, ref, watch } from "vue";
import { FolderOpen } from "@lucide/vue";

const props = withDefaults(defineProps<{
  currentPath?: string;
  /** Name filters as Slicer writes them: "Mimics project (*.mcs *.mxp)". */
  nameFilters?: string | string[];
  placeholderText?: string;
  enabled?: boolean;
  /** Whether a folder is wanted rather than a file. */
  chooseDirectory?: boolean;
}>(), {
  currentPath: "",
  nameFilters: () => [],
  placeholderText: "Choose a file…",
  enabled: true,
  chooseDirectory: false,
});

const emit = defineEmits<{ currentPathChanged: [string] }>();

const input = ref<HTMLInputElement>();
const busy = ref(false);
// What is shown: the path that was given, until one is chosen here.
const shown = ref(props.currentPath);
watch(() => props.currentPath, (path) => (shown.value = path));

/** What the file picker offers, from the name filters: ".mcs,.mxp" (empty means anything). */
const accept = computed(() => {
  const filters = Array.isArray(props.nameFilters) ? props.nameFilters : [props.nameFilters];
  const extensions = new Set<string>();
  for (const filter of filters) {
    for (const pattern of String(filter ?? "").matchAll(/\*(\.[A-Za-z0-9_.]+)/g)) {
      extensions.add(pattern[1].toLowerCase());
    }
  }
  return [...extensions].join(",");
});

async function choose(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? []);
  if (!files.length) return;
  busy.value = true;
  try {
    // The application writes the file where module code can open it; outside the application
    // (a test page, say) there is nowhere to put it, so the name is all that can be offered.
    const runtime = (window as any).slicerWeb;
    const paths: string[] = runtime?.writeFiles
      ? await runtime.writeFiles(files, props.chooseDirectory ? "/data/folder" : "/data")
      : files.map((f) => f.name);
    shown.value = props.chooseDirectory ? paths[0].slice(0, paths[0].lastIndexOf("/")) : paths[0];
    emit("currentPathChanged", shown.value);
  } finally {
    busy.value = false;
    (event.target as HTMLInputElement).value = "";
  }
}
</script>

<template>
  <div class="sw-pathlineedit flex w-full min-w-0 items-center gap-1">
    <input type="text" class="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-40"
      :value="shown" :placeholder="placeholderText" :disabled="!enabled" :title="shown"
      data-name="currentPath"
      @change="shown = ($event.target as HTMLInputElement).value; emit('currentPathChanged', shown)" />
    <button type="button" class="flex h-7 shrink-0 items-center gap-1 rounded-md border border-input px-2 text-[12px] hover:border-primary disabled:opacity-40"
      :disabled="!enabled || busy" :title="chooseDirectory ? 'Choose a folder' : 'Choose a file'"
      data-name="browse" @click="input?.click()">
      <FolderOpen :size="14" />{{ busy ? "Copying…" : "Browse" }}
    </button>
    <input ref="input" type="file" class="hidden" :accept="accept" :multiple="chooseDirectory"
      :webkitdirectory="chooseDirectory || undefined" data-name="filePicker" @change="choose" />
  </div>
</template>

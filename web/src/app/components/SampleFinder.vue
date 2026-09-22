<script setup lang="ts">
// The list of sample data sets, searched the way the module finder is searched: type to filter,
// the arrow keys walk the list, Enter loads what is highlighted and Escape closes. Each data set
// shows the picture it is known by, under the heading of the category it belongs to.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Database, Search } from "@lucide/vue";

export interface SampleEntry {
  name: string;
  description: string;
  categoryTitle: string;
  thumbnail?: string;
  customDownloader?: boolean;
  /** What the panel needs to load it; the finder only passes it back. */
  source: unknown;
}

const props = defineProps<{ samples: SampleEntry[] }>();
const emit = defineEmits<{ load: [SampleEntry]; close: [] }>();

const PAGE = 6; // how far PgUp and PgDn move
const filter = ref("");
const highlighted = ref(0);
const searchBox = ref<HTMLInputElement>();
const list = ref<HTMLElement>();

const results = computed(() => {
  const text = filter.value.trim().toLowerCase();
  const matching = props.samples.filter((s) => !text
    || s.name.toLowerCase().includes(text)
    || s.description.toLowerCase().includes(text)
    || s.categoryTitle.toLowerCase().includes(text));
  if (!text) return matching;
  // What was typed is most likely the start of the name being looked for, so those come first -
  // typing "MRHead" offers MRHead before CBCTMRHead.
  const rank = (s: SampleEntry) => (s.name.toLowerCase() === text ? 0 : s.name.toLowerCase().startsWith(text) ? 1 : 2);
  return [...matching].sort((a, b) => rank(a) - rank(b)
    || a.categoryTitle.localeCompare(b.categoryTitle) || a.name.localeCompare(b.name));
});

/** The list as it is shown: a heading wherever the category changes. */
const rows = computed(() => {
  const out: { heading?: string; sample?: SampleEntry; index: number }[] = [];
  let category = "";
  results.value.forEach((sample, index) => {
    if (sample.categoryTitle !== category) {
      category = sample.categoryTitle;
      out.push({ heading: category, index: -1 });
    }
    out.push({ sample, index });
  });
  return out;
});

watch(filter, () => (highlighted.value = 0));
watch(highlighted, async () => {
  await nextTick();
  list.value?.querySelector<HTMLElement>("[data-highlighted='true']")?.scrollIntoView({ block: "nearest" });
});
onMounted(() => nextTick(() => searchBox.value?.focus()));

function move(delta: number) {
  if (!results.value.length) return;
  highlighted.value = Math.max(0, Math.min(results.value.length - 1, highlighted.value + delta));
}

function load(sample?: SampleEntry) {
  const wanted = sample ?? results.value[highlighted.value];
  if (wanted && !wanted.customDownloader) emit("load", wanted);
}
</script>

<template>
  <div class="absolute top-8 left-0 z-20 flex max-h-[70vh] w-80 flex-col rounded-lg border border-input bg-popover shadow-xl"
    data-name="sampleFinder" @keydown.esc.stop.prevent="emit('close')"
    @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)"
    @keydown.page-down.prevent="move(PAGE)" @keydown.page-up.prevent="move(-PAGE)"
    @keydown.enter.prevent="load()">
    <div class="relative border-b border-input p-1">
      <Search :size="14" class="pointer-events-none absolute top-3 left-3 text-muted-foreground" />
      <input ref="searchBox" v-model="filter" type="search" placeholder="Search sample data" data-name="sampleSearch"
        class="h-8 w-full rounded-md bg-background pr-2 pl-7 text-[13px] text-foreground outline-none" />
    </div>
    <div ref="list" class="min-h-0 flex-1 overflow-y-auto p-1">
      <template v-for="row in rows" :key="row.heading ?? row.sample!.categoryTitle + row.sample!.name">
        <div v-if="row.heading"
          class="sticky top-0 z-10 bg-popover px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-foreground uppercase">
          {{ row.heading }}
        </div>
        <button v-else type="button" data-name="sampleItem" :data-highlighted="row.index === highlighted"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left disabled:opacity-40"
          :class="row.index === highlighted ? 'bg-accent text-foreground' : 'hover:bg-accent/50'"
          :disabled="row.sample!.customDownloader"
          :title="row.sample!.customDownloader ? 'This data set can only be downloaded by its module' : row.sample!.description"
          @click="load(row.sample!)" @mousemove="highlighted = row.index">
          <img v-if="row.sample!.thumbnail" :src="row.sample!.thumbnail" alt=""
            class="h-9 w-9 shrink-0 rounded border border-input/60 object-cover" />
          <span v-else class="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-input/60 text-muted-foreground">
            <Database :size="15" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px] text-foreground">{{ row.sample!.name }}</span>
            <span v-if="row.sample!.description" class="block truncate text-[11px] text-muted-foreground">
              {{ row.sample!.description }}
            </span>
          </span>
        </button>
      </template>
      <div v-if="!results.length" class="px-3 py-6 text-center text-[12px] text-muted-foreground">
        Nothing matches "{{ filter }}".
      </div>
    </div>
  </div>
</template>

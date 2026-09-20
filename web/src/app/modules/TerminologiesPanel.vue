<script setup lang="ts">
// Terminologies module: the terminology contexts loaded in the application, and what they contain.
import { inject, onMounted, ref, watch } from "vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwFormRow } from "@/widgets";

interface Category { name: string; typeCount: number; types: string[] }

const bridge = inject<SlicerBridge>("bridge")!;
const contexts = ref<{ terminologies: string[]; anatomicContexts: string[] }>({ terminologies: [], anatomicContexts: [] });
const terminology = ref("");
const search = ref("");
const categories = ref<Category[]>([]);
const open = ref<string | null>(null);

async function refresh() {
  contexts.value = await bridge.call("terminologyContexts");
  if (!terminology.value) terminology.value = contexts.value.terminologies[0] ?? "";
  await load();
}

async function load() {
  if (!terminology.value) return;
  categories.value = await bridge.call<Category[]>("terminologyCategories", [terminology.value, search.value]);
}

watch([terminology, search], load);
onMounted(refresh);
</script>

<template>
  <div class="flex flex-col gap-2">
    <SwFormRow label="Terminology">
      <select v-model="terminology" class="h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus:border-primary">
        <option v-for="t in contexts.terminologies" :key="t" :value="t">{{ t }}</option>
      </select>
    </SwFormRow>
    <input v-model="search" placeholder="Search categories"
      class="h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus:border-primary" />
    <div class="max-h-96 overflow-y-auto rounded-md border border-input/60">
      <div v-for="c in categories" :key="c.name" class="border-b border-input/30 last:border-b-0">
        <button type="button" class="flex w-full items-center gap-2 px-2 py-1 text-left text-[13px] hover:bg-accent/40"
          @click="open = open === c.name ? null : c.name">
          <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
          <span class="shrink-0 text-[11px] text-muted-foreground tabular-nums">{{ c.typeCount }}</span>
        </button>
        <ul v-if="open === c.name" class="bg-card/40 px-4 py-1 text-[12px] text-muted-foreground">
          <li v-for="t in c.types" :key="t" class="truncate">{{ t }}</li>
          <li v-if="c.typeCount > c.types.length" class="italic">and {{ c.typeCount - c.types.length }} more…</li>
        </ul>
      </div>
      <div v-if="!categories.length" class="p-2 text-[12px] text-muted-foreground">No category matches.</div>
    </div>
    <div v-if="contexts.anatomicContexts.length" class="text-[11px] text-muted-foreground">
      Anatomic contexts: {{ contexts.anatomicContexts.join(", ") }}
    </div>
  </div>
</template>

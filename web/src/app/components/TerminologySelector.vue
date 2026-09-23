<script setup lang="ts">
// What a segment is, chosen from a terminology: a category ("Tissue"), a type ("Liver") and, where
// the type offers them, a modifier ("left"). Choosing one names the segment after it and colours
// it the way the terminology recommends, as the terminology selector of Slicer does.
import { computed, inject, ref, watch } from "vue";
import { Search, X } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";

const props = defineProps<{ segmentationNodeId: string; segmentId: string; segmentName: string }>();
const emit = defineEmits<{ close: []; applied: [] }>();
const bridge = inject<SlicerBridge>("bridge")!;

interface Coded { codeValue: string; name: string; color?: string; modifierCount?: number }

const terminologyName = ref("");
const terminologies = ref<string[]>([]);
const search = ref("");
const categories = ref<Coded[]>([]);
const types = ref<Coded[]>([]);
const modifiers = ref<Coded[]>([]);
const category = ref<string>("");
const type = ref<string>("");
const modifier = ref<string>("");
const error = ref("");

const chosenType = computed(() => types.value.find((t) => t.codeValue === type.value));
const chosenModifier = computed(() => modifiers.value.find((m) => m.codeValue === modifier.value));
const resultingName = computed(() => chosenModifier.value?.name ?? chosenType.value?.name ?? props.segmentName);
const resultingColor = computed(() => chosenModifier.value?.color ?? chosenType.value?.color ?? "#888888");

async function loadCategories() {
  categories.value = await bridge.call<Coded[]>("terminologyCategoryList", [terminologyName.value, search.value]);
  if (!categories.value.some((c) => c.codeValue === category.value)) {
    category.value = categories.value[0]?.codeValue ?? "";
  }
}

async function loadTypes() {
  types.value = category.value
    ? await bridge.call<Coded[]>("terminologyTypeList", [terminologyName.value, category.value, search.value])
    : [];
  if (!types.value.some((t) => t.codeValue === type.value)) type.value = types.value[0]?.codeValue ?? "";
}

async function loadModifiers() {
  modifiers.value = type.value
    ? await bridge.call<Coded[]>("terminologyModifierList", [terminologyName.value, category.value, type.value])
    : [];
  if (!modifiers.value.some((m) => m.codeValue === modifier.value)) modifier.value = "";
}

async function start() {
  error.value = "";
  terminologies.value = await bridge.call<string[]>("terminologyNames");
  const current = await bridge.call<{ terminologyName: string; categoryCodeValue: string; typeCodeValue: string; modifierCodeValue: string }>(
    "getSegmentTerminology", [props.segmentationNodeId, props.segmentId]);
  terminologyName.value = current.terminologyName || terminologies.value[0] || "";
  category.value = current.categoryCodeValue;
  type.value = current.typeCodeValue;
  modifier.value = current.modifierCodeValue;
  await loadCategories();
  await loadTypes();
  await loadModifiers();
}

watch(() => [props.segmentationNodeId, props.segmentId].join(), start, { immediate: true });
watch(search, async () => { await loadCategories(); await loadTypes(); });
watch(terminologyName, async () => { await loadCategories(); await loadTypes(); await loadModifiers(); });

async function chooseCategory(codeValue: string) {
  category.value = codeValue;
  type.value = "";
  modifier.value = "";
  await loadTypes();
  await loadModifiers();
}

async function chooseType(codeValue: string) {
  type.value = codeValue;
  modifier.value = "";
  await loadModifiers();
}

async function apply() {
  error.value = "";
  try {
    await bridge.call("setSegmentTerminology",
      [props.segmentationNodeId, props.segmentId, terminologyName.value, category.value, type.value, modifier.value]);
    emit("applied");
    emit("close");
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  }
}
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" @click.self="emit('close')">
    <div class="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-input bg-popover shadow-2xl"
      data-name="terminologySelector">
      <div class="flex items-center gap-2 border-b border-input px-3 py-2">
        <span class="flex-1 text-[14px] font-medium text-foreground">What is "{{ segmentName }}"?</span>
        <button type="button" class="text-muted-foreground hover:text-highlight" title="Close" @click="emit('close')">
          <X :size="16" />
        </button>
      </div>

      <div class="flex items-center gap-2 border-b border-input px-3 py-2">
        <select v-if="terminologies.length > 1" v-model="terminologyName"
          class="h-7 max-w-[45%] rounded-md border border-input bg-background px-2 text-[12px] text-foreground outline-none">
          <option v-for="t in terminologies" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="relative flex-1">
          <Search :size="13" class="pointer-events-none absolute top-2 left-2 text-muted-foreground" />
          <input v-model="search" type="search" placeholder="Search"
            class="h-7 w-full rounded-md border border-input bg-background pr-2 pl-7 text-[13px] text-foreground outline-none focus:border-primary" />
        </div>
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-3 divide-x divide-input">
        <div class="flex min-h-0 flex-col">
          <div class="px-3 py-1 text-[11px] tracking-wide text-muted-foreground uppercase">Category</div>
          <div class="min-h-0 flex-1 overflow-y-auto" data-name="terminologyCategories">
            <button v-for="c in categories" :key="c.codeValue" type="button"
              class="block w-full px-3 py-1 text-left text-[13px]"
              :class="c.codeValue === category ? 'bg-accent text-foreground' : 'hover:bg-accent/40'"
              @click="chooseCategory(c.codeValue)">{{ c.name }}</button>
          </div>
        </div>
        <div class="flex min-h-0 flex-col">
          <div class="px-3 py-1 text-[11px] tracking-wide text-muted-foreground uppercase">Type</div>
          <div class="min-h-0 flex-1 overflow-y-auto" data-name="terminologyTypes">
            <button v-for="t in types" :key="t.codeValue" type="button"
              class="flex w-full items-center gap-2 px-3 py-1 text-left text-[13px]"
              :class="t.codeValue === type ? 'bg-accent text-foreground' : 'hover:bg-accent/40'"
              @click="chooseType(t.codeValue)">
              <span class="h-3 w-3 shrink-0 rounded-sm" :style="{ background: t.color }" />{{ t.name }}
            </button>
          </div>
        </div>
        <div class="flex min-h-0 flex-col">
          <div class="px-3 py-1 text-[11px] tracking-wide text-muted-foreground uppercase">Modifier</div>
          <div class="min-h-0 flex-1 overflow-y-auto" data-name="terminologyModifiers">
            <button v-if="modifiers.length" type="button" class="block w-full px-3 py-1 text-left text-[13px]"
              :class="modifier === '' ? 'bg-accent text-foreground' : 'hover:bg-accent/40'"
              @click="modifier = ''">(none)</button>
            <button v-for="m in modifiers" :key="m.codeValue" type="button"
              class="flex w-full items-center gap-2 px-3 py-1 text-left text-[13px]"
              :class="m.codeValue === modifier ? 'bg-accent text-foreground' : 'hover:bg-accent/40'"
              @click="modifier = m.codeValue">
              <span class="h-3 w-3 shrink-0 rounded-sm" :style="{ background: m.color }" />{{ m.name }}
            </button>
            <div v-if="!modifiers.length" class="px-3 py-1 text-[12px] text-muted-foreground">
              This type has none.
            </div>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 border-t border-input px-3 py-2">
        <span class="h-4 w-4 shrink-0 rounded-sm" :style="{ background: resultingColor }" />
        <span class="flex-1 truncate text-[13px] text-foreground">{{ resultingName }}</span>
        <span v-if="error" class="truncate text-[12px] text-red-400">{{ error }}</span>
        <button type="button" class="rounded-md px-3 py-1 text-[13px] text-foreground hover:bg-accent"
          @click="emit('close')">Cancel</button>
        <button type="button" data-name="terminologyApply" :disabled="!type"
          class="rounded-md bg-highlight px-3 py-1 text-[13px] text-background disabled:opacity-40"
          @click="apply">Select</button>
      </div>
    </div>
  </div>
</template>

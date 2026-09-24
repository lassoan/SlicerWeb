<script setup lang="ts">
// QComboBox / ctkComboBox. items: list of strings or {text, data, toolTip}.
import { computed } from "vue";

const props = withDefaults(
  defineProps<{ items?: (string | { text: string; data?: unknown; toolTip?: string })[]; currentIndex?: number; enabled?: boolean; toolTip?: string }>(),
  { items: () => [], currentIndex: 0, enabled: true, toolTip: "" },
);
const emit = defineEmits<{ currentIndexChanged: [number]; currentTextChanged: [string] }>();
const options = computed(() => props.items.map((i) => (typeof i === "string" ? { text: i, toolTip: undefined } : i)));

function change(e: Event) {
  const index = (e.target as HTMLSelectElement).selectedIndex;
  emit("currentIndexChanged", index);
  emit("currentTextChanged", options.value[index]?.text ?? "");
}
</script>

<template>
  <select class="sw-combobox h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-40"
    :title="toolTip" :disabled="!enabled" @change="change">
    <option v-for="(o, i) in options" :key="i" :selected="i === currentIndex" :title="o.toolTip">{{ o.text }}</option>
  </select>
</template>

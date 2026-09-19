<script setup lang="ts">
// QTabWidget. Tab contents are slotted children with a "tab-label" attribute (custom element use)
// or named slots tab0, tab1, ... (Vue use).
import { ref, watch } from "vue";

const props = withDefaults(defineProps<{ tabs?: string[]; currentIndex?: number }>(), { tabs: () => [], currentIndex: 0 });
const emit = defineEmits<{ currentChanged: [number] }>();
const current = ref(props.currentIndex);
watch(() => props.currentIndex, (v) => (current.value = v));

function select(i: number) {
  current.value = i;
  emit("currentChanged", i);
}
</script>

<template>
  <div class="sw-tabwidget flex flex-col">
    <div class="flex gap-[2px] border-b border-input">
      <button v-for="(t, i) in tabs" :key="i" type="button" class="rounded-t px-3 py-1 text-[12px]"
        :class="current === i ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="select(i)">{{ t }}</button>
    </div>
    <div class="pt-2">
      <template v-for="(t, i) in tabs" :key="i">
        <div v-show="current === i"><slot :name="'tab' + i" /></div>
      </template>
      <slot />
    </div>
  </div>
</template>

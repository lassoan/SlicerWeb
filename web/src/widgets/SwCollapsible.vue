<script setup lang="ts">
// ctkCollapsibleButton
import { ref, watch } from "vue";
import { ChevronDown, ChevronRight } from "@lucide/vue";

const props = withDefaults(defineProps<{ text?: string; collapsed?: boolean }>(), { text: "", collapsed: false });
const emit = defineEmits<{ contentsCollapsed: [boolean] }>();
const isCollapsed = ref(props.collapsed);
watch(() => props.collapsed, (v) => (isCollapsed.value = v));

function toggle() {
  isCollapsed.value = !isCollapsed.value;
  emit("contentsCollapsed", isCollapsed.value);
}
</script>

<template>
  <section class="sw-collapsible mb-1 rounded-md bg-card/60">
    <button type="button" class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium text-foreground hover:bg-accent/60"
      @click="toggle">
      <ChevronRight v-if="isCollapsed" :size="14" class="text-muted-foreground" />
      <ChevronDown v-else :size="14" class="text-muted-foreground" />
      {{ text }}
    </button>
    <div v-show="!isCollapsed" class="flex flex-col gap-1.5 px-2 pt-0.5 pb-2">
      <slot />
    </div>
  </section>
</template>

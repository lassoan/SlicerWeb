<script setup lang="ts">
// QProgressBar
import { computed } from "vue";

const props = withDefaults(defineProps<{ value?: number; minimum?: number; maximum?: number; textVisible?: boolean }>(), {
  value: 0,
  minimum: 0,
  maximum: 100,
  textVisible: true,
});
const pct = computed(() => Math.round(((props.value - props.minimum) / (props.maximum - props.minimum || 1)) * 100));
</script>

<template>
  <div class="sw-progressbar flex items-center gap-2">
    <div class="h-1.5 flex-1 overflow-hidden rounded bg-input">
      <div class="h-full bg-primary transition-all" :style="{ width: pct + '%' }" />
    </div>
    <span v-if="textVisible" class="w-10 text-right text-[12px] text-muted-foreground">{{ pct }}%</span>
  </div>
</template>

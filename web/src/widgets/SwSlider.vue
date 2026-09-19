<script setup lang="ts">
// ctkSliderWidget / ctkDoubleSlider + spin box
import { computed } from "vue";

const props = withDefaults(
  defineProps<{ value?: number; minimum?: number; maximum?: number; singleStep?: number; decimals?: number; suffix?: string; enabled?: boolean }>(),
  { value: 0, minimum: 0, maximum: 100, singleStep: 1, decimals: 2, suffix: "", enabled: true },
);
const emit = defineEmits<{ valueChanged: [number] }>();
const text = computed(() => Number(props.value ?? 0).toFixed(props.decimals));

function set(v: number) {
  if (Number.isNaN(v)) return;
  emit("valueChanged", Math.min(props.maximum, Math.max(props.minimum, v)));
}
</script>

<template>
  <div class="sw-slider flex items-center gap-2" :class="{ 'pointer-events-none opacity-40': !enabled }">
    <input type="range" class="h-1 min-w-0 flex-1 cursor-pointer accent-highlight" :min="minimum" :max="maximum" :step="singleStep"
      :value="value" @input="set(Number(($event.target as HTMLInputElement).value))" />
    <input type="number" class="w-[76px] rounded border border-input bg-background px-1.5 py-0.5 text-right text-[12px] text-foreground outline-none focus:border-primary"
      :min="minimum" :max="maximum" :step="singleStep" :value="text"
      @change="set(Number(($event.target as HTMLInputElement).value))" />
    <span v-if="suffix" class="text-[12px] text-muted-foreground">{{ suffix }}</span>
  </div>
</template>

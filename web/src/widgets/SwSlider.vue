<script setup lang="ts">
// ctkSliderWidget / ctkDoubleSlider + spin box
import { computed, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{ value?: number; minimum?: number; maximum?: number; singleStep?: number; decimals?: number; suffix?: string; enabled?: boolean }>(),
  { value: 0, minimum: 0, maximum: 100, singleStep: 1, decimals: 2, suffix: "", enabled: true },
);
const emit = defineEmits<{ valueChanged: [number] }>();
// The value shown: what the user set here, and what the widget is given (Python sets the element's
// value only when the value is changed from there, not when the user changes it here)
const current = ref(props.value ?? 0);
watch(() => props.value, (v) => { current.value = v ?? 0; });
const text = computed(() => Number(current.value).toFixed(props.decimals));

function set(v: number) {
  if (Number.isNaN(v)) return;
  current.value = Math.min(props.maximum, Math.max(props.minimum, v));
  emit("valueChanged", current.value);
}
</script>

<template>
  <div class="sw-slider flex items-center gap-2" :class="{ 'pointer-events-none opacity-40': !enabled }">
    <input type="range" class="h-1 min-w-0 flex-1 cursor-pointer accent-highlight" :min="minimum" :max="maximum" :step="singleStep"
      :value="current" @input="set(Number(($event.target as HTMLInputElement).value))" />
    <input type="number" class="w-[76px] rounded border border-input bg-background px-1.5 py-0.5 text-right text-[12px] text-foreground outline-none focus:border-primary"
      :min="minimum" :max="maximum" :step="singleStep" :value="text"
      @change="set(Number(($event.target as HTMLInputElement).value))" />
    <span v-if="suffix" class="text-[12px] text-muted-foreground">{{ suffix }}</span>
  </div>
</template>

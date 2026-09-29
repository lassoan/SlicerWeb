<script setup lang="ts">
// ctkRangeWidget / ctkDoubleRangeSlider
import { ref, watch } from "vue";
const props = withDefaults(
  defineProps<{ minimumValue?: number; maximumValue?: number; minimum?: number; maximum?: number; singleStep?: number; decimals?: number }>(),
  { minimumValue: 0, maximumValue: 100, minimum: 0, maximum: 100, singleStep: 1, decimals: 1 },
);
const emit = defineEmits<{ valuesChanged: [number, number] }>();
// The values shown: what the user set here, and what the widget is given (Python sets the element's
// values only when they are changed from there, not when the user changes them here)
const lo = ref(props.minimumValue);
const hi = ref(props.maximumValue);
watch(() => props.minimumValue, (v) => { lo.value = v; });
watch(() => props.maximumValue, (v) => { hi.value = v; });

function setMin(v: number) {
  if (Number.isNaN(v)) return;
  lo.value = Math.min(v, hi.value);
  emit("valuesChanged", lo.value, hi.value);
}
function setMax(v: number) {
  if (Number.isNaN(v)) return;
  hi.value = Math.max(v, lo.value);
  emit("valuesChanged", lo.value, hi.value);
}
const pct = (v: number) => ((v - props.minimum) / (props.maximum - props.minimum || 1)) * 100;
</script>

<template>
  <div class="sw-range-slider flex items-center gap-2">
    <input type="number" class="w-[70px] rounded border border-input bg-background px-1 py-0.5 text-right text-[12px] outline-none"
      :value="lo.toFixed(decimals)" :step="singleStep" @change="setMin(Number(($event.target as HTMLInputElement).value))" />
    <div class="relative h-5 min-w-0 flex-1">
      <div class="absolute top-2 right-0 left-0 h-1 rounded bg-input" />
      <div class="absolute top-2 h-1 rounded bg-highlight" :style="{ left: pct(lo) + '%', right: 100 - pct(hi) + '%' }" />
      <input type="range" class="sw-range-thumb absolute inset-0 w-full" :min="minimum" :max="maximum" :step="singleStep" :value="lo"
        @input="setMin(Number(($event.target as HTMLInputElement).value))" />
      <input type="range" class="sw-range-thumb absolute inset-0 w-full" :min="minimum" :max="maximum" :step="singleStep" :value="hi"
        @input="setMax(Number(($event.target as HTMLInputElement).value))" />
    </div>
    <input type="number" class="w-[70px] rounded border border-input bg-background px-1 py-0.5 text-right text-[12px] outline-none"
      :value="hi.toFixed(decimals)" :step="singleStep" @change="setMax(Number(($event.target as HTMLInputElement).value))" />
  </div>
</template>

<style>
.sw-range-thumb {
  appearance: none;
  background: transparent;
  pointer-events: none;
}
.sw-range-thumb::-webkit-slider-thumb {
  appearance: none;
  pointer-events: auto;
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: var(--color-highlight);
  cursor: pointer;
}
.sw-range-thumb::-moz-range-thumb {
  pointer-events: auto;
  width: 12px;
  height: 12px;
  border: 0;
  border-radius: 9999px;
  background: var(--color-highlight);
  cursor: pointer;
}
</style>

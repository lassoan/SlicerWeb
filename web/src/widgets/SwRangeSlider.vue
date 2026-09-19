<script setup lang="ts">
// ctkRangeWidget / ctkDoubleRangeSlider
const props = withDefaults(
  defineProps<{ minimumValue?: number; maximumValue?: number; minimum?: number; maximum?: number; singleStep?: number; decimals?: number }>(),
  { minimumValue: 0, maximumValue: 100, minimum: 0, maximum: 100, singleStep: 1, decimals: 1 },
);
const emit = defineEmits<{ valuesChanged: [number, number] }>();

function setMin(v: number) {
  emit("valuesChanged", Math.min(v, props.maximumValue), props.maximumValue);
}
function setMax(v: number) {
  emit("valuesChanged", props.minimumValue, Math.max(v, props.minimumValue));
}
const pct = (v: number) => ((v - props.minimum) / (props.maximum - props.minimum || 1)) * 100;
</script>

<template>
  <div class="sw-range-slider flex items-center gap-2">
    <input type="number" class="w-[70px] rounded border border-input bg-background px-1 py-0.5 text-right text-[12px] outline-none"
      :value="minimumValue.toFixed(decimals)" :step="singleStep" @change="setMin(Number(($event.target as HTMLInputElement).value))" />
    <div class="relative h-5 min-w-0 flex-1">
      <div class="absolute top-2 right-0 left-0 h-1 rounded bg-input" />
      <div class="absolute top-2 h-1 rounded bg-highlight" :style="{ left: pct(minimumValue) + '%', right: 100 - pct(maximumValue) + '%' }" />
      <input type="range" class="sw-range-thumb absolute inset-0 w-full" :min="minimum" :max="maximum" :step="singleStep" :value="minimumValue"
        @input="setMin(Number(($event.target as HTMLInputElement).value))" />
      <input type="range" class="sw-range-thumb absolute inset-0 w-full" :min="minimum" :max="maximum" :step="singleStep" :value="maximumValue"
        @input="setMax(Number(($event.target as HTMLInputElement).value))" />
    </div>
    <input type="number" class="w-[70px] rounded border border-input bg-background px-1 py-0.5 text-right text-[12px] outline-none"
      :value="maximumValue.toFixed(decimals)" :step="singleStep" @change="setMax(Number(($event.target as HTMLInputElement).value))" />
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

<script setup lang="ts">
// QSpinBox / QDoubleSpinBox / ctkDoubleSpinBox
import { computed } from "vue";

const props = withDefaults(
  defineProps<{ value?: number; minimum?: number; maximum?: number; singleStep?: number; decimals?: number; suffix?: string; prefix?: string; enabled?: boolean }>(),
  { value: 0, minimum: -1e9, maximum: 1e9, singleStep: 1, decimals: 0, suffix: "", prefix: "", enabled: true },
);
const emit = defineEmits<{ valueChanged: [number] }>();
const text = computed(() => Number(props.value ?? 0).toFixed(props.decimals));

function set(v: number) {
  if (!Number.isNaN(v)) emit("valueChanged", Math.min(props.maximum, Math.max(props.minimum, v)));
}
</script>

<template>
  <div class="sw-spinbox inline-flex items-center gap-1" :class="{ 'pointer-events-none opacity-40': !enabled }">
    <span v-if="prefix" class="text-[12px] text-muted-foreground">{{ prefix }}</span>
    <input type="number" class="h-7 w-[90px] rounded-md border border-input bg-background px-1.5 text-right text-[13px] text-foreground outline-none focus:border-primary"
      :min="minimum" :max="maximum" :step="singleStep" :value="text" @change="set(Number(($event.target as HTMLInputElement).value))" />
    <span v-if="suffix" class="text-[12px] text-muted-foreground">{{ suffix }}</span>
  </div>
</template>

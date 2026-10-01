<script setup lang="ts">
// ctkColorPickerButton. color: "#rrggbb"
withDefaults(defineProps<{ color?: string; text?: string; enabled?: boolean }>(), { color: "#ffffff", text: "", enabled: true });
const emit = defineEmits<{ colorChanged: [string] }>();
</script>

<template>
  <label class="sw-colorpicker inline-flex cursor-pointer items-center gap-2 text-[13px]" :class="{ 'pointer-events-none opacity-40': !enabled }">
    <!-- as tall as a push button (min-h-7), so that it lines up with the buttons beside it -->
    <input type="color" class="h-7 w-9 cursor-pointer rounded-md border border-input bg-transparent p-0.5" :value="color"
      @input="emit('colorChanged', ($event.target as HTMLInputElement).value)" />
    <span v-if="text">{{ text }}</span>
  </label>
</template>

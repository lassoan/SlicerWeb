<script setup lang="ts">
// ctkColorPickerButton. color: "#rrggbb"
withDefaults(defineProps<{ color?: string; text?: string; enabled?: boolean }>(), { color: "#ffffff", text: "", enabled: true });
const emit = defineEmits<{ colorChanged: [string] }>();
</script>

<template>
  <label class="sw-colorpicker inline-flex cursor-pointer items-center gap-2 text-[13px]" :class="{ 'pointer-events-none opacity-40': !enabled }">
    <input type="color" class="h-6 w-8 cursor-pointer rounded border border-input bg-transparent p-0" :value="color"
      @input="emit('colorChanged', ($event.target as HTMLInputElement).value)" />
    <span v-if="text">{{ text }}</span>
  </label>
</template>

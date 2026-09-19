<script setup lang="ts">
// QGroupBox (optionally checkable)
withDefaults(defineProps<{ title?: string; checkable?: boolean; checked?: boolean }>(), { title: "", checkable: false, checked: true });
const emit = defineEmits<{ toggled: [boolean] }>();
</script>

<template>
  <fieldset class="sw-groupbox rounded-md border border-input/70 px-2 pt-1 pb-2">
    <legend class="px-1 text-[12px] text-muted-foreground">
      <label v-if="checkable" class="inline-flex items-center gap-1.5">
        <input type="checkbox" class="accent-highlight" :checked="checked" @change="emit('toggled', ($event.target as HTMLInputElement).checked)" />
        {{ title }}
      </label>
      <template v-else>{{ title }}</template>
    </legend>
    <div class="flex flex-col gap-1.5" :class="{ 'pointer-events-none opacity-40': checkable && !checked }"><slot /></div>
  </fieldset>
</template>

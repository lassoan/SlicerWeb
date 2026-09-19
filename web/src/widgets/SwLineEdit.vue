<script setup lang="ts">
// QLineEdit
withDefaults(defineProps<{ text?: string; placeholderText?: string; readOnly?: boolean; enabled?: boolean }>(), {
  text: "",
  placeholderText: "",
  readOnly: false,
  enabled: true,
});
const emit = defineEmits<{ textChanged: [string]; editingFinished: [string] }>();
</script>

<template>
  <input type="text" class="sw-lineedit h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-40"
    :value="text" :placeholder="placeholderText" :readonly="readOnly" :disabled="!enabled"
    @input="emit('textChanged', ($event.target as HTMLInputElement).value)"
    @change="emit('editingFinished', ($event.target as HTMLInputElement).value)" />
</template>

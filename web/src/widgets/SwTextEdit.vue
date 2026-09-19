<script setup lang="ts">
// QTextEdit / QPlainTextEdit
withDefaults(defineProps<{ plainText?: string; readOnly?: boolean; placeholderText?: string }>(), {
  plainText: "",
  readOnly: false,
  placeholderText: "",
});
const emit = defineEmits<{ textChanged: [string] }>();
</script>

<template>
  <textarea class="sw-textedit min-h-[70px] w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
    :value="plainText" :readonly="readOnly" :placeholder="placeholderText"
    @input="emit('textChanged', ($event.target as HTMLTextAreaElement).value)" />
</template>

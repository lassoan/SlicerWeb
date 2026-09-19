<script setup lang="ts">
// QLabel (plain text or rich text)
withDefaults(defineProps<{ text?: string; wordWrap?: boolean; richText?: boolean }>(), { text: "", wordWrap: true, richText: false });
</script>

<template>
  <div class="sw-label text-[13px] text-foreground/90" :class="wordWrap ? 'break-words whitespace-normal' : 'truncate'">
    <span v-if="richText" v-html="text" />
    <span v-else>{{ text }}</span><slot />
  </div>
</template>

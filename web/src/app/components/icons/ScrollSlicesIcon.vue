<script setup lang="ts">
// Scroll mouse mode: a stack of slices, browsed up and down (Slicer's MouseScrollMode icon).
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 8.5 10 5 17 8.5 10 12Z" />
    <path d="M3 12.5 10 16 17 12.5" />
    <path d="M3 16.5 10 20 17 16.5" />
    <path d="M21 5v14" />
    <path d="m18.5 7.5 2.5-2.5 2.5 2.5" />
    <path d="m18.5 16.5 2.5 2.5 2.5-2.5" />
  </svg>
</template>

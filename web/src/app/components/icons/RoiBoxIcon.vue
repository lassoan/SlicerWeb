<script setup lang="ts">
// Region of interest markup: a box in space, with the handles that resize it.
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 8.5 14 8.5 14 19 4 19Z" />
    <path d="M4 8.5 8 5 20 5 20 15.5 14 19" />
    <path d="M14 8.5 20 5" />
    <rect x="2.6" y="7.1" width="2.8" height="2.8" fill="currentColor" stroke="none" />
    <rect x="12.6" y="17.6" width="2.8" height="2.8" fill="currentColor" stroke="none" />
    <rect x="18.6" y="3.6" width="2.8" height="2.8" fill="currentColor" stroke="none" />
  </svg>
</template>

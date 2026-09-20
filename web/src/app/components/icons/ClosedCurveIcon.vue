<script setup lang="ts">
// Closed curve markup: a curve through control points that comes back to where it started.
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 4c4 0 7 2.2 7 5.2 0 2.3-1.4 3.6-2.6 5-1.2 1.4-1.6 3.1-4.4 3.1s-3.2-1.7-4.4-3.1C6.4 12.8 5 11.5 5 9.2 5 6.2 8 4 12 4Z" />
    <circle cx="12" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="9.2" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="17.3" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="5" cy="9.2" r="1.6" fill="currentColor" stroke="none" />
  </svg>
</template>

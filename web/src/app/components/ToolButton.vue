<script setup lang="ts">
defineProps<{ label: string; active?: boolean; disabled?: boolean }>();
defineEmits<{ click: [MouseEvent] }>();
</script>

<template>
  <button
    type="button"
    :title="label"
    :aria-label="label"
    :aria-pressed="active"
    :disabled="disabled"
    class="inline-flex h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
    :class="active ? 'bg-highlight text-background' : 'text-foreground/85 hover:bg-accent hover:text-highlight'"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
</template>

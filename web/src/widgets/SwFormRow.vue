<script setup lang="ts">
// Row of a QFormLayout: label on the left, field on the right.
withDefaults(defineProps<{ label?: string }>(), { label: "" });
</script>

<template>
  <div class="sw-formrow grid grid-cols-[minmax(80px,38%)_1fr] items-center gap-2">
    <span class="truncate text-[12px] text-muted-foreground" :title="label">{{ label }}</span>
    <div class="min-w-0"><slot /></div>
  </div>
</template>

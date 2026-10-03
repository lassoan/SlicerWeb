<script setup lang="ts">
// What the application is busy with (activity.ts): downloading or loading data, over the views.
import { store } from "../store";
</script>

<template>
  <div v-if="store.activity" data-name="activity" role="status" aria-live="polite"
    class="pointer-events-none absolute left-1/2 top-3 z-40 w-[min(420px,calc(100%-24px))] -translate-x-1/2 rounded-lg border border-input bg-popover/95 px-3 py-2 shadow-xl">
    <div class="flex items-baseline gap-2 text-[13px]">
      <span class="min-w-0 flex-1 truncate text-foreground" data-name="activityMessage">{{ store.activity.message }}…</span>
      <span v-if="store.activity.fraction !== null" class="shrink-0 tabular-nums text-muted-foreground">
        {{ Math.round(store.activity.fraction * 100) }}%</span>
    </div>
    <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-input">
      <div v-if="store.activity.fraction !== null" class="h-full rounded-full bg-primary transition-[width] duration-200"
        data-name="activityBar" :style="{ width: Math.round(store.activity.fraction * 100) + '%' }" />
      <!-- how far along it is is not known: a bar that moves -->
      <div v-else class="sw-activity-indeterminate h-full w-1/3 rounded-full bg-primary" />
    </div>
    <div v-if="store.activity.detail" class="mt-1 truncate text-[11px] text-muted-foreground" data-name="activityDetail">{{ store.activity.detail }}</div>
  </div>
</template>

<style scoped>
.sw-activity-indeterminate {
  animation: sw-activity-slide 1.2s ease-in-out infinite;
}
@keyframes sw-activity-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(300%); }
}
</style>

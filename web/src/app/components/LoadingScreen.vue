<script setup lang="ts">
import { store } from "../store";
</script>

<template>
  <div class="flex h-full flex-col items-center justify-center gap-4 bg-background">
    <template v-if="store.status === 'error'">
      <div class="text-lg text-red-400">3D Slicer could not be started</div>
      <pre class="max-w-3xl overflow-auto rounded bg-card p-4 text-xs whitespace-pre-wrap text-muted-foreground">{{ store.error }}</pre>
    </template>
    <template v-else>
      <svg viewBox="0 0 32 32" class="h-14 w-14 animate-pulse" aria-hidden="true">
        <path d="M7 22 L16 6 L25 22 Z" fill="none" stroke="var(--color-primary-light)" stroke-width="2" />
        <circle cx="16" cy="17" r="3" fill="var(--color-primary)" />
      </svg>
      <div class="text-[15px] text-foreground">{{ store.progress.message }}…</div>
      <div class="h-1 w-72 overflow-hidden rounded bg-card">
        <div class="h-full bg-primary transition-all duration-300" :style="{ width: Math.round(store.progress.fraction * 100) + '%' }" />
      </div>
      <div class="text-[12px] text-muted-foreground">Python, VTK, ITK and 3D Slicer are running in your browser as WebAssembly.</div>
    </template>
  </div>
</template>

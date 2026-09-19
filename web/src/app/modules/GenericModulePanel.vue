<script setup lang="ts">
import type { ModuleSummary } from "../store";

defineProps<{ module?: ModuleSummary; name: string }>();
</script>

<template>
  <div class="flex flex-col gap-2 text-[13px]">
    <template v-if="module">
      <p class="text-muted-foreground">
        The <b class="text-foreground">{{ module.title }}</b> module is loaded: its logic is available from Python as
        <code class="rounded bg-card px-1">slicer.modules.{{ module.name.toLowerCase() }}.logic()</code>.
      </p>
      <div v-if="module.helpText" class="rounded-md bg-card/70 p-2 text-[12px] text-muted-foreground" v-html="module.helpText" />
    </template>
    <p v-else class="text-muted-foreground">Module {{ name }} is not available.</p>
  </div>
</template>

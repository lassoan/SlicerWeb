<script setup lang="ts">
import { store } from "../store";
</script>

<template>
  <div class="flex flex-col gap-2 text-[13px] text-muted-foreground">
    <p>The data of the scene is listed in the <b class="text-foreground">Data</b> panel on the left: load files by dragging them onto it,
      toggle visibility, rename (double-click), save or delete items.</p>
    <p>Supported formats include NRRD, NIfTI, MetaImage, DICOM series (load a folder), VTK/VTP, STL, OBJ, PLY, markups JSON,
      segmentations (.seg.nrrd), transforms (.tfm, .mat), tables (.tsv, .csv) and complete scenes (.mrb, .mrml).</p>
    <button v-if="!store.leftPanelOpen" type="button" class="self-start text-highlight underline" @click="store.leftPanelOpen = true">Show the Data panel</button>
  </div>
</template>

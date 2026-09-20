<script setup lang="ts">
// Scene Views module: store the scene as it is now, and put it back later.
import { inject, onBeforeUnmount, onMounted, ref } from "vue";
import type { SlicerBridge } from "@/core/bridge";

interface SceneView { id: string; name: string; description: string }

const bridge = inject<SlicerBridge>("bridge")!;
const views = ref<SceneView[]>([]);
const name = ref("");
const description = ref("");
const busy = ref(false);

async function refresh() {
  views.value = await bridge.call<SceneView[]>("sceneViews");
}

async function create() {
  busy.value = true;
  try {
    await bridge.call("createSceneView", [name.value || null, description.value]);
    name.value = "";
    description.value = "";
    await refresh();
  } finally {
    busy.value = false;
  }
}

async function restore(view: SceneView) {
  busy.value = true;
  try {
    await bridge.call("restoreSceneView", [view.id]);
  } finally {
    busy.value = false;
  }
}

async function remove(view: SceneView) {
  await bridge.call("removeNode", [view.id]);
  await refresh();
}

let off: (() => void) | undefined;
onMounted(() => {
  refresh();
  off = bridge.events.on("scene-changed", refresh);
});
onBeforeUnmount(() => off?.());
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="rounded-md bg-card/70 p-2">
      <div class="mb-1 text-[12px] text-muted-foreground">Store the scene as it is now.</div>
      <input v-model="name" placeholder="Name" class="mb-1 h-7 w-full rounded border border-input bg-background px-2 text-[13px] outline-none focus:border-primary" />
      <input v-model="description" placeholder="Description" class="mb-1 h-7 w-full rounded border border-input bg-background px-2 text-[13px] outline-none focus:border-primary" />
      <button type="button" class="rounded bg-primary px-3 py-1 text-[13px] text-primary-foreground hover:bg-primary/85 disabled:opacity-40"
        :disabled="busy" @click="create">Create scene view</button>
    </div>
    <div class="rounded-md border border-input/60">
      <div v-for="v in views" :key="v.id" class="flex items-center gap-2 border-b border-input/30 px-2 py-1.5 text-[13px] last:border-b-0">
        <div class="min-w-0 flex-1">
          <div class="truncate">{{ v.name }}</div>
          <div v-if="v.description" class="truncate text-[11px] text-muted-foreground">{{ v.description }}</div>
        </div>
        <button type="button" class="shrink-0 rounded bg-secondary/60 px-2 py-1 text-[12px] hover:bg-secondary disabled:opacity-40"
          :disabled="busy" @click="restore(v)">Restore</button>
        <button type="button" class="shrink-0 rounded px-2 py-1 text-[12px] text-muted-foreground hover:text-destructive-foreground"
          @click="remove(v)">Delete</button>
      </div>
      <div v-if="!views.length" class="p-2 text-[12px] text-muted-foreground">No scene view yet.</div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Scene Views module: store the scene as it is now, and put it back later.
import { inject, onBeforeUnmount, onMounted, ref } from "vue";
import { Download, Trash2 } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { captureView } from "../captureView";
import { store } from "../store";

interface SceneView { id: string; name: string; description: string; thumbnail: string | null }

const bridge = inject<SlicerBridge>("bridge")!;
const views = ref<SceneView[]>([]);
const name = ref("");
const description = ref("");
const busy = ref(false);

async function refresh() {
  views.value = await bridge.call<SceneView[]>("sceneViews");
}

/** A small picture of the view the user is looking at, kept with the scene view. */
async function thumbnail(): Promise<string | null> {
  const layoutName = store.activeView || store.layout.maximized || "1";
  const blob = await captureView(bridge, layoutName).catch(() => null);
  if (!blob) return null;
  const image = await createImageBitmap(blob);
  const width = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, Math.round((image.height / image.width) * width));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function create() {
  busy.value = true;
  try {
    await bridge.call("createSceneView", [name.value || null, description.value, await thumbnail()]);
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

/** Save a picture of the view as a file, which the toolbar used to do. */
async function savePicture() {
  const layoutName = store.activeView || store.layout.maximized || "1";
  const image = await captureView(bridge, layoutName);
  if (!image) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(image);
  link.download = `Slicer-${layoutName}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
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
      <div class="flex items-center gap-1">
        <button type="button" class="rounded bg-primary px-3 py-1 text-[13px] text-primary-foreground hover:bg-primary/85 disabled:opacity-40"
          :disabled="busy" data-name="create" @click="create">Create scene view</button>
        <button type="button" class="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-muted-foreground hover:text-highlight"
          title="Save a picture of the view as a file" data-name="savePicture" @click="savePicture">
          <Download :size="14" />Save picture
        </button>
      </div>
    </div>
    <div class="rounded-md border border-input/60">
      <div v-for="v in views" :key="v.id" :data-name="'sceneView:' + v.name"
        class="group flex items-center gap-2 border-b border-input/30 last:border-b-0">
        <button type="button" class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px] hover:bg-accent/50 disabled:opacity-40"
          :disabled="busy" :title="'Put the scene back as ' + v.name + ' holds it'" data-name="restore" @click="restore(v)">
          <img v-if="v.thumbnail" :src="v.thumbnail" alt="" class="h-10 w-14 shrink-0 rounded border border-input/60 object-cover" />
          <span v-else class="flex h-10 w-14 shrink-0 items-center justify-center rounded border border-input/60 text-[10px] text-muted-foreground">
            no view
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate">{{ v.name }}</span>
            <span v-if="v.description" class="block truncate text-[11px] text-muted-foreground">{{ v.description }}</span>
          </span>
        </button>
        <button type="button" class="mr-1 shrink-0 rounded p-1 text-muted-foreground hover:text-destructive-foreground"
          title="Delete this scene view" data-name="delete" @click="remove(v)"><Trash2 :size="15" /></button>
      </div>
      <div v-if="!views.length" class="p-2 text-[12px] text-muted-foreground">No scene view yet.</div>
    </div>
  </div>
</template>

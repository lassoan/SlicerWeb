<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";
import type { SlicerBridge } from "@/core/bridge";
import { store } from "../store";

/** `anchor`: the button that opened the list; the list hangs under it. */
const props = defineProps<{ anchor?: HTMLElement | null }>();
const emit = defineEmits<{ close: [] }>();
const bridge = inject<SlicerBridge>("bridge")!;

// The list is put at the end of the page, as PopupMenu puts its menus: the toolbar scrolls
// sideways (it is what tells it to fold its buttons into menus), and what scrolls clips what
// hangs out of it - the list was cut off at the toolbar's edge.
const width = 256;
const position = ref({ top: 56, left: 8 });
function place() {
  const trigger = props.anchor?.getBoundingClientRect();
  position.value = {
    top: Math.round(trigger ? trigger.bottom + 4 : 56),
    left: Math.round(Math.min(Math.max(8, trigger?.left ?? 8), window.innerWidth - width - 8)),
  };
}

// Common Slicer layouts first, then all others
const common = ["FourUp", "Conventional", "OneUp3D", "OneUpRedSlice", "OneUpYellowSlice", "OneUpGreenSlice",
  "ThreeByThreeSlice", "SideBySide", "Dual3D", "Triple3DEndoscopy", "ConventionalWidescreen", "FourUpTable",
  "FourByThreeSlice"];
const layouts = computed(() => {
  const names = Object.keys(store.availableLayouts);
  return [...common.filter((n) => names.includes(n)), ...names.filter((n) => !common.includes(n))];
});

/** What a layout is called: its name with the words parted, and "3D" left whole.
 *
 * The names come from vtkMRMLLayoutNode (Dual3D, OneUp3D, Triple3DEndoscopy, 3DTable, ...), so a
 * digit begins a word and an upper case letter after one does not - parting those gave "Dual3 D".
 */
function label(name: string) {
  return name
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")     // Dual3D -> Dual 3D, FourUp -> Four Up
    .replace(/([A-Z0-9])([A-Z][a-z])/g, "$1 $2") // 3DEndoscopy -> 3D Endoscopy
    .replace("One Up", "1-up")
    .replace("Four Up", "Four-up")
    .replace("Three D", "3D");
}

async function select(name: string) {
  await bridge.call("setLayout", [name]);
  emit("close");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => {
  place();
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", place);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", place);
});
</script>

<template>
  <Teleport to="body">
  <div class="fixed inset-0 z-[55]" @click="emit('close')" />
  <div class="fixed z-[56] max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-input bg-popover p-1 shadow-xl" data-name="layoutMenu"
    :style="{ top: position.top + 'px', left: position.left + 'px' }">
    <!-- Where the toolbar is too narrow to hold them, what is done to the views - framing them
         again, the crosshair - is offered at the top, above the arrangements themselves. -->
    <template v-if="$slots.views">
      <div class="mb-1 border-b border-input pb-1">
        <div class="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Views</div>
        <slot name="views" :close="() => emit('close')" />
      </div>
    </template>
    <div class="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Layouts</div>
    <button v-for="name in layouts" :key="name" type="button" data-name="layoutItem"
      class="block w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent"
      :class="store.layout.layout === store.availableLayouts[name] ? 'text-highlight' : 'text-foreground'"
      @click="select(name)">
      {{ label(name) }}
    </button>
  </div>
  </Teleport>
</template>

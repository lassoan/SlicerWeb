<script setup lang="ts">
// A toolbar button that opens a menu of tools, for groups that do not fit a phone's toolbar.
//
// The menu is put at the end of the page and placed under its button, rather than inside the
// toolbar: the toolbar scrolls sideways on a narrow screen, and anything inside it is cut off at its
// edges - which is why the menus could not be used on a phone.
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronDown } from "@lucide/vue";
import ToolButton from "./ToolButton.vue";

const props = withDefaults(defineProps<{ label: string; active?: boolean; align?: "left" | "right" }>(), {
  active: false,
  align: "left",
});
const open = ref(false);
const root = ref<HTMLElement>();
const menu = ref<HTMLElement>();
const position = ref({ top: 0, left: 0 });

function place() {
  const button = root.value?.getBoundingClientRect();
  if (!button) return;
  const width = menu.value?.offsetWidth ?? 176;
  const left = props.align === "right" ? button.right - width : button.left;
  position.value = {
    top: Math.round(button.bottom + 4),
    left: Math.round(Math.min(Math.max(4, left), window.innerWidth - width - 4)),
  };
}

async function toggle() {
  open.value = !open.value;
  if (!open.value) return;
  place();
  requestAnimationFrame(place); // again once the menu has its width
}

function onPointerDown(event: PointerEvent) {
  if (!open.value) return;
  const target = event.target as Node;
  if (!root.value?.contains(target) && !menu.value?.contains(target)) open.value = false;
}
function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", place);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", place);
});
</script>

<template>
  <div ref="root" class="relative shrink-0">
    <ToolButton :label="label" :active="active || open" @click="toggle">
      <slot name="button" />
      <ChevronDown :size="11" class="-mr-1 opacity-70" />
    </ToolButton>
    <Teleport to="body">
      <div v-if="open" ref="menu" class="fixed z-50 min-w-44 rounded-lg border border-input bg-popover p-1 shadow-xl"
        :style="{ top: position.top + 'px', left: position.left + 'px' }" role="menu" @click="open = false">
        <slot />
      </div>
    </Teleport>
  </div>
</template>

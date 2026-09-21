<script setup lang="ts">
// A menu that opens under whatever opens it.
//
// The menu itself is put at the end of the page rather than beside its trigger: a toolbar scrolls
// sideways on a narrow screen and a viewport clips what it holds, so a menu inside either of them
// would be cut off at its edges.
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = withDefaults(defineProps<{ align?: "left" | "right" }>(), { align: "left" });
const open = ref(false);
const root = ref<HTMLElement>();
const menu = ref<HTMLElement>();
const position = ref({ top: 0, left: 0 });

function place() {
  const trigger = root.value?.getBoundingClientRect();
  if (!trigger) return;
  const width = menu.value?.offsetWidth ?? 176;
  const left = props.align === "right" ? trigger.right - width : trigger.left;
  position.value = {
    top: Math.round(trigger.bottom + 4),
    left: Math.round(Math.min(Math.max(4, left), window.innerWidth - width - 4)),
  };
}

function toggle() {
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

defineExpose({ close: () => (open.value = false) });
</script>

<template>
  <div ref="root" class="relative shrink-0">
    <slot name="trigger" :open="open" :toggle="toggle" />
    <Teleport to="body">
      <div v-if="open" ref="menu" class="fixed z-50 min-w-44 rounded-lg border border-input bg-popover p-1 shadow-xl"
        :style="{ top: position.top + 'px', left: position.left + 'px' }" role="menu" @click="open = false">
        <slot />
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
// QPushButton / QToolButton
const props = withDefaults(
  defineProps<{ text?: string; toolTip?: string; checkable?: boolean; checked?: boolean; enabled?: boolean; primary?: boolean }>(),
  { text: "", toolTip: "", checkable: false, checked: false, enabled: true, primary: false },
);
const emit = defineEmits<{ clicked: [boolean]; toggled: [boolean] }>();

function click() {
  if (props.checkable) {
    emit("toggled", !props.checked);
    emit("clicked", !props.checked);
  } else {
    emit("clicked", false);
  }
}
</script>

<template>
  <button type="button" :title="toolTip" :disabled="!enabled"
    class="sw-button inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] transition-colors disabled:opacity-40"
    :class="primary || (checkable && checked)
      ? 'bg-primary text-primary-foreground hover:bg-primary/85'
      : 'bg-secondary/60 text-secondary-foreground hover:bg-secondary'"
    @click="click">
    <slot />{{ text }}
  </button>
</template>

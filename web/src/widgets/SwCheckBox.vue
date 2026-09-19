<script setup lang="ts">
// QCheckBox
withDefaults(defineProps<{ text?: string; checked?: boolean; enabled?: boolean; toolTip?: string }>(), {
  text: "",
  checked: false,
  enabled: true,
  toolTip: "",
});
const emit = defineEmits<{ toggled: [boolean]; stateChanged: [number] }>();

function change(e: Event) {
  const v = (e.target as HTMLInputElement).checked;
  emit("toggled", v);
  emit("stateChanged", v ? 2 : 0);
}
</script>

<template>
  <label class="sw-checkbox inline-flex cursor-pointer items-center gap-2 text-[13px] text-foreground" :title="toolTip"
    :class="{ 'pointer-events-none opacity-40': !enabled }">
    <input type="checkbox" class="h-3.5 w-3.5 accent-highlight" :checked="checked" @change="change" />
    <span v-if="text">{{ text }}</span>
  </label>
</template>

<script setup lang="ts">
// QPushButton / QToolButton, and ctkCheckablePushButton when checkBoxVisible is set: the check box
// is a separate control inside the button (e.g. "Apply" with auto-update), so clicking the check box
// switches the option and clicking the rest of the button runs the action.
const props = withDefaults(
  defineProps<{
    text?: string;
    toolTip?: string;
    checkable?: boolean;
    checked?: boolean;
    enabled?: boolean;
    primary?: boolean;
    icon?: string;
    iconSize?: number;
    checkBoxVisible?: boolean;
    checkBoxChecked?: boolean;
    checkBoxToolTip?: string;
  }>(),
  {
    text: "",
    toolTip: "",
    checkable: false,
    checked: false,
    enabled: true,
    primary: false,
    icon: "",
    iconSize: 16,
    checkBoxVisible: false,
    checkBoxChecked: false,
    checkBoxToolTip: "",
  },
);
const emit = defineEmits<{ clicked: [boolean]; toggled: [boolean]; checkBoxToggled: [boolean] }>();

function click() {
  if (props.checkable) {
    emit("toggled", !props.checked);
    emit("clicked", !props.checked);
  } else {
    emit("clicked", false);
  }
}

function toggleCheckBox() {
  if (!props.enabled) return;
  emit("checkBoxToggled", !props.checkBoxChecked);
}
</script>

<template>
  <button type="button" :title="toolTip" :disabled="!enabled"
    class="sw-button inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md px-3 py-0.5 text-[13px] leading-tight transition-colors disabled:opacity-40"
    :class="[
      text ? '' : 'px-1.5',
      primary || (checkable && checked)
        ? 'bg-primary text-primary-foreground hover:bg-primary/85'
        : 'bg-secondary/60 text-secondary-foreground hover:bg-secondary',
    ]"
    @click="click">
    <!-- ctkCheckablePushButton check box: large enough to hit with a finger -->
    <span v-if="checkBoxVisible" role="checkbox" :aria-checked="checkBoxChecked" :title="checkBoxToolTip || toolTip"
      class="sw-button-checkbox -ml-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border"
      :class="checkBoxChecked ? 'border-primary bg-primary text-primary-foreground' : 'border-current/50'"
      @click.stop="toggleCheckBox">
      <svg v-if="checkBoxChecked" viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M3 8.5l3.5 3.5L13 4.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
    <img v-if="icon" :src="icon" alt="" class="shrink-0 object-contain" :style="{ width: iconSize + 'px', height: iconSize + 'px' }" />
    <slot />{{ text }}
  </button>
</template>

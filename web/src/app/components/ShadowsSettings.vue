<script setup lang="ts">
// The "Shadows" menu of Slicer's 3D view controller (qMRMLThreeDViewControllerWidget), shown in the view's menu:
// ambient shadows (screen-space ambient occlusion) on or off, and how they look. The settings are on the view node;
// linked 3D views follow.
import { inject, onMounted, ref } from "vue";
import { ChevronDown, ChevronRight } from "@lucide/vue";
import type { SlicerBridge } from "@/core/bridge";
import { SwSlider } from "@/widgets";

const props = defineProps<{ layoutName: string }>();
const bridge = inject<SlicerBridge>("bridge")!;

interface ShadowSettings {
  shadowsVisibility: boolean;
  ambientShadowsSizeScale: number;
  ambientShadowsVolumeOpacityThreshold: number;
  ambientShadowsIntensityScale: number;
  ambientShadowsIntensityShift: number;
}
const settings = ref<ShadowSettings | null>(null);
// Defaults of desktop Slicer's "Reset settings to default" (application settings Default3DView/AmbientShadows*)
const DEFAULTS = { ambientShadowsSizeScale: 0.0, ambientShadowsVolumeOpacityThreshold: 0.0, ambientShadowsIntensityScale: 1.0, ambientShadowsIntensityShift: 0.0 };

async function refresh() {
  settings.value = await bridge.call<ShadowSettings | null>("viewControllerInfo", [props.layoutName]).catch(() => null);
}
async function set(properties: Partial<ShadowSettings>) {
  if (settings.value) Object.assign(settings.value, properties);
  await bridge.call("setViewControllerProperties", [props.layoutName, properties]);
  await refresh();
}
// The settings are shown only on request: they are not often changed
const expanded = ref(false);
onMounted(refresh);
</script>

<template>
  <!-- the menu stays open while these are used -->
  <div v-if="settings" class="w-64 text-[13px]" data-name="shadowsSettings" @click.stop>
    <div class="flex items-center rounded hover:bg-accent/60">
      <label class="flex flex-1 cursor-pointer items-center gap-2 px-2 py-1.5" :class="settings.shadowsVisibility ? 'text-highlight' : ''"
        title="Make objects cast shadows to improve depth perception">
        <input type="checkbox" class="h-4 w-4" data-name="shadowsVisibility" :checked="settings.shadowsVisibility"
          @change="set({ shadowsVisibility: ($event.target as HTMLInputElement).checked })" />Shadows
      </label>
      <button type="button" data-name="shadowsExpand" class="px-2 py-1.5 text-muted-foreground hover:text-highlight"
        :title="expanded ? 'Hide shadow settings' : 'Shadow settings'" @click="expanded = !expanded">
        <ChevronDown v-if="expanded" :size="14" /><ChevronRight v-else :size="14" /></button>
    </div>
    <div v-if="expanded" class="px-1 pb-1">
      <div class="px-1 pt-1" title="Size of features to be emphasized by shadows. The scale is logarithmic, default (0.0) corresponds to object size of about 100mm.">
        Size scale
        <SwSlider data-name="ambientShadowsSizeScale" :value="settings.ambientShadowsSizeScale" :minimum="-3" :maximum="3" :single-step="0.01"
          :decimals="2" :enabled="settings.shadowsVisibility" @value-changed="set({ ambientShadowsSizeScale: $event })" />
      </div>
      <div class="px-1 pt-1" title="Volume rendering opacity above this will cast shadows.">
        Volume opacity threshold
        <SwSlider data-name="ambientShadowsVolumeOpacityThreshold" :value="settings.ambientShadowsVolumeOpacityThreshold * 100" :minimum="0"
          :maximum="100" :single-step="1" :decimals="0" suffix="%" :enabled="settings.shadowsVisibility"
          @value-changed="set({ ambientShadowsVolumeOpacityThreshold: $event * 0.01 })" />
      </div>
      <div class="px-1 pt-1" title="Intensity of darkening by shadows. Larger value means more darkening. Default is 1.">
        Intensity scale
        <SwSlider data-name="ambientShadowsIntensityScale" :value="settings.ambientShadowsIntensityScale" :minimum="0" :maximum="3" :single-step="0.01"
          :decimals="2" :enabled="settings.shadowsVisibility" @value-changed="set({ ambientShadowsIntensityScale: $event })" />
      </div>
      <div class="px-1 pt-1" title="Minimum amount of occlusion required for visible darkening by shadows. Larger value means more occlusion is needed to darkening. Default is 0.">
        Intensity shift
        <SwSlider data-name="ambientShadowsIntensityShift" :value="settings.ambientShadowsIntensityShift" :minimum="0" :maximum="1" :single-step="0.01"
          :decimals="2" :enabled="settings.shadowsVisibility" @value-changed="set({ ambientShadowsIntensityShift: $event })" />
      </div>
      <div class="my-1 border-t border-input" />
      <button type="button" role="menuitem" data-name="resetShadows" class="mt-1 w-full rounded px-1 py-1 text-left hover:bg-accent/60"
        @click="set(DEFAULTS)">Reset settings to default</button>
    </div>
  </div>
</template>

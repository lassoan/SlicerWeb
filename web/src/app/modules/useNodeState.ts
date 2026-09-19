import { inject, onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { SlicerBridge } from "@/core/bridge";

/**
 * Keeps the state of a module GUI in sync with MRML: calls a bridge method (e.g. "volumeInfo") for the
 * selected node and refreshes when the node, its display node, or the scene changes.
 */
export function useNodeState<T>(method: string, nodeID: Ref<string | null>) {
  const bridge = inject<SlicerBridge>("bridge")!;
  const state = ref<T | null>(null) as Ref<T | null>;
  let observed: string | null = null;
  let pending = false;

  async function refresh() {
    if (!nodeID.value) {
      state.value = null;
      return;
    }
    if (pending) return;
    pending = true;
    requestAnimationFrame(async () => {
      pending = false;
      try {
        state.value = nodeID.value ? await bridge.call<T>(method, [nodeID.value]) : null;
      } catch {
        state.value = null;
      }
    });
  }

  watch(
    nodeID,
    async (id) => {
      if (observed) await bridge.call("observeNode", [observed, false]).catch(() => {});
      observed = id;
      if (id) await bridge.call("observeNode", [id, true]).catch(() => {});
      refresh();
    },
    { immediate: true },
  );

  const offs = [
    bridge.events.on<{ id: string }>("node-modified", (p) => p?.id === nodeID.value && refresh()),
    bridge.events.on("scene-changed", refresh),
  ];
  onBeforeUnmount(() => {
    offs.forEach((off) => off());
    if (observed) bridge.call("observeNode", [observed, false]).catch(() => {});
  });

  return { state, refresh, bridge };
}

import { inject, onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { SlicerBridge } from "@/core/bridge";

/**
 * Keeps the state of a module GUI in sync with MRML: calls a bridge method (e.g. "volumeInfo") for the
 * selected node and refreshes when the node, its display node, or the scene changes.
 */
export function useNodeState<T>(method: string, nodeID: Ref<string | null>) {
  const bridge = inject<SlicerBridge>("bridge")!;
  const state = ref<T | null>(null) as Ref<T | null>;
  /** What went wrong the last time the state was read, for the panel to show. */
  const error = ref("");
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
        error.value = "";
      } catch (e: any) {
        // Keep what the panel is showing. A reading that fails - the node has gone, say, or the
        // application was busy - used to leave the panel with nothing in it but its node selector.
        error.value = e?.message ?? String(e);
        console.error(`${method} could not be read`, e);
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

  return { state, error, refresh, bridge };
}

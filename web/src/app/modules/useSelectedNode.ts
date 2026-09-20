import { ref, watch, type Ref } from "vue";
import { store } from "../store";

/**
 * The node a module panel is showing, kept in step with the selection of the application.
 *
 * Picking a node in the subject hierarchy opens the module that node belongs to and selects it
 * there, also when that module is already the one on screen (the panel stays as it is and follows
 * the selection). Choosing a node in the panel itself makes it the selection, so that the tree
 * shows the same node as the module.
 */
export function useSelectedNode(className?: string): Ref<string | null> {
  const nodeID = ref<string | null>(store.selectedNodeID);

  watch(
    () => store.selectedNodeID,
    (id) => {
      if (!id || id === nodeID.value) return;
      // Nodes of another kind belong to another panel; this one keeps what it has.
      if (className && !(store.selectedNodeClass ?? "").includes(className)) return;
      nodeID.value = id;
    },
  );
  watch(nodeID, (id) => {
    if (id) store.selectedNodeID = id;
  });

  return nodeID;
}

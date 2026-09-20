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
  const matches = (cls: string | null | undefined) => !className || (cls ?? "").includes(className);
  // Only a selection of the kind this panel shows: the node picked in another module is not one of
  // its own (a text node opened in Texts must not become the table of the Tables panel).
  const nodeID = ref<string | null>(matches(store.selectedNodeClass) ? store.selectedNodeID : null);

  watch(
    () => store.selectedNodeID,
    (id) => {
      if (!id || id === nodeID.value) return;
      // Nodes of another kind belong to another panel; this one keeps what it has.
      if (!matches(store.selectedNodeClass)) return;
      nodeID.value = id;
    },
  );
  watch(nodeID, (id) => {
    if (!id) return;
    store.selectedNodeID = id;
    if (className) store.selectedNodeClass = "vtkMRML" + className + "Node";
  });

  return nodeID;
}

/** The modules the panel can show, and their titles: shared by the title bar and the finder. */
import { computed } from "vue";
import { store, type ModuleSummary } from "../store";
import { modulePanels } from "./index";

/** Web GUIs that are not tied to a loadable module name. */
export const webOnlyModules: ModuleSummary[] = [
  { name: "SegmentEditor", title: "Segment Editor", categories: ["Segmentation"], kind: "scripted",
    helpText: "Edit the segments of a segmentation with the paint, draw, erase and threshold effects.",
    dependencies: [], hidden: false, acknowledgementText: "", contributors: [], webWidget: null, icon: null },
  { name: "Data", title: "Data", categories: ["Informatics"], kind: "loadable",
    helpText: "The nodes of the scene, as a subject hierarchy tree.",
    dependencies: [], hidden: false, acknowledgementText: "", contributors: [], webWidget: null, icon: null },
];

/** Every module that can be opened, by title. */
export const moduleList = computed<ModuleSummary[]>(() => {
  // Hidden modules are left out, unless this application has a GUI for one (Terminologies is
  // hidden in desktop Slicer, which has no panel for it)
  const list = store.modules.filter((m) => !m.hidden || m.name in modulePanels).slice();
  for (const w of webOnlyModules) {
    if (!list.some((m) => m.name === w.name)) {
      list.push(w);
    }
  }
  return list.sort((a, b) => a.title.localeCompare(b.title));
});

/** The title a module is known by; its name if it is not one of the modules that are loaded. */
export function moduleTitle(name: string): string {
  return store.modules.find((m) => m.name === name)?.title
    ?? webOnlyModules.find((w) => w.name === name)?.title
    ?? name;
}

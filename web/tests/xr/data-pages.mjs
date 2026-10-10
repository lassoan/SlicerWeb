// The pages of the Data category's tree: a page that starts within a branch shows, as its first
// rows, the items that branch is in - its parent, theirs, to the top - and then its own items, as
// many as fit (7 rows in all). The left controller's thumbstick goes by these pages: left and right
// keep the row, down past a page's last item goes to the next page, up from a page's first item
// to the parent shown above it, on the same page. Against the stand-in for WebXR (xr-mock.js).
//
// Usage: node tests/xr/data-pages.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=&layout=OneUp3D&layers";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const python = (e, mode = "eval") => page.evaluate(([e, mode]) => window.slicerWeb.bridge.evalPython(e, mode), [e, mode]);
let time = 0;
const frames = (count) => page.evaluate(({ count, start }) => {
  for (let i = 0; i < count; i++) window.__xrMock.frame(start + i * 14);
}, { count, start: (time += count * 14) });
const stick = async (x, y) => {
  await page.evaluate(([x, y]) => (window.__xrMock.controller.gamepad.axes = [0, 0, x, y]), [x, y]);
  await frames(3);
  await page.evaluate(() => (window.__xrMock.controller.gamepad.axes = [0, 0, 0, 0]));
  await frames(1);
};
/** The page shown: its rows' names, and which is chosen. */
const shown = () => page.evaluate(() => {
  const p = window.slicerXR.session.panel;
  const rows = p.buttons.filter((b) => b.treeRow && b.id?.startsWith("row:")).map((b) => b.treeRow.name);
  const chosen = p.dataItems.find((i) => i.id === p.selectedItem)?.name ?? null;
  return { page: p.dataPage, pages: p.dataPages, rows, chosen };
});

await page.goto(url);
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
// The tree: Body / Chest (12 models) / Ribs (3 models), and a model at the top after them
await python([
  "import slicer, vtk",
  "sh = slicer.mrmlScene.GetSubjectHierarchyNode()",
  "body = sh.CreateFolderItem(sh.GetSceneItemID(), 'Body')",
  "chest = sh.CreateFolderItem(body, 'Chest')",
  "def model(name, parent):",
  "    s = vtk.vtkSphereSource()",
  "    s.SetRadius(5)",
  "    s.Update()",
  "    m = slicer.modules.models.logic().AddModel(s.GetOutput())",
  "    m.SetName(name)",
  "    sh.SetItemParent(sh.GetItemByDataNode(m), parent)",
  "for i in range(12):",
  "    model(f'Organ {i + 1}', chest)",
  "ribs = sh.CreateFolderItem(chest, 'Ribs')",
  "for i in range(3):",
  "    model(f'Rib {i + 1}', ribs)",
  "model('Table', sh.GetSceneItemID())",
].join("\n"), "exec");
await page.evaluate(() => (window.__xrMock.controller.handedness = "left"));
await page.waitForFunction(() => !document.querySelector("#slicer-xr button.vr").disabled, null, { timeout: 60000 });
await page.locator("#slicer-xr button.vr").click();
await page.waitForFunction(() => window.__xrMock.callbacks.length > 0, null, { timeout: 60000 });
await frames(4);
await page.evaluate(() => {
  window.slicerXR.session.panel.setCategory("data");
  window.slicerXR.session.refreshDataItems(true);
});
await frames(2);

let s = await shown();
console.log(`  page 1: ${s.rows.join(", ")}`);
check(s.rows.length === 7 && s.rows[0] === "Body" && s.rows[1] === "Chest", "the first page starts at the top of the tree");
await stick(1, 0);
s = await shown();
console.log(`  page 2: ${s.rows.join(", ")}`);
check(s.rows[0] === "Body" && s.rows[1] === "Chest" && s.rows[2] === "Organ 6" && s.rows.length === 7,
  "the second page starts within Chest: Body and Chest above, then its own items (7 rows in all)");
check(s.chosen === "Body", "pushed right with nothing chosen, its first row is chosen");
const pages = [s];
while (s.page < s.pages - 1) {
  await stick(1, 0);
  s = await shown();
  pages.push(s);
  console.log(`  page ${s.page + 1}: ${s.rows.join(", ")}`);
}
const ribsPage = pages.find((q) => q.rows.includes("Rib 1") && q.rows.indexOf("Rib 1") > 0 && q.rows[0] === "Body");
check(!!ribsPage && (ribsPage.rows.indexOf("Ribs") < ribsPage.rows.indexOf("Rib 1")), "a page that starts within Ribs shows Body, Chest and Ribs above");
const last = pages[pages.length - 1];
check(last.rows.includes("Table"), "the last page has the model at the top of the tree");
// Every item is the own item of exactly one page
const own = await page.evaluate(() => window.slicerXR.session.panel.dataPageTable().flatMap((q) => q.own));
const count = await page.evaluate(() => window.slicerXR.session.panel.dataItems.length);
check(own.length === count && new Set(own).size === count, `every item is listed as a page's own once (${count} items, ${pages.length + 1} pages)`);

// Back to the second page; up from its first own item: Chest, shown above, on the same page
while ((await shown()).page > 1) await stick(-1, 0);
s = await shown();
check(s.page === 1 && s.chosen === "Body", "left again to the second page, the first row chosen (the row kept)");
await stick(0, 1);
await stick(0, 1);
s = await shown();
check(s.chosen === "Organ 6" && s.page === 1, "down twice: past Chest to the page's first own item, Organ 6");
await stick(0, -1);
s = await shown();
check(s.chosen === "Chest" && s.page === 1, "up: Chest, which the page shows above, on the same page");
await stick(0, 1);
for (let i = 0; i < 5; i++) await stick(0, 1);
s = await shown();
check(s.page === 2 && s.chosen === "Organ 11", "down past the page's last item: the next page");
await browser.close();
process.exit(failed ? 1 : 0);

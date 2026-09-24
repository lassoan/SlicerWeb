// The "..." menu of the Subject hierarchy title line: "Create new folder" asks for a name and adds a
// folder at the top of the hierarchy, which the tree shows at once. Cancelling adds nothing.
// Usage: node tests/subject-hierarchy-folder.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const folders = () => py(`(lambda sh: (lambda ids: (sh.GetItemChildren(sh.GetSceneItemID(), ids, True), ",".join(sh.GetItemName(ids.GetId(i)) for i in range(ids.GetNumberOfIds()) if sh.GetItemLevel(ids.GetId(i)) == "Folder"))[1])(__import__("vtk").vtkIdList()))(slicer.vtkMRMLSubjectHierarchyNode.GetSubjectHierarchyNode(slicer.mrmlScene))`);

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(2000);

let answer = "Planning";
page.on("dialog", (dialog) => (answer === null ? dialog.dismiss() : dialog.accept(answer)));
const createFolder = async () => {
  await page.locator("[data-name='subjectHierarchyMenu']").click();
  await page.locator("[data-name='menu:createFolder']").click();
  await page.waitForTimeout(800);
};

check("the title line has a ... button", await page.locator("[data-name='subjectHierarchyMenu']").count(), 1);
await createFolder();
check("a folder named as asked", await folders(), "Planning");
check("shown in the tree at once", await page.evaluate(() => window.slicerWeb.store.subjectHierarchy.some((i) => i.name === "Planning")), true);
await createFolder();
check("a second one of the same name is made unique", (await folders()).split(",").length, 2);
answer = null;
await createFolder();
check("cancelled: nothing added", (await folders()).split(",").length, 2);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

// Segment Editor on a phone: Paint is chosen in the module panel, and the panel is closed to see the
// image - Paint stays at work: the mouse mode button shows it, and a finger dragged in a slice view
// paints. Choosing another mouse mode ends it, and so does opening another module.
// Usage: node tests/segment-editor-phone.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.dismiss());
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^['"]|['"]$/g, "");
const effect = () => page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorState").then((s) => s.effect ?? null));
const painted = () => py(`sum(int((__import__("vtk.util.numpy_support", fromlist=["x"]).vtk_to_numpy(r.GetPointData().GetScalars()) > 0).sum())
  for n in slicer.util.getNodesByClass("vtkMRMLSegmentationNode") for s in n.GetSegmentation().GetSegmentIDs()
  for r in [n.GetSegmentation().GetSegment(s).GetRepresentation("Binary labelmap")] if r and r.GetPointData().GetScalars())`);

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(2000);

// the Segment Editor in its panel: a segment, and Paint
await page.evaluate(() => {
  window.slicerWeb.store.activeModule = "SegmentEditor";
  window.slicerWeb.store.rightPanelOpen = true;
});
await page.waitForTimeout(2500);
const panel = page.locator(".sw-panel-scroll").last();
await panel.locator("button", { hasText: /^Add$/ }).first().tap();
await page.waitForTimeout(1500);
await panel.getByRole("button", { name: "Paint", exact: true }).first().tap();
await page.waitForTimeout(800);
check("Paint is chosen", await effect(), "Paint");

// the panel closed, to see the image
await page.locator("[title='Collapse panel']").last().tap();
await page.waitForTimeout(1000);
check("the panel is closed", await page.evaluate(() => window.slicerWeb.store.rightPanelOpen), false);
check("Paint is still at work", await effect(), "Paint");
check("the mouse mode button shows it", await page.getByRole("button", { name: "Mouse mode" }).first().evaluate(
  (b) => !!b.querySelector("svg.lucide-brush") || /brush/i.test(b.innerHTML)), true);
await page.getByRole("button", { name: "Mouse mode" }).first().tap();
await page.waitForTimeout(400);
check("the mouse mode menu lists it as the current mode",
  await page.locator("[data-name=segmentEditMode]").first().innerText().catch(() => ""), (t) => /Paint/.test(t));
await page.keyboard.press("Escape");
await page.mouse.click(5, 5).catch(() => {});
await page.waitForTimeout(300);

// a finger dragged in the red slice view paints
const box = await page.locator("#slicer-view-Red").boundingBox();
const cdp = await context.newCDPSession(page);
const touch = (x, y) => ({ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 });
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const before = Number(await painted());
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch(cx, cy)] });
await page.waitForTimeout(100);
for (let i = 1; i <= 10; i++) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touch(cx + i * 4, cy + i * 2)] });
  await page.waitForTimeout(50);
}
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(1500);
const after = Number(await painted());
check("a finger dragged in a slice view paints", after - before, (n) => n > 0);

// another mouse mode (to scroll the slices, say) does not end Paint: it waits meanwhile
const fingerDrag = async () => {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch(cx, cy)] });
  await page.waitForTimeout(100);
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touch(cx + i * 4, cy + i * 6)] });
    await page.waitForTimeout(50);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(1500);
};
const suspended = () => page.evaluate(() => window.slicerWeb.bridge.call("segmentEditorState").then((s) => s.suspended));
await page.getByRole("button", { name: "Mouse mode" }).first().tap();
await page.waitForTimeout(400);
await page.getByRole("menuitem", { name: "Scroll slices" }).tap();
await page.waitForTimeout(800);
check("choosing another mouse mode keeps Paint", await effect(), "Paint");
check("but suspended", await suspended(), true);
check("and that mode is the one in use", await page.evaluate(() => window.slicerWeb.store.interactionMode), "Scroll");
const offset = () => py(`str(round(slicer.app.layoutManager().sliceWidget("Red").sliceLogic().GetSliceOffset(), 2))`);
const [paintedBefore, offsetBefore] = [Number(await painted()), await offset()];
await fingerDrag();
check("a finger drag then scrolls the slices", await offset(), (o) => o !== offsetBefore);
check("and does not paint", Number(await painted()), paintedBefore);
await page.getByRole("button", { name: "Mouse mode" }).first().tap();
await page.waitForTimeout(400);
await page.locator("[data-name=segmentEditMode]").first().tap();
await page.waitForTimeout(800);
check("choosing Paint's mouse mode again resumes it", await suspended(), false);
await fingerDrag();
check("and a finger drag paints again", Number(await painted()), (n) => n > paintedBefore);

// opening another module ends it too, the panel being closed or not
await page.evaluate(() => { window.slicerWeb.store.rightPanelOpen = true; });
await page.waitForTimeout(1000);
await panel.getByRole("button", { name: "Paint", exact: true }).first().tap();
await page.waitForTimeout(800);
await page.evaluate(() => { window.slicerWeb.store.rightPanelOpen = false; });
await page.waitForTimeout(500);
check("Paint again, panel closed", await effect(), "Paint");
await page.evaluate(() => { window.slicerWeb.store.activeModule = "Data"; });
await page.waitForTimeout(1000);
check("opening another module ends it", await effect(), null);

check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

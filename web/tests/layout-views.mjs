// Every view of a layout gets the view it should have. The layouts share their cells: switching
// from one to another used to leave a cell holding the view it had before, because the cells were
// keyed by position, so in Dual 3D the first 3D view was drawn by a slice view left over from the
// layout before it.
// Usage: node tests/layout-views.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 200)));
await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(5000);

const text = async (expr) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr)).replace(/^['"]|['"]$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

/** What each view of the layout should be, and what the page and the application actually made. */
async function inspect() {
  const wanted = JSON.parse(await text(`
__import__("json").dumps({v["layoutName"]: v["kind"] for v in _layoutViews(slicer.app.layoutManager().layoutDescription())})`));
  const attached = JSON.parse(await text(`
__import__("json").dumps({name: view.GetClassName() for name, view in slicer.app.layoutManager().views().items()})`));
  const canvases = await page.evaluate(() => [...document.querySelectorAll("canvas")].map((c) => c.id.replace("slicer-view-", "")));
  return { wanted, attached, canvases };
}

// the views of a layout description, wherever they sit in it
await exec(`
def _layoutViews(node):
    if node.get("type") == "view":
        return [node]
    found = []
    for child in node.get("children") or []:
        found += _layoutViews(child)
    return found
import slicer
`);

const KIND_CLASS = { slice: "vtkSlicerWebSliceView", threeD: "vtkSlicerWebThreeDView" };

for (const layout of ["FourUp", "Dual3D", "Conventional", "OneUp3D", "TwoOverTwo", "FourUp"]) {
  await exec(`slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayout${layout}View)`);
  await page.waitForTimeout(2500);
  const { wanted, attached, canvases } = await inspect();
  const drawn = Object.entries(wanted).filter(([, kind]) => kind in KIND_CLASS);
  const missing = drawn.filter(([name]) => !canvases.includes(name)).map(([name]) => name);
  const unattached = drawn.filter(([name]) => !attached[name]).map(([name]) => name);
  const wrong = drawn.filter(([name, kind]) => attached[name] && attached[name] !== KIND_CLASS[kind])
    .map(([name, kind]) => `${name} wanted ${kind} but is ${attached[name]}`);
  check(`${layout}: every view has a canvas`, missing.length === 0, missing.join(", "));
  check(`${layout}: and a view of the application behind it`, unattached.length === 0, unattached.join(", "));
  check(`${layout}: of the right kind`, wrong.length === 0, wrong.join("; ") || Object.entries(wanted).map(([n, k]) => `${n}:${k}`).join(" "));
}

// The names in the layout menu: the words parted, and "3D" left whole (it read "Dual3 D" before).
await page.getByRole("button", { name: "Layout" }).first().click();
await page.waitForTimeout(600);
const names = (await page.locator("[data-name='layoutItem']").allInnerTexts()).map((t) => t.trim());
check("the layout menu lists the layouts", names.length > 5, `${names.length} of them`);
// The list is visible, not clipped by the toolbar it hangs from (the toolbar scrolls sideways,
// and what scrolls clips what hangs out of it): the last item can be seen and clicked.
const menuBox = await page.locator("[data-name='layoutMenu']").boundingBox();
const lastItem = await page.locator("[data-name='layoutItem']").nth(6).boundingBox();
check("and the list hangs under the toolbar, in view", !!menuBox && menuBox.y > 40 && menuBox.height > 200 && menuBox.y + menuBox.height <= page.viewportSize().height,
  menuBox ? `top ${Math.round(menuBox.y)} height ${Math.round(menuBox.height)}` : "no menu");
check("with its items clickable", !!lastItem && (await page.locator("[data-name='layoutItem']").nth(6).isVisible())
  && (await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute("data-name") === "layoutItem", [lastItem.x + 10, lastItem.y + lastItem.height / 2])), true);
check("named with 3D whole, not split after the digit",
  !names.some((n) => /\d\s+D/.test(n)), names.filter((n) => /3D/.test(n)).join(", "));

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

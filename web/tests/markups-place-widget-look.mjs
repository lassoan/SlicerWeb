// The color button and the Place button of markups place widgets, as desktop Slicer's place widget
// shows them: the color button the selected color of the node's display (and following it when it
// changes elsewhere; a color picked there is the node's), as tall as the Place and Delete buttons
// beside it, and the Place button the toolbar's icon of the node's kind of markup.
// Usage: node tests/markups-place-widget-look.mjs [url] ExtensionNames Module placeWidget:selector ... [screenshot.png]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const base = args[0] && /^https?:/.test(args[0]) ? args.shift() : "http://localhost:5173/";
const shot = args.find((a) => a.endsWith(".png"));
const [extensions, module, ...pairs] = args.filter((a) => !a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (m.type() === "error") console.log(`[error] ${m.text().slice(0, 300)}`); });
await page.goto(`${base}?sample=&extensions=${encodeURIComponent(extensions)}`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForFunction(async (m) => String(await window.slicerWeb.bridge.evalPython(
  `str(hasattr(slicer.modules, ${JSON.stringify(m.toLowerCase())}))`, "eval")).includes("True"), module, { timeout: 600000, polling: 2000 });
await page.evaluate((m) => window.slicerWeb.bridge.evalPython(`slicer.util.selectModule(${JSON.stringify(m)})`), module);
await page.waitForTimeout(3000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const ui = `slicer.util.getModuleWidget(${JSON.stringify(module)}).ui`;
let failed = false;
const check = (what, ok, detail) => { if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${detail}`); };
const hex = (rgb) => "#" + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

for (const pair of pairs) {
  const [w, s] = pair.split(":");
  // shown, with a node
  await py(`(getattr(${ui}, ${JSON.stringify(w)}).setVisible(True), getattr(${ui}, ${JSON.stringify(s)}).setVisible(True),
    getattr(${ui}, ${JSON.stringify(s)}).currentNode() or getattr(${ui}, ${JSON.stringify(s)}).setCurrentNode(
      slicer.mrmlScene.AddNewNodeByClass(getattr(${ui}, ${JSON.stringify(s)}).nodeTypes[0]))) and 1`);
  await page.waitForTimeout(500);
  const node = JSON.parse(await py(`__import__("json").dumps((lambda n: {"cls": n.GetClassName(), "color": list(n.GetDisplayNode().GetSelectedColor())})(${ui}.${s}.currentNode()))`));
  const look = async () => page.evaluate((name) => {
    const root = document.querySelector(`[data-name="${name}"]`);
    const input = root?.querySelector('[data-name="ColorButton"] input[type=color]');
    const place = root?.querySelector('[data-name="PlaceButton"] button');
    const del = root?.querySelector('[data-name="DeleteButton"] button');
    const h = (e) => (e ? Math.round(e.getBoundingClientRect().height) : null);
    return { color: input?.value, colorHeight: h(input), placeHeight: h(place), deleteHeight: h(del), placeIcon: !!place?.querySelector("svg") };
  }, w);
  const before = await look();
  console.log(`${w} (${node.cls})`);
  check("color button shows the node's color", before.color === hex(node.color), `${before.color} for ${hex(node.color)}`);
  check("color button as tall as the buttons", before.colorHeight !== null && Math.abs(before.colorHeight - before.placeHeight) <= 1 && Math.abs(before.colorHeight - before.deleteHeight) <= 1,
    `color ${before.colorHeight} px, Place ${before.placeHeight} px, Delete ${before.deleteHeight} px`);
  check("Place button shows the icon of the kind of markup", before.placeIcon, before.placeIcon ? "an icon" : "no icon");
  // the color changed elsewhere: the button follows
  await py(`${ui}.${s}.currentNode().GetDisplayNode().SetSelectedColor(0.2, 0.4, 0.8) or 1`);
  await page.waitForTimeout(400);
  const after = await look();
  check("color button follows a color set elsewhere", after.color === "#3366cc", after.color);
  // a color picked on the button: the node's
  await page.evaluate((name) => {
    const input = document.querySelector(`[data-name="${name}"] [data-name="ColorButton"] input[type=color]`);
    input.value = "#ff8000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, w);
  await page.waitForTimeout(400);
  const picked = JSON.parse(await py(`__import__("json").dumps(list(${ui}.${s}.currentNode().GetDisplayNode().GetSelectedColor()))`));
  check("a color picked on the button is the node's", hex(picked) === "#ff8000", hex(picked));
}
if (shot) {
  const [first] = pairs[0].split(":");
  await page.locator(`[data-name="${first}"]`).screenshot({ path: shot }).catch(() => {});
}
await browser.close();
console.log(failed ? "FAIL" : "ok");
process.exit(failed ? 1 : 0);

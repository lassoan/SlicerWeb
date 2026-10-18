// Qt's graphics view framework in the browser (python/slicerweb/qtcompat/graphics.py): a
// QGraphicsScene drawn as SVG in a QGraphicsView that zooms on the wheel, pans on a drag, and says
// which item is clicked. Driven through the module that needs it: SlicerSimVascular's ROM
// Simulation draws a 0D network with it (SimVascularROMLib.NetworkView), here the small network
// of that package's own tests, and it is used with the mouse as a person would.
// Usage: node tests/qt-graphics-view.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error" && !/GL Driver|404/.test(m.text())) errors.push(m.text().slice(0, 300)); });
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const entry = index.extensions.find((e) => e.name === "SimVascular");
if (!entry) { console.log("FAIL SimVascular is not in the extension index"); process.exit(1); }
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), [new URL("extensions/" + entry.wheel, base).href]);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForFunction(() => (window.slicerWeb?.store?.modules ?? []).some((m) => m.name === "SimVascularROM"), null, { timeout: 120000 });
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};

// The network view, shown on the page in a box of its own (in the module it is in a dock)
await run(`
import json, js
import qt
from svromsetup import network
from SimVascularROMLib.NetworkView import NetworkView
CONFIG = {
    "boundary_conditions": [
        {"bc_name": "INFLOW", "bc_type": "FLOW", "bc_values": {"t": [0.0, 0.5, 1.0], "Q": [5.0, 15.0, 5.0]}},
        {"bc_name": "RCR_cap_right", "bc_type": "RCR", "bc_values": {"Rp": 100.0, "C": 1e-4, "Rd": 1500.0, "Pd": 0.0}},
        {"bc_name": "FLOW_cap_left", "bc_type": "FLOW", "bc_values": {"t": [0.0, 1.0], "Q": [-2.0, -2.0]}},
    ],
    "vessels": [
        {"vessel_id": 0, "vessel_name": "branch0_seg0", "vessel_length": 2.0, "boundary_conditions": {"inlet": "INFLOW"},
         "zero_d_element_values": {"R_poiseuille": 1.5, "C": 2e-5, "L": 0.3, "stenosis_coefficient": 0.0}},
        {"vessel_id": 1, "vessel_name": "branch1_seg0", "vessel_length": 3.0, "boundary_conditions": {"outlet": "RCR_cap_right"},
         "zero_d_element_values": {"R_poiseuille": 9.0, "C": 1e-5, "L": 1.1}},
        {"vessel_id": 2, "vessel_name": "branch2_seg0", "vessel_length": 1.0, "zero_d_element_values": {"R_poiseuille": 4.0, "C": 1e-6, "L": 0.9}},
        {"vessel_id": 3, "vessel_name": "branch2_seg1", "vessel_length": 3.0, "boundary_conditions": {"outlet": "FLOW_cap_left"},
         "zero_d_element_values": {"R_poiseuille": 12.0, "C": 3e-6, "L": 2.7}},
    ],
    "junctions": [
        {"junction_name": "J0", "junction_type": "NORMAL_JUNCTION", "inlet_vessels": [0], "outlet_vessels": [1, 2]},
        {"junction_name": "J1", "junction_type": "NORMAL_JUNCTION", "inlet_vessels": [2], "outlet_vessels": [3]},
    ],
}
net = network.network_from_config(CONFIG, "cap_inlet")
_selected = []
view = NetworkView(lambda key: _selected.append(key))
box = js.document.createElement("div")
box.id = "graphics-test"
box.setAttribute("style", "position:fixed; left:40px; top:40px; width:640px; height:420px; z-index:1000; background:white; display:flex; flex-direction:column")
box.appendChild(view.widget.element())
js.document.body.appendChild(box)
view.setNetwork(net, tooltips={key: "tip " + key for key in net.nodes}, legend="test")
view.fit()
`);
await page.waitForTimeout(500);

// Drawn: a group per block, its shape, its label, its tool tip; an edge between linked blocks
const drawn = JSON.parse(await page.evaluate(() => {
  const svg = document.querySelector("#graphics-test svg");
  const items = [...svg.querySelectorAll("g[data-item]")];
  return JSON.stringify({
    groups: items.length,
    paths: svg.querySelectorAll("path").length,
    polygons: svg.querySelectorAll("polygon").length,
    ellipses: svg.querySelectorAll("ellipse").length,
    texts: [...svg.querySelectorAll("text")].map((t) => t.textContent),
    titles: [...svg.querySelectorAll("title")].map((t) => t.textContent),
    svgSize: [svg.clientWidth, svg.clientHeight],
  });
}));
const nodes = JSON.parse(await py("json.dumps(sorted(net.nodes))"));
const edges = Number(await py("len(net.edges)"));
console.log("drawn:", JSON.stringify({ ...drawn, texts: drawn.texts.slice(0, 4), titles: drawn.titles.length }));
check("every block is an item of the view", JSON.stringify(JSON.parse(await py("json.dumps(sorted(view.items))"))) === JSON.stringify(nodes), `${nodes.length} blocks`);
check("each edge is a curve with an arrow head", drawn.polygons === edges, `${drawn.polygons} arrows for ${edges} edges`);
check("junctions are ellipses", drawn.ellipses === nodes.filter((k) => /^junction|^J/i.test(k) || k.includes("J")).length || drawn.ellipses === 2, `${drawn.ellipses}`);
check("the blocks are labelled", drawn.texts.some((t) => /0|1|2/.test(t)), JSON.stringify(drawn.texts.slice(0, 6)));
check("and say what they are on hover", nodes.every((k) => drawn.titles.includes("tip " + k)), `${drawn.titles.length} tool tips`);

// The size a label was laid out with is the size the page draws it at
const textFit = JSON.parse(await page.evaluate(() => {
  const texts = [...document.querySelectorAll("#graphics-test svg text")];
  return JSON.stringify(texts.map((t) => t.getBBox().width));
}));
const measured = JSON.parse(await py("json.dumps([round(t.boundingRect().width(), 1) for t in view.scene.items() if isinstance(t, qt.QGraphicsSimpleTextItem)][::-1])"));
const worst = Math.max(...textFit.map((w) => Math.min(...measured.map((m) => Math.abs(m - w)))));
check("a label is as wide as its measured bounding rectangle", worst < 1.5, `worst ${worst.toFixed(2)} px over ${textFit.length} labels`);

// Fitted: the whole network inside the view
const fitted = JSON.parse(await py(`json.dumps((lambda b, v: [v.mapFromScene(b.topLeft()).x(), v.mapFromScene(b.topLeft()).y(), v.mapFromScene(b.bottomRight()).x(), v.mapFromScene(b.bottomRight()).y()])(view.scene.itemsBoundingRect(), view.view))`));
check("Fit shows the whole network", fitted[0] >= -1 && fitted[1] >= -1 && fitted[2] <= drawn.svgSize[0] + 1 && fitted[3] <= drawn.svgSize[1] + 1, JSON.stringify(fitted.map((v) => Math.round(v))));

// A click on a block selects it, found by what is under the mouse
const svgBox = await page.locator("#graphics-test svg").boundingBox();
const target = await py("[k for k in sorted(net.nodes) if 'branch1' in str(net.nodes[k].label) or 'branch1' in str(getattr(net.nodes[k], 'vessel', ''))][0]");
const at = JSON.parse(await py(`json.dumps((lambda p: [p.x(), p.y()])(view.view.mapFromScene(view.items["${target}"].sceneBoundingRect().center())))`));
await page.mouse.click(svgBox.x + at[0], svgBox.y + at[1]);
await page.waitForTimeout(300);
check("a click on a block selects it", (await py("json.dumps(_selected[-1:])")) === JSON.stringify([target]), `${await py("json.dumps(_selected)")}`);
check("and draws the selection behind it", (await page.evaluate(() => [...document.querySelectorAll("#graphics-test svg path")].some((p) => p.getAttribute("fill") === "rgba(255, 255, 0, 1.000)"))), "");
await page.mouse.click(svgBox.x + 5, svgBox.y + svgBox.height - 5);
await page.waitForTimeout(300);
check("a click on the background selects nothing", (await py("json.dumps(_selected[-1:])")) === "[null]", `${await py("json.dumps(_selected[-2:])")}`);

// The wheel zooms about the mouse: the point under it stays under it
const mouse = [svgBox.width * 0.3, svgBox.height * 0.4];
const before = JSON.parse(await py(`json.dumps((lambda p: [p.x(), p.y()])(view.view.mapToScene(qt.QPointF(${mouse[0]}, ${mouse[1]}))))`));
const scaleBefore = Number(await py("view.view.transform().m11()"));
await page.mouse.move(svgBox.x + mouse[0], svgBox.y + mouse[1]);
await page.mouse.wheel(0, -240);
await page.waitForTimeout(300);
const scaleAfter = Number(await py("view.view.transform().m11()"));
const after = JSON.parse(await py(`json.dumps((lambda p: [p.x(), p.y()])(view.view.mapToScene(qt.QPointF(${mouse[0]}, ${mouse[1]}))))`));
check("scrolling up zooms in", scaleAfter > scaleBefore * 1.1, `${scaleBefore.toFixed(3)} -> ${scaleAfter.toFixed(3)}`);
check("about the point under the mouse", Math.hypot(after[0] - before[0], after[1] - before[1]) < 0.5, `${JSON.stringify(before.map((v) => +v.toFixed(2)))} -> ${JSON.stringify(after.map((v) => +v.toFixed(2)))}`);

// A drag moves the view with the mouse, and is not a click
const selectedBefore = await py("len(_selected)");
const start = JSON.parse(await py("json.dumps([view.view.transform().dx(), view.view.transform().dy()])"));
await page.mouse.move(svgBox.x + 100, svgBox.y + 100);
await page.mouse.down();
for (let i = 1; i <= 5; i++) { await page.mouse.move(svgBox.x + 100 + i * 8, svgBox.y + 100 + i * 5); await page.waitForTimeout(30); }
await page.mouse.up();
await page.waitForTimeout(300);
const end = JSON.parse(await py("json.dumps([view.view.transform().dx(), view.view.transform().dy()])"));
check("a drag pans the view as far as the mouse moved", Math.abs(end[0] - start[0] - 40) < 1 && Math.abs(end[1] - start[1] - 25) < 1,
  `moved ${(end[0] - start[0]).toFixed(1)}, ${(end[1] - start[1]).toFixed(1)}`);
check("and selects nothing", (await py("len(_selected)")) === selectedBefore);

// Selected from elsewhere (the conditions table does this): the view scrolls to it
await run(`view.view.translate(-2000, -2000)`);
await run(`view.select(sorted(net.nodes)[0], "info")`);
const shown = JSON.parse(await py(`json.dumps((lambda r, v: [v.mapFromScene(r.topLeft()).x(), v.mapFromScene(r.topLeft()).y(), v.mapFromScene(r.bottomRight()).x(), v.mapFromScene(r.bottomRight()).y()])(view.items[sorted(net.nodes)[0]].sceneBoundingRect(), view.view))`));
check("a block selected from elsewhere is scrolled into view", shown[0] >= 0 && shown[1] >= 0 && shown[2] <= drawn.svgSize[0] && shown[3] <= drawn.svgSize[1], JSON.stringify(shown.map((v) => Math.round(v))));

// Cleared and drawn again: nothing of the first drawing is left
await run(`view.clear("cleared")`);
check("clearing the view removes every item", (await page.evaluate(() => document.querySelectorAll("#graphics-test svg g[data-item]").length)) === 0);
await run(`view.setNetwork(net)`);
check("and the network can be drawn again", (await page.evaluate(() => document.querySelectorAll("#graphics-test svg g[data-item]").length)) === drawn.groups);

check("no errors on the page", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
console.log(fail.length ? `${fail.length} check(s) failed` : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

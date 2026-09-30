// Where the time goes when a module is selected for the first time (its GUI is built: setup(), then
// enter()) and again later (enter() only): a Python profile of each, and the time until the page
// shows the panel.
// Usage: node tests/module-switch-profile.mjs [url] ExtensionNames Module [top N]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const base = args[0] && /^https?:/.test(args[0]) ? args.shift() : "http://localhost:5173/";
const [extensions, module, topArg] = args;
const top = Number(topArg ?? 35);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(`${base}?sample=&extensions=${encodeURIComponent(extensions)}`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForFunction(async (m) => String(await window.slicerWeb.bridge.evalPython(
  `str(hasattr(slicer.modules, ${JSON.stringify(m.toLowerCase())}))`, "eval")).includes("True"), module, { timeout: 600000, polling: 2000 });
await page.waitForTimeout(2000);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "exec"), code);

await run(`
import cProfile, pstats, io, time, slicer
def _profile(label, fn, top=${top}):
    profiler = cProfile.Profile()
    t0 = time.perf_counter()
    profiler.enable()
    fn()
    profiler.disable()
    elapsed = time.perf_counter() - t0
    out = io.StringIO()
    stats = pstats.Stats(profiler, stream=out)
    stats.sort_stats("cumulative").print_stats(top)
    own = io.StringIO()
    pstats.Stats(profiler, stream=own).sort_stats("tottime").print_stats(15)
    return f"=== {label}: {elapsed:.2f} s\\n--- by cumulative time\\n{out.getvalue()}\\n--- by own time\\n{own.getvalue()}"
`);
for (const [label, target] of [["first selection (GUI built, setup + enter)", module], ["back to Data", "Data"], ["selected again (enter only)", module]]) {
  const t0 = Date.now();
  const report = await py(`_profile(${JSON.stringify(label)}, lambda: slicer.util.selectModule(${JSON.stringify(target)}))`);
  // until the page shows the module's panel
  await page.waitForFunction((m) => !!document.querySelector(`[data-name="${m}WidgetParent"]`) || m === "Data", target, { timeout: 120000 }).catch(() => {});
  const wall = (Date.now() - t0) / 1000;
  console.log(report.replace(/\\n/g, "\n").replace(/\\t/g, "\t"));
  console.log(`(${label}: ${wall.toFixed(2)} s until the page shows it)\n`);
}
await browser.close();

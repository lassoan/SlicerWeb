// slicer.app.processEvents() lets the page draw while Python code runs, where the browser has
// JavaScript Promise Integration and Application settings > Developer > "Allow JavaScript Promise
// Integration (JSPI)" is on: a loop that moves a slice and processes events is seen moving it, and
// the page draws frames meanwhile. With the setting off, nothing is drawn until the code is done,
// as in a browser without JSPI.
// Usage: node tests/jspi-process-events.mjs [url]
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

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => /MR-head/.test(document.body.innerText), null, { timeout: 300000 });
await page.waitForTimeout(2000);

const supported = await page.evaluate(() => window.slicerWeb.bridge.jspiSupported);
console.log(`     this browser has JSPI: ${supported}`);

// The page counts the frames it draws; Python moves the Red slice ten times, processing events
// after each move, and counts the renders of the Red view that happened meanwhile.
const LOOP = [
  "import time",
  "lm = slicer.app.layoutManager()",
  "view = lm.view('Red')",
  "logic = lm.sliceWidget('Red').sliceLogic()",
  "start = view.GetRenderCount()",
  "for i in range(10):",
  "    logic.SetSliceOffset(logic.GetSliceOffset() + 2.0)",
  "    t = time.monotonic()",
  "    while time.monotonic() - t < 0.04:",
  "        pass",
  "    slicer.app.processEvents()",
  "slicer._rendersDuringLoop = view.GetRenderCount() - start",
].join("\n");
async function runLoop() {
  return page.evaluate(async (code) => {
    let frames = 0;
    let counting = true;
    const tick = () => { if (!counting) return; frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    await window.slicerWeb.bridge.callYielding("evalPython", [code, "exec"]);
    counting = false;
    const renders = Number(await window.slicerWeb.bridge.evalPython("slicer._rendersDuringLoop", "eval"));
    return { frames, renders };
  }, LOOP);
}

if (supported) {
  const yielding = await runLoop();
  console.log(`     allowed: ${yielding.frames} frames drawn, ${yielding.renders} renders of the Red view during the loop`);
  check("with JSPI allowed, the page draws while the loop runs", yielding.frames >= 5, true);
  check("and the slice view renders each move", yielding.renders >= 5, true);
}

await page.evaluate(() => { window.slicerWeb.store.settings = { ...window.slicerWeb.store.settings, "Developer/AllowJSPI": false }; });
await page.waitForTimeout(300);
check("the setting turned off: the page does not suspend Python", await page.evaluate(() => window.slicerWeb.bridge.canYield), false);
const blocking = await runLoop();
console.log(`     not allowed: ${blocking.frames} frames drawn, ${blocking.renders} renders of the Red view during the loop`);
check("then nothing is drawn until the code is done", blocking.renders, 0);

// the dialog offers the setting
await page.evaluate(() => { window.slicerWeb.store.settingsDialogOpen = true; });
await page.getByRole("button", { name: "Developer", exact: true }).click();
check("the Developer section offers it", await page.locator("[data-name=allowJSPI]").count(), 1);

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

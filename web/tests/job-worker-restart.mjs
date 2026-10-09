// Jobs: the worker that runs them is replaced when the page's extensions change, also while it is
// still starting - and then a job that was waiting for it runs in the new one, rather than waiting
// for ever, and no second worker is left running. A job cancelled while its worker starts is
// cancelled, and leaves no worker behind.
// Usage: node tests/job-worker-restart.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("console", (m) => { if (m.type() === "error" && !/GL Driver|404/.test(m.text())) console.log(`[error] ${m.text().slice(0, 300)}`); });
// The job workers the page makes: how many, how many still running, which have said they are ready
await page.addInitScript(() => {
  const NativeWorker = window.Worker;
  window.__jobWorkers = { made: 0, ended: 0, ready: 0 };
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (!String(url).includes("jobWorker")) return;
      window.__jobWorkers.made++;
      this.addEventListener("message", (event) => { if (event.data?.type === "ready") window.__jobWorkers.ready++; });
    }
    terminate() {
      if (!this.__ended) { this.__ended = true; window.__jobWorkers.ended++; }
      super.terminate();
    }
  };
});
await page.goto(base + "?sample=");
await page.evaluate(() => localStorage.removeItem("slicerweb.extensions"));
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(1500);
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const workers = () => page.evaluate(() => ({ ...window.__jobWorkers, running: window.__jobWorkers.made - window.__jobWorkers.ended }));
const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};
const waitFor = async (expr, seconds = 120) => {
  for (let i = 0; i < seconds * 2 && (await py(expr)) !== "True"; i++) await page.waitForTimeout(500);
};

// A job is given to a worker that is still starting...
await run(`
import json, os
from slicerweb import jobs
_jobs = {}
def _job(name, code):
    _jobs[name] = {}
    jobs.run(code, onDone=lambda result, files: _jobs[name].update(result=result), onFailed=lambda message: _jobs[name].update(error=message))
_job("first", "result = 'first'")
`);
await page.waitForTimeout(200);
const whileStarting = await workers();
check("the first job waits for a worker that is starting", whileStarting.made === 1 && whileStarting.ready === 0, JSON.stringify(whileStarting));

// ...and the page's extensions change before it is ready: SurfaceWrapSolidify is installed
await page.getByLabel("Application menu").click();
await page.locator("[role=menuitem]", { hasText: /extensions manager/i }).first().click();
const card = page.locator("div.mb-2").filter({ has: page.locator("*", { hasText: /^SurfaceWrapSolidify$/ }) }).first();
await card.getByRole("button", { name: /install/i }).click();
await page.waitForFunction(() => /SurfaceWrapSolidify installed|failed/.test(document.body.innerText), null, { timeout: 300000 });
await page.keyboard.press("Escape");
const beforeSecond = await workers();
console.log("workers when the extension was installed:", JSON.stringify(beforeSecond));
// the next job tells the runner, which replaces the worker that lacks the extension
await run(`_job("second", "import os, glob; result = bool(glob.glob('/lib/python3.14/site-packages/slicer_home/lib/Slicer-*/qt-scripted-modules/SegmentEditorWrapSolidify.py'))")`);
await waitFor("'result' in _jobs['first'] and 'result' in _jobs['second'] or 'error' in _jobs['first'] or 'error' in _jobs['second']");
const results = JSON.parse(await py("json.dumps(_jobs)"));
check("the job that waited for the replaced worker runs in the new one", results.first.result === "first", JSON.stringify(results.first));
check("and the next job has the extension installed after it started", results.second.result === true, JSON.stringify(results.second));
await page.waitForTimeout(2000);
const afterReplace = await workers();
check("one worker is left running", afterReplace.running === 1, JSON.stringify(afterReplace));
check("the replaced one was ended before it was ready", beforeSecond.ready === 0 ? afterReplace.made === 2 : true, JSON.stringify(afterReplace));

// A job cancelled while its worker is starting is cancelled, and no worker is left
await run(`jobs.cancel()`);
await page.waitForTimeout(500);
await run(`_job("cancelled", "result = 'should not run'")`);
await page.waitForTimeout(300);
await run(`jobs.cancel()`);
await waitFor("bool(_jobs['cancelled'])", 30);
const cancelled = JSON.parse(await py("json.dumps(_jobs['cancelled'])"));
check("a job cancelled while its worker starts is cancelled", /cancel/i.test(cancelled.error ?? ""), JSON.stringify(cancelled));
await page.waitForTimeout(3000);
const afterCancel = await workers();
check("and leaves no worker running", afterCancel.running === 0, JSON.stringify(afterCancel));

// and the next job starts a worker of its own and runs
await run(`_job("after", "result = 6 * 7")`);
await waitFor("bool(_jobs['after'])");
check("the next job runs", (await py("json.dumps(_jobs['after'])")) === '{"result": 42}', await py("json.dumps(_jobs['after'])"));
const end = await workers();
check("in a single worker", end.running === 1, JSON.stringify(end));

await browser.close();
console.log(fail.length ? `${fail.length} check(s) failed` : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

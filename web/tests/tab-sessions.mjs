// Sessions are a tab's own: two tabs keep their scenes apart and a reload of each restores its own;
// a new tab and a duplicated one are offered nothing (they start empty); a tab closed for good leaves
// a session that the next tab to start deletes, and the sessions of open tabs are left alone.
// Usage: node tests/tab-sessions.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
let failures = 0;
const check = (what, got, expected) => {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const errors = [];
/** A tab; what it was asked about restoring is in tab.asked. */
const open = async (init) => {
  const page = await context.newPage();
  page.asked = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => { page.asked.push(d.message().split("\n")[0]); d.accept(); });
  if (init) await page.addInitScript(init);
  await page.goto(base + "?sample=");
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
  await page.waitForTimeout(3000);
  return page;
};
const nodes = async (page) => JSON.parse(String(await page.evaluate(() => window.slicerWeb.bridge.evalPython(
  '__import__("json").dumps(sorted(n.GetName() for n in slicer.util.getNodesByClass("vtkMRMLMarkupsNode")))', "eval"))).replace(/^'|'$/g, ""));
const add = (page, name) => page.evaluate((n) => window.slicerWeb.bridge.evalPython(
  `p = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLMarkupsFiducialNode", "${n}"); p.AddControlPoint(1, 2, 3)`), name);
const keep = async (page) => {
  await page.evaluate(() => window.slicerWeb.bridge.call("saveSession"));
  await page.evaluate(() => window.slicerWeb.flushPersistentStorage());
};
const reload = async (page) => {
  page.asked = [];
  await page.reload();
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
  await page.waitForTimeout(4000);
};
const sessionId = (page) => page.evaluate(() => sessionStorage.getItem("slicerweb.sessionId"));
const databases = (page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith("/home/pyodide/SlicerSessions/")));

const a = await open();
const b = await open();
check("each tab has a session of its own", (await sessionId(a)) !== (await sessionId(b)), true);
await add(a, "In tab A");
await keep(a);
await add(b, "In tab B");
await keep(b);

await reload(a);
check("tab A, reloaded, is asked about its session", a.asked.some((m) => /Restore/.test(m)), true);
check("and gets back its own scene only", await nodes(a), ["In tab A"]);
await reload(b);
check("tab B, reloaded, gets back its own scene only", await nodes(b), ["In tab B"]);

const c = await open();
check("a new tab is asked nothing", c.asked, []);
check("and starts empty", await nodes(c), []);

// a duplicate of tab A: the browser copies A's sessionStorage, session id included
const idA = await sessionId(a);
const d = await open(`sessionStorage.setItem("slicerweb.sessionId", ${JSON.stringify(idA)})`);
check("a duplicated tab gets a session of its own", (await sessionId(d)) !== idA, true);
check("is asked nothing, and starts empty", [d.asked, await nodes(d)], [[], []]);
check("tab A's session is untouched", (await reload(a), await nodes(a)), ["In tab A"]);

// tab A closed for good: the next tab to start deletes its session, once its tab has not been
// alive for a while (made so here), and leaves tab B's alone
await a.close();
await b.evaluate((id) => {
  const sessions = JSON.parse(localStorage.getItem("slicerweb.sessions") ?? "{}");
  sessions[id] = Date.now() - 10 * 60 * 1000;
  localStorage.setItem("slicerweb.sessions", JSON.stringify(sessions));
}, idA);
const e = await open();
const left = await databases(e);
check("the closed tab's session is deleted", left.includes(`/home/pyodide/SlicerSessions/${idA}`), false);
check("tab B's is not", left.includes(`/home/pyodide/SlicerSessions/${await sessionId(b)}`), true);
check("and tab B still gets back its scene", (await reload(b), await nodes(b)), ["In tab B"]);

check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

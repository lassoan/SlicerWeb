// Installed extensions whose wheels are gone do not stop the application from starting. The
// browser remembers the wheels of the installed extensions; a later build may have dropped or
// renamed one, and a wheel installed from elsewhere may have gone away. Such a wheel is left out
// and forgotten, and the rest are installed.
// Usage: node tests/stale-extensions.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const messages = [];
page.on("console", (m) => messages.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => messages.push(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};

const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheel = (name) => new URL("extensions/" + index.extensions.find((e) => e.name === name).wheel, base).href;
const vmtk = [wheel("ExtraMarkups"), wheel("SlicerVMTK")];
const renamed = new URL("extensions/slicer_ext_renamedaway-0.1.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl", base).href;
const elsewhere = new URL("somewhere-else/slicer_ext_gone-0.1.0-py3-none-any.whl", base).href;

await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), [...vmtk, renamed, elsewhere]);
await page.reload();
const ready = await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 }).then(() => true, () => false);
check("the application starts", ready, true);
if (ready) {
  await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "ExtractCenterline"), null, { timeout: 60000 }).catch(() => {});
  check("the extensions that are there are installed", await page.evaluate(() => window.slicerWeb.store.modules.some((m) => m.name === "ExtractCenterline")), true);
}
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("slicerweb.extensions") ?? "[]"));
check("an extension the index no longer has is forgotten", stored.includes(renamed), false);
check("so is one whose wheel is gone from elsewhere", stored.includes(elsewhere), false);
check("the others are still remembered", vmtk.every((u) => stored.includes(u)), true);
check("the log says what was removed",
  messages.some((m) => /renamedaway.*no longer in/.test(m)) && messages.some((m) => /slicer_ext_gone.*could not be installed/.test(m)), true);
if (!ready) console.log(messages.slice(-10).join("\n"));

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

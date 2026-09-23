// ?extensions=SlicerHeart makes sure SlicerHeart is installed - with what it depends on (SlicerIGT,
// SlicerIGSIO, ...) - and remembers it as an installation from the Extensions Manager is, so the
// next start has it without the parameter. A name the index does not know is only a warning.
// Usage: node tests/startup-extensions.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const warnings = [];
page.on("console", (m) => { if (m.type() === "warning") warnings.push(m.text()); });
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
let failures = 0;
const check = (what, got, expected) => {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (expected ${expected})`}`);
};
const start = async (query) => {
  await page.goto(base + query);
  await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
  await page.waitForTimeout(2000);
};
const modules = () => page.evaluate(() => window.slicerWeb.store.modules.map((m) => m.name));
const installed = () => page.evaluate(() => JSON.parse(localStorage.getItem("slicerweb.extensions") ?? "[]").map((u) => u.split("/").pop()));

await page.goto(base + "?sample=");
await page.evaluate(() => localStorage.removeItem("slicerweb.extensions"));
await start("?sample=&extensions=SlicerHeart,NoSuchExtension");
let names = await modules();
check("SlicerHeart's modules are there", names.includes("VirtualCathLab"), true);
check("and those of the extension it depends on", names.includes("Watchdog"), true);
const wheels = await installed();
console.log("     installed:", wheels.join(", "));
check("the wheels are remembered, dependencies first", wheels.findIndex((w) => /slicerigt/.test(w)) < wheels.findIndex((w) => /slicerheart/.test(w)) && wheels.some((w) => /slicerigsio/.test(w)), true);
check("a name the index does not know is a warning", warnings.some((w) => /NoSuchExtension/.test(w)), true);

await start("?sample=");
names = await modules();
check("the next start, without the parameter, still has them", names.includes("VirtualCathLab") && names.includes("Watchdog"), true);
const again = await installed();
await start("?sample=&extensions=SlicerHeart");
check("asking again installs nothing twice", (await installed()).join(","), again.join(","));

await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

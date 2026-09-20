// Samples menu: data sets registered by modules (extensions) are listed and can be loaded.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const extName = process.argv[3] ?? "SlicerHeart";
const loadName = process.argv[4];
const shot = process.argv[5];
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
page.on("dialog", (d) => { console.log(`[dialog] ${d.message().slice(0, 500)}`); d.dismiss(); });
page.on("console", (m) => { if (m.type() === "error" && !/GL Driver/.test(m.text())) console.log(`[error] ${m.text().slice(0, 300)}`); });
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const wheels = [];
const add = (name) => {
  const e = index.extensions.find((x) => x.name === name);
  if (!e) return;
  for (const d of e.depends ?? []) add(d);
  const url = new URL("extensions/" + e.wheel, base).href;
  if (!wheels.includes(url)) wheels.push(url);
};
add(extName);
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge, null, { timeout: 300000 });
await page.evaluate(() => { window.__logs = []; window.slicerWeb.bridge.events.on("log", (e) => window.__logs.push(e)); });
await page.waitForFunction(() => document.querySelector("canvas"), null, { timeout: 300000 });
await page.getByRole("button", { name: "Samples" }).click();
await page.waitForTimeout(2500);
const menu = page.locator("div.absolute.top-8").first();
console.log("menu:\n" + (await menu.innerText()).split("\n").slice(0, 40).join(" | "));
if (loadName) {
  const buttons = await menu.locator("button").evaluateAll((els) => els.map((e) => [e.innerText.slice(0, 24), e.disabled]));
  console.log(JSON.stringify(buttons));
  const t0 = Date.now();
  await menu.locator("button", { hasText: new RegExp("^" + loadName) }).first().click();
  await page.waitForFunction(() => !/Downloading|Loading /.test(document.body.innerText), null, { timeout: 300000 }).catch(() => console.log("still busy"));
  console.log(`finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(20000);
  console.log(await page.evaluate(() => window.slicerWeb.bridge.evalPython(
    '__import__("json").dumps({n.GetName(): n.GetClassName() for n in slicer.util.getNodesByClass("vtkMRMLStorableNode")})', "eval")));
  console.log(await page.evaluate(() => (window.__logs || []).filter((l) => /error|warning/i.test(l.level)).map((l) => l.level + ": " + String(l.message).slice(0, 300))));
}
if (shot) await page.screenshot({ path: shot });
await browser.close();

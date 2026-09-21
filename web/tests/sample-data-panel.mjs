// The Samples menu of the Data panel: everything Slicer and the installed extensions offer is
// listed without opening the Sample Data module first, and what is picked is loaded (not merely
// downloaded), including after the scene has been closed.
// Usage: node tests/sample-data-panel.mjs [url] [--ext Name] [screenshot.png]
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const base = argv.find((a) => a.startsWith("http")) ?? "http://localhost:5173/";
const extName = argv.includes("--ext") ? argv[argv.indexOf("--ext") + 1] : null;
const shot = argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
page.on("dialog", (d) => { console.log("[dialog] " + d.message().slice(0, 200)); d.accept(); });

if (extName) {
  const index = await (await fetch(new URL("extensions/index.json", base))).json();
  const entry = index.extensions.find((e) => e.name === extName);
  await page.goto(base + "?sample=");
  await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)),
    [new URL("extensions/" + entry.wheel, base).href]);
  await page.reload();
} else {
  await page.goto(base + "?sample=");
}
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(3000);
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);

// the menu lists Slicer's own data sets without the Sample Data module having been opened
await page.getByRole("button", { name: "Samples" }).click();
await page.waitForTimeout(3000);
const listed = await page.evaluate(() => [...document.querySelectorAll("aside button")]
  .map((b) => (b.textContent ?? "").trim().split("\n")[0]).filter(Boolean));
const expected = ["MRHead", "CTChest", "CTACardio", "CTCardioSeq", "CTPCardioSeq", "CTLiver"];
console.log("samples listed:", listed.length);
console.log("Slicer's own data sets are there:", JSON.stringify(expected.map((n) => `${n}: ${listed.some((l) => l.includes(n))}`)));
if (extName) {
  console.log(`a data set of ${extName}:`, listed.find((l) => /Truncal|Valve|Echo/i.test(l)) ?? "(none)");
}

// picking one loads it into the scene, rather than only downloading it
const sequenceCount = () => value(`str(__import__("slicer").mrmlScene.GetNumberOfNodesByClass("vtkMRMLSequenceNode"))`);
await page.locator("aside button", { hasText: /CT Cardio Sequence|CTCardioSeq/ }).first().click();
for (let waited = 0; waited < 180; waited += 5) {
  await page.waitForTimeout(5000);
  if ((await sequenceCount()) !== "0") break;
}
console.log("sequences in the scene after picking CTCardioSeq:", await sequenceCount());
console.log("and its browser:", await value(`str(__import__("slicer").mrmlScene.GetNumberOfNodesByClass("vtkMRMLSequenceBrowserNode"))`));

// again, after the scene has been closed
await page.evaluate(() => window.slicerWeb.bridge.call("closeScene"));
await page.waitForTimeout(3000);
console.log("sequences after closing the scene:", await sequenceCount());
await page.getByRole("button", { name: "Samples" }).click();
await page.waitForTimeout(2000);
await page.locator("aside button", { hasText: /CT Cardio Sequence|CTCardioSeq/ }).first().click();
for (let waited = 0; waited < 120; waited += 5) {
  await page.waitForTimeout(5000);
  if ((await sequenceCount()) !== "0") break;
}
console.log("sequences after picking it again:", await sequenceCount());
if (shot) await page.screenshot({ path: shot });
await browser.close();

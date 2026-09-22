// The Samples button opens a finder like the module finder: type to filter, the arrow keys walk
// the list, Enter loads what is highlighted, Escape closes. Each data set shows its picture under
// the heading of its category.
// Usage: node tests/sample-finder.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 160)));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(4000);

const fail = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ": " + detail}`);
  if (!ok) fail.push(name);
};
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);

await page.getByRole("button", { name: "Samples" }).click();
await page.waitForTimeout(2500);
check("the finder opens", (await page.locator("[data-name='sampleFinder']").count()) > 0);
check("with the cursor in the search box",
  await page.evaluate(() => document.activeElement?.getAttribute("data-name") === "sampleSearch"));

const items = page.locator("[data-name='sampleItem']");
const all = await items.count();

// The order is the Sample Data module's: categories sorted with the built-in one first, and inside
// a category the data sets as they were registered - not everything in alphabetical order.
const shown = (await page.locator("[data-name='sampleFinder'] [data-name='sampleItem'] .truncate").allInnerTexts())
  .filter((_, i, list) => i % 2 === 0 || list.length === all).slice(0, 0);
const namesShown = await page.evaluate(() => [...document.querySelectorAll("[data-name='sampleItem']")]
  .map((el) => el.querySelector("span > span")?.textContent?.trim()).filter(Boolean));
const fromModule = await page.evaluate(() => window.slicerWeb.bridge.call("getSampleDataSources", [])
  .then((sources) => sources.map((s) => s.name)).catch(() => []));
const inBoth = namesShown.filter((n) => fromModule.includes(n));
check("the data sets are in the order the Sample Data module lists them",
  inBoth.join("|") === fromModule.filter((n) => inBoth.includes(n)).join("|"),
  inBoth.slice(0, 5).join(", ") + " …");
check("which begins with the built-in ones, not with the first name in the alphabet",
  inBoth[0] === fromModule[0], `${inBoth[0]} (the module starts with ${fromModule[0]})`);
check("it lists the data sets", all > 10, `${all} of them`);
const headings = await page.evaluate(() => [...document.querySelectorAll("[data-name='sampleFinder'] .sticky")].map((h) => h.textContent.trim()));
check("under category headings", headings.length > 0, headings.join(", "));
const thumbnails = await page.locator("[data-name='sampleFinder'] img").count();
check("and shows the picture of a data set", thumbnails > 0, `${thumbnails} pictures`);

// typing filters
await page.keyboard.type("cardio");
await page.waitForTimeout(500);
const filtered = await items.count();
const names = await items.allInnerTexts();
check("typing filters the list", filtered > 0 && filtered < all,
  `${filtered} left: ${names.map((n) => n.split("\n")[0]).slice(0, 4).join(", ")}`);

// the arrow keys walk it
const highlightedName = async () => (await page.locator("[data-name='sampleItem'][data-highlighted='true']").first().innerText()).split("\n")[0];
const first = await highlightedName();
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(200);
const second = await highlightedName();
check("the arrow keys walk the list", second !== first, `${first} -> ${second}`);
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(200);
check("and back again", (await highlightedName()) === first);

// escape closes it
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("Escape closes it", (await page.locator("[data-name='sampleFinder']").count()) === 0);

// Enter loads what is highlighted
await page.getByRole("button", { name: "Samples" }).click();
await page.waitForTimeout(1500);
await page.keyboard.type("MRHead");
await page.waitForTimeout(500);
const wanted = await highlightedName();
await page.keyboard.press("Enter");
for (let waited = 0; waited < 180; waited += 5) {
  await page.waitForTimeout(5000);
  if ((await value(`__import__("slicer").mrmlScene.GetNumberOfNodesByClass("vtkMRMLScalarVolumeNode")`)) > 0) break;
}
const loaded = Number(await value(`__import__("slicer").mrmlScene.GetNumberOfNodesByClass("vtkMRMLScalarVolumeNode")`));
check("Enter loads the highlighted data set", loaded > 0, `${wanted} -> ${loaded} volume(s) in the scene`);

if (shot) await page.screenshot({ path: shot });
await browser.close();
console.log(fail.length ? "FAILED: " + fail.join(", ") : "ALL PASSED");
process.exit(fail.length ? 1 : 0);

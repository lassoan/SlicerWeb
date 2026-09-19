// MarkupsToModel web GUI test: install the extension, open the module, place points (clicks in the
// 3D view), update the model, check the result.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv[3];
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
const index = await (await fetch(new URL("extensions/index.json", base))).json();
const ext = index.extensions.find((e) => e.name === "MarkupsToModel");
await page.goto(base + "?sample=");
await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), [new URL("extensions/" + ext.wheel, base).href]);
await page.reload();
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.evaluate(() => { window.__logs = []; window.slicerWeb.bridge.events.on("log", (e) => window.__logs.push(e)); });
const py = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code);

// Open the module
await page.locator("button.h-8.w-full").first().click();
await page.getByPlaceholder("Search modules").fill("MarkupsToModel");
await page.locator("div.absolute.right-2 button").first().click();
await page.waitForTimeout(1500);
const panel = page.locator(".sw-panel-scroll").last();

// Place points: button, then clicks in the 3D view
await panel.getByText("Place points").click();
await page.waitForTimeout(500);
const view = await page.locator("#slicer-view-1").boundingBox();
const clicks = [[0.35, 0.35], [0.65, 0.35], [0.5, 0.7], [0.3, 0.6], [0.7, 0.6], [0.5, 0.3]];
for (const [fx, fy] of clicks) {
  await page.mouse.click(view.x + view.width * fx, view.y + view.height * fy);
  await page.waitForTimeout(300);
}
await panel.getByText("Stop placing").click();
await page.waitForTimeout(800);
console.log("points label:", (await panel.innerText()).match(/\d+ points?/)?.[0]);

// Clicks in an empty 3D view place points on the focal plane; they may be coplanar, so a closed
// surface needs Delaunay alpha 0 / convex hull. Use curve mode for a robust check, then closed surface.
await panel.getByRole("button", { name: /^Update$/ }).click();
await page.waitForTimeout(1500);
console.log("after update (closed surface):", (await panel.innerText()).match(/Output: [\d,]+ points/)?.[0] ?? "no output");
await panel.locator("select").nth(3).selectOption({ index: 1 }).catch(async () => {});
await page.waitForTimeout(1500);
console.log(await py(`__import__("json").dumps({"type": slicer.util.getNodesByClass("vtkMRMLMarkupsToModelNode")[0].GetModelType(), "points": slicer.util.getNodesByClass("vtkMRMLMarkupsToModelNode")[0].GetOutputModelNode().GetPolyData().GetNumberOfPoints(), "input": slicer.util.getNodesByClass("vtkMRMLMarkupsToModelNode")[0].GetInputNode().GetNumberOfControlPoints()})`));
const logs = await page.evaluate(() => window.__logs.filter((l) => /error/i.test(l.level)));
for (const l of logs) console.log(`[python ${l.level}] ${String(l.message).slice(0, 600)}`);
const selectDebug = await panel.locator("select").evaluateAll((els) => els.slice(0, 3).map((e) => ({ value: e.value, options: [...e.options].map((o) => o.value + "=" + o.text + (o.selected ? "*" : "")) })));
console.log(JSON.stringify(selectDebug));
if (shot) await page.screenshot({ path: shot });
await browser.close();

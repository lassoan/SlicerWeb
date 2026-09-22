import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") console.log("  [error] " + m.text().slice(0, 300)); });
await page.goto("http://localhost:5173/?sample=" + (process.argv[2] ?? "MRHead"));
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(5000);
async function openModule(title) {
  if (await page.getByPlaceholder("Search modules").count() === 0) {
    await page.locator("[data-name='moduleTitle']").click();
    await page.waitForTimeout(300);
  }
  await page.getByPlaceholder("Search modules").fill(title);
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
}
const panelText = async () => (await page.locator(".sw-panel-scroll").last().innerText()).replace(/\s+/g, " ").slice(0, 220);
await openModule("Volume Rendering");
console.log("before:", await panelText());
// the eye / "show" toggle the panel offers
const toggles = await page.locator(".sw-panel-scroll [data-name]").evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));
console.log("controls:", JSON.stringify(toggles).slice(0, 300));
const box = page.locator(".sw-panel-scroll input[type=checkbox]").first();
console.log("checkboxes:", await page.locator(".sw-panel-scroll input[type=checkbox]").count());
await box.click();
await page.waitForTimeout(2500);
console.log("checked now:", await box.isChecked().catch(() => "gone"));
await page.waitForTimeout(3000);
console.log("after :", await panelText());
await page.waitForTimeout(4000);
console.log("later :", await panelText());
// toggle it off and on again
await box.click(); await page.waitForTimeout(2000);
await box.click(); await page.waitForTimeout(4000);
console.log("again :", await panelText());
await browser.close();

// The version at the end of the application menu: the build date and the commits of the runtime
// (wheels/build-info.json) and of the application. Opens the menu, prints the lines, saves a picture.
// Usage: node tests/menu-version.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const picture = process.argv[3] ?? "menu-version.png";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
let failed = false;
page.on("pageerror", (e) => { failed = true; console.log(`[pageerror] ${e}`); });

const info = await (await fetch(new URL("wheels/build-info.json", base))).json().catch(() => null);
console.log("build-info.json:", JSON.stringify(info));

await page.goto(`${base}?sample=`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.getByRole("button", { name: "Application menu" }).click();
const footer = page.locator('[data-name="menu:version"]');
await footer.waitFor({ timeout: 10000 }).catch(() => {});
const lines = await footer.locator("div").allInnerTexts().catch(() => []);
console.log("menu:", lines.length ? lines.join(" | ") : "(no version lines)");
await page.screenshot({ path: picture });

if (!lines.length) failed = true;
if (info?.slicerweb?.commit && !lines.some((l) => l.includes(info.slicerweb.commit.slice(0, 7)))) {
  console.log("FAIL: the SlicerWeb commit of the build is not shown");
  failed = true;
}
if (info?.deployment?.commit && !lines.some((l) => l.includes(info.deployment.commit.slice(0, 7)))) {
  console.log("FAIL: the commit of the deployment is not shown");
  failed = true;
}
// the menu stays open when the version is clicked (to select it)
await footer.click().catch(() => {});
if (!(await footer.isVisible())) { console.log("FAIL: clicking the version closed the menu"); failed = true; }
await browser.close();
console.log(failed ? "FAIL" : "ok");
process.exit(failed ? 1 : 0);

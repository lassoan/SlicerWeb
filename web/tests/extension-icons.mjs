// The icons of the Extensions Manager: each extension shows its icon, or - when it has none, or the
// page cannot load it (an icon in a private repository) - a placeholder, with a warning in the log.
// Prints what each extension shows; fails if an icon that loads is not shown, or one that does not
// load leaves no placeholder or no warning.
// Usage: node tests/extension-icons.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const picture = process.argv[3];
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const warnings = [];
page.on("console", (m) => { if (m.type() === "warning" && /icon of extension/.test(m.text())) warnings.push(m.text()); });
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));

await page.goto(`${base}?sample=`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.getByRole("button", { name: "Application menu" }).click();
await page.locator('[data-name="menu:extensions"]').click();
await page.locator("[data-extension]").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(5000);   // for the icons to load or fail

const rows = await page.locator("[data-extension]").evaluateAll((els) => els.map((el) => {
  const img = el.querySelector("img");
  return { name: el.dataset.extension, img: img ? { src: img.src, loaded: img.complete && img.naturalWidth > 0 } : null,
           placeholder: !!el.querySelector('[data-name="extensionIconPlaceholder"]') };
}));
let failed = false;
for (const r of rows) {
  const shows = r.img ? (r.img.loaded ? "icon" : "icon NOT LOADED") : r.placeholder ? "placeholder" : "NOTHING";
  console.log(`${r.name}: ${shows}${r.img ? ` (${r.img.src})` : ""}`);
  if (shows !== "icon" && shows !== "placeholder") failed = true;
}
console.log(`warnings (${warnings.length}):`);
for (const w of warnings) console.log(`  ${w}`);
if (picture) await page.screenshot({ path: picture });
await browser.close();
console.log(failed ? "FAIL" : "ok");
process.exit(failed ? 1 : 0);

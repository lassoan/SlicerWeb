// A widget hidden, taken out of the page (the panel of another module shown) and shown again while
// out of it, shows its content when it is back: what is set on the element stays on the element and
// is not copied onto what it renders, where the copy would not have followed (Conduit Planner's
// Opening A/B rows stayed empty after a scene was loaded while another module was open).
// Usage: node tests/widget-shown-out-of-page.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(base + "?sample=");
await page.waitForFunction(() => customElements.get("sw-label"), null, { timeout: 120000 });
const results = await page.evaluate(async () => {
  const tick = () => new Promise((r) => setTimeout(r, 50));
  const tags = ["sw-button", "sw-checkbox", "sw-collapsible", "sw-colorpicker", "sw-combobox", "sw-groupbox", "sw-label",
    "sw-lineedit", "sw-node-selector", "sw-progressbar", "sw-range-slider", "sw-slider", "sw-spinbox", "sw-textedit"];
  const out = [];
  for (const tag of tags) {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    const el = document.createElement(tag);
    el.title = "tooltip";
    panel.appendChild(el); await tick();
    el.style.display = "none"; await tick();
    panel.removeChild(el); await tick();
    el.style.display = ""; await tick();
    panel.appendChild(el); await tick();
    const inner = el.firstElementChild;
    out.push([tag, inner ? getComputedStyle(inner).display : "(nothing rendered)", inner?.getAttribute("style") ?? ""]);
    panel.remove();
  }
  return out;
});
let failures = 0;
for (const [tag, display, style] of results) {
  const ok = display !== "none";
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${tag} shown again: content display=${display}${style ? ` style="${style}"` : ""}`);
}
await browser.close();
process.exit(failures ? 1 : 0);

// The screenshot button saves what the view shows, and the Python console offers its completions in
// a list above the prompt.
// Usage: node tests/ui-screenshot-console.mjs [url]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(base + "?sample=CTChest");
await page.waitForFunction(() => /CT-chest/.test(document.body.innerText) && document.querySelector("#slicer-view-Red"), null, { timeout: 300000 });
await page.waitForTimeout(3000);

// screenshot of the active view
await page.locator("#slicer-view-Red").click({ position: { x: 20, y: 20 } });
await page.waitForTimeout(400);
const download = page.waitForEvent("download", { timeout: 30000 });
await page.getByRole("button", { name: /screenshot/i }).first().click();
const file = await download;
const saved = path.join(os.tmpdir(), await file.suggestedFilename());
await file.saveAs(saved);
const bytes = fs.readFileSync(saved);
const png = bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG";
// an image of a slice view is not one flat colour
const distinct = new Set();
for (let i = 1000; i < Math.min(bytes.length, 200000); i += 37) distinct.add(bytes[i]);
console.log(`screenshot: ${await file.suggestedFilename()}, ${(bytes.length / 1024).toFixed(0)} kB, PNG: ${png}, distinct bytes: ${distinct.size}`);

// completions in the console
await page.getByRole("button", { name: /python console/i }).first().click();
await page.waitForTimeout(800);
const input = page.locator("textarea");
await input.click();
await input.type("slicer.util.getNo");
await page.waitForTimeout(1600);
const list = page.locator("ul[role='listbox']");
const box = await list.boundingBox().catch(() => null);
const items = await list.locator("[role='option']").allInnerTexts();
console.log(`completion list: ${box ? `${Math.round(box.width)}x${Math.round(box.height)} above the prompt` : "missing"}, ${items.length} items`);
console.log("first items:", items.slice(0, 3).map((t) => t.replace(/\s+/g, " ")).join(" | "));
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(200);
console.log("selected after ArrowDown:", (await list.locator("[data-active='true']").innerText()).replace(/\s+/g, " "));
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
console.log("input after Enter:", await input.inputValue());
await browser.close();

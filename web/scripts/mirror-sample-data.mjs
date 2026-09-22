/**
 * Copy the sample data sets into the site, so that a site of static files can offer them.
 *
 * The servers that hold sample data (GitHub release downloads, mostly) do not let another site
 * read their files, and the published site has no download proxy to fetch them for the page. So
 * the files travel with the site: this script downloads them and writes sample-data/mirror.json,
 * the map from the address a data set names to the copy here, which the runtime reads before it
 * downloads anything (see SlicerRuntime.downloadFile).
 *
 * Which data sets exist is only known to the application - modules and extensions register them
 * while they load - so the list is asked of a running one.
 *
 * Usage: node scripts/mirror-sample-data.mjs <site url> <output directory> [options]
 *   --max-file <MB>    skip a data set holding a file this large (default 100: GitHub refuses
 *                      to store a file above that)
 *   --max-total <MB>   stop once this much has been copied (default 800: a GitHub Pages site is
 *                      asked to stay under a gigabyte)
 *   --extensions <a,b> extensions to install before asking (default: all in extensions/index.json)
 *   --dry-run          only say what would be copied, and how much it comes to
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i < 0 ? fallback : args[i + 1];
};
const base = args[0] ?? "http://localhost:4173/";
const outDir = path.resolve(args[1] ?? "dist/app/sample-data");
const maxFile = Number(option("max-file", 100)) * 1024 * 1024;
const maxTotal = Number(option("max-total", 800)) * 1024 * 1024;
const only = option("extensions", null)?.split(",").map((s) => s.trim());
const dryRun = args.includes("--dry-run");

/** The data sets the application knows about, with the extensions loaded. */
async function sampleDataSources() {
  const index = await (await fetch(new URL("extensions/index.json", base))).json().catch(() => ({ extensions: [] }));
  const wheels = [];
  const add = (name) => {
    const e = (index.extensions ?? []).find((x) => x.name === name);
    if (!e) return;
    for (const d of e.depends ?? []) add(d);
    const url = new URL("extensions/" + e.wheel, base).href;
    if (!wheels.includes(url)) wheels.push(url);
  };
  for (const e of index.extensions ?? []) if (!only || only.includes(e.name)) add(e.name);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
    // "?sample=" so that nothing is loaded while the list is read
    await page.goto(base + "?sample=");
    await page.evaluate((w) => localStorage.setItem("slicerweb.extensions", JSON.stringify(w)), wheels);
    await page.reload();
    await page.waitForFunction(() => window.slicerWeb?.bridge, null, { timeout: 600000 });
    await page.waitForFunction(() => document.querySelector("canvas"), null, { timeout: 600000 });
    return await page.evaluate(() => window.slicerWeb.bridge.call("getSampleDataSources"));
  } finally {
    await browser.close();
  }
}

/** How large the file at this address is, or 0 where the server does not say. */
async function sizeOf(url) {
  const response = await fetch(url, { method: "HEAD", redirect: "follow" }).catch(() => null);
  return Number(response?.headers.get("content-length") ?? 0);
}

const used = new Map(); // file name here -> the address it holds
/** A name for the copy of this file that no other address has taken. */
function nameFor(url, fileName) {
  let name = (fileName || decodeURIComponent(new URL(url).pathname.split("/").pop() || "download")).replace(/[^\w.@-]/g, "_");
  if (used.get(name) && used.get(name) !== url) {
    name = crypto.createHash("sha1").update(url).digest("hex").slice(0, 8) + "-" + name;
  }
  used.set(name, url);
  return name;
}

const sources = await sampleDataSources();
console.log(`${sources.length} sample data sets`);
fs.mkdirSync(outDir, { recursive: true });
const mirror = fs.existsSync(path.join(outDir, "mirror.json"))
  ? JSON.parse(fs.readFileSync(path.join(outDir, "mirror.json"), "utf8"))
  : {};
for (const [url, name] of Object.entries(mirror)) used.set(name, url);

let total = 0;
for (const name of fs.readdirSync(outDir)) {
  const file = path.join(outDir, name);
  if (fs.statSync(file).isFile()) total += fs.statSync(file).size;
}

const skipped = [];
for (const source of sources) {
  const label = `${source.categoryTitle}/${source.name}`;
  if (source.customDownloader) {
    skipped.push(`${label}: downloaded by its own module`);
    continue;
  }
  const files = source.uris.map((url, i) => ({ url, name: nameFor(url, source.fileNames?.[i]) }));
  const wanted = files.filter((f) => !fs.existsSync(path.join(outDir, f.name)));
  const sizes = await Promise.all(wanted.map((f) => sizeOf(f.url)));
  const largest = Math.max(0, ...sizes);
  if (largest > maxFile) {
    skipped.push(`${label}: holds a file of ${(largest / 1024 / 1024).toFixed(0)} MB`);
    continue;
  }
  const size = sizes.reduce((a, b) => a + b, 0);
  if (total + size > maxTotal) {
    skipped.push(`${label}: the site would grow past ${(maxTotal / 1024 / 1024).toFixed(0)} MB`);
    continue;
  }
  if (dryRun) {
    total += size;
    console.log(`${label}: ${files.map((f) => f.name).join(", ")} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    for (const file of files) mirror[file.url] = file.name;
    continue;
  }
  let failed = false;
  for (const file of wanted) {
    const target = path.join(outDir, file.name);
    const response = await fetch(file.url, { redirect: "follow" }).catch(() => null);
    if (!response?.ok) {
      skipped.push(`${label}: ${file.url} answered ${response?.status ?? "nothing"}`);
      failed = true;
      break;
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxFile) {
      skipped.push(`${label}: ${file.name} is ${(data.length / 1024 / 1024).toFixed(0)} MB`);
      failed = true;
      break;
    }
    fs.writeFileSync(target + ".part", data);
    fs.renameSync(target + ".part", target);
    total += data.length;
    console.log(`${label}: ${file.name} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  if (failed) continue;
  for (const file of files) mirror[file.url] = file.name;
}

if (!dryRun) fs.writeFileSync(path.join(outDir, "mirror.json"), JSON.stringify(mirror, null, 1));
console.log(`${Object.keys(mirror).length} files copied, ${(total / 1024 / 1024).toFixed(0)} MB in ${outDir}`);
if (skipped.length) console.log("Left out:\n  " + skipped.join("\n  "));

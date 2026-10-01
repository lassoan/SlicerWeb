// Files of a server that refuses cross-origin requests (a GitHub release asset) are read through
// the download proxy the site was built with (VITE_DOWNLOAD_PROXY), both by the page's own
// downloads and by Python code that downloads synchronously (slicer.util.downloadFile).
// Usage: node tests/download-proxy.mjs [url] [--python-source]   (a site built with VITE_DOWNLOAD_PROXY set)
import { chromium } from "playwright-core";

const base = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:5173/";
const FILE = "https://github.com/Slicer/SlicerTestingData/releases/download/SHA256/cc211f0dfd9a05ca3841ce1141b292898b2dd2d3f08286affadf823a7e58df93";
const SIZE = 6607313;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
const proxied = [];
page.on("request", (r) => { if (r.url().includes("?url=") || r.url().includes("download?url")) proxied.push(r.url().split("?")[0]); });
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });

let failed = false;
const check = (what, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ": " + detail : ""}`); failed ||= !ok; };

const pagePath = await page.evaluate((url) => window.slicerWeb.downloadFile(url, "MRHead-page.nrrd"), FILE).catch((e) => "error: " + e.message);
const pageSize = await page.evaluate((p) => window.slicerWeb.pyodide.FS.stat(p).size, pagePath).catch(() => 0);
check("page download", pageSize === SIZE, `${pagePath} ${pageSize} bytes`);

// (--python-source: the Python code of this checkout instead of that of the wheel the site serves)
if (process.argv.includes("--python-source")) {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../../python/slicerweb/downloads.py", import.meta.url), "utf-8");
  await page.evaluate((src) => window.slicerWeb.bridge.evalPython(
    `import slicerweb.downloads as _d
exec(${JSON.stringify(src)}, _d.__dict__)`), source);
}
await page.evaluate((url) => window.slicerWeb.bridge.evalPython(
  `from slicerweb.downloads import urlretrieve as _u
_size = __import__("os").path.getsize(_u(${JSON.stringify(url)}, "/tmp/MRHead-py.nrrd")[0])`), FILE);
const pySize = await page.evaluate(() => window.slicerWeb.bridge.evalPython("_size", "eval")).catch((e) => "error: " + e.message);
check("Python download (synchronous)", Number(pySize) === SIZE, `${pySize} bytes`);

check("both went through the proxy", proxied.length >= 2, proxied.join(", "));
await browser.close();
process.exit(failed ? 1 : 0);

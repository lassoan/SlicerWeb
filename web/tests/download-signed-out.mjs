// What the page says when the sign-in has expired. A site behind a sign-in (the test site is,
// through Cloudflare Access) answers every request afterwards with a redirect to the sign-in page
// on another site, which a fetch cannot follow and reports as nothing at all - so a download says
// what has happened rather than "no response".
// Usage: node tests/download-signed-out.mjs [url]
import { chromium } from "playwright-core";
const base = process.argv[2] ?? "http://localhost:4173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.route("**/download?*", (route) => route.fulfill({
  status: 302,
  headers: { location: "https://slicerweb.cloudflareaccess.com/cdn-cgi/access/login/slicerweb.slicercloud.app" },
}));
const message = await page.evaluate(async () => {
  try {
    await window.slicerWeb.downloadFile("https://github.com/SimVascular/SlicerSimVascular/releases/download/testing-data/Stent_30x476.ply");
    return "(no error)";
  } catch (e) { return String(e.message ?? e); }
});
console.log("message when signed out:\n" + message);
await page.unroute("**/download?*");
const downloaded = await page.evaluate(async () => {
  try { return "downloaded to " + await window.slicerWeb.downloadFile("https://github.com/SimVascular/SlicerSimVascular/releases/download/testing-data/Stent_30x476.ply"); }
  catch (e) { return "ERR " + String(e.message ?? e); }
});
console.log("and when signed in: " + downloaded);
await browser.close();
const ok = /sign-in for this site has expired/.test(message) && downloaded.startsWith("downloaded to ");
console.log(ok ? "ALL PASSED" : "FAILED");
process.exit(ok ? 0 : 1);

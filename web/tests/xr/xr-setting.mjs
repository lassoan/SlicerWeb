// The WebXR application setting (XR/Enabled, on by default): a checkbox at the end of the General
// section of SlicerWeb's Application settings dialog. Off, the VR and AR buttons are not shown -
// also after a reload - and on again, they are. Other sections of the dialog do not show it.
//
// Usage: node tests/xr/xr-setting.mjs [url]  (an application with the feature webxr, examples/full: python slicerweb.py dev)
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/?sample=";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.addInitScript({ path: fileURLToPath(new URL("./xr-mock.js", import.meta.url)) });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const buttonsShown = () => page.locator("#slicer-xr").isVisible();
const ready = () => page.waitForFunction(() => window.slicerWeb?.store?.status === "ready" && window.slicerXR, null, { timeout: 300000 });
const openGeneral = async () => {
  await page.getByLabel("Application menu").click();
  await page.locator("[role=menuitem]", { hasText: /application settings/i }).first().click();
  await page.locator("[data-name=settings-dialog]").waitFor({ timeout: 10000 });
  await page.locator("[data-name=settings-dialog] nav").getByText("General", { exact: true }).click();
};
const checkbox = () => page.locator("[data-name=settings-dialog] [data-name=xrEnabled] input[type=checkbox]");

await page.goto(url);
await ready();
await page.waitForTimeout(800);
check(await buttonsShown(), "by default the VR and AR buttons are shown");

await openGeneral();
await checkbox().waitFor({ timeout: 5000 });
check(await checkbox().isChecked(), "the General section of Application settings has the WebXR setting, on");
await page.locator("[data-name=settings-dialog]").screenshot({ path: "tests/xr-setting.png" });
const look = await page.evaluate(() => {
  const ours = document.querySelector("[data-name=xrEnabled]");
  const theirs = document.querySelector("[data-name=saveWrittenFilesToDownloads]");
  const a = getComputedStyle(ours), b = getComputedStyle(theirs);
  return a.fontSize === b.fontSize && a.color === b.color && ours.parentElement.parentElement === theirs.parentElement;
});
check(look, "it is in that section, and looks as the dialog's own checkboxes do");

await checkbox().click();
await page.waitForTimeout(700);
check(!(await buttonsShown()), "turned off, the buttons are not shown");
check(await page.evaluate(() => window.slicerWeb.store.settings["XR/Enabled"] === false &&
  JSON.parse(localStorage.getItem("slicerweb.settings"))["XR/Enabled"] === false), "the setting is kept with SlicerWeb's settings");

await page.locator("[data-name=settings-dialog] nav").getByText("Rendering", { exact: true }).click();
await page.waitForTimeout(300);
check(await page.locator("[data-name=xrEnabled]").count() === 0, "another section of the dialog does not show it");
await page.locator("[data-name=settings-dialog] nav").getByText("General", { exact: true }).click();
await page.waitForTimeout(300);
check(!(await checkbox().isChecked()), "back in General, it shows the setting as it is (off)");

await page.reload();
await ready();
await page.waitForTimeout(1500);
check(!(await buttonsShown()), "after a reload the buttons are still not shown");
check((await page.evaluate(() => window.__xrMock.compatible.size)) === 0, "and the page does not make its 3D view ready for XR");

await openGeneral();
await checkbox().waitFor({ timeout: 5000 });
await checkbox().click();
await page.waitForTimeout(700);
check(await buttonsShown(), "turned on again, the buttons are shown");
check(await page.evaluate(() => JSON.parse(localStorage.getItem("slicerweb.settings") ?? "{}")["XR/Enabled"] !== false), "and the setting is kept as on");
await browser.close();
process.exit(failed ? 1 : 0);

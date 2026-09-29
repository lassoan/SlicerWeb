// RawImageGuess (extension) driven like a user: with auto-update checked on the Update button,
// dragging the X dimension slider shows the new value in the box beside it and reads the file again
// into the output volume at that size; the range slider keeps both of its values. The raw file is
// chosen with the file picker, and the NRRD header the module writes next to it is saved to the
// user's downloads (the file the user chose is not).
// Usage: node tests/rawimageguess-gui.mjs [url]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })).newPage();
const downloads = [];
page.on("download", (d) => downloads.push(d));
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/GL Driver|shader|vtkOpenGL/i.test(m.text())) errors.push(m.text()); });
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}`);
};
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);

await page.goto(base + "?sample=&extensions=RawImageGuess");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => (window.slicerWeb.store.modules ?? []).some((m) => m.name === "RawImageGuess"), null, { timeout: 120000 });

// a raw file on the user's disk: 64 x 48 x 10 voxels of 8 bits
const rawFile = path.join(os.tmpdir(), "rawimageguess-test.raw");
fs.writeFileSync(rawFile, Buffer.from(Array.from({ length: 64 * 48 * 10 }, (_, i) => i % 256)));
await page.evaluate(() => { window.slicerWeb.store.activeModule = "RawImageGuess"; });
await page.waitForTimeout(3000);
await exec(`w = slicer.util.getModuleWidget("RawImageGuess")`);
const panel = page.locator(".sw-panel-scroll").last();
// chosen with the file picker first, as a user does: auto-update reads it at once at the default
// size, which the file is too small for (an empty volume, whose extent has no numbers)
await panel.locator("[data-name=inputFileSelector] input[type=file]").setInputFiles(rawFile);
await page.waitForTimeout(2500);
check("the chosen file is what the module reads", await py("w.ui.inputFileSelector.currentPath"), (p) => p.endsWith("/rawimageguess-test.raw"));
check("and it is not offered back as a download", downloads.length, 0);
await exec(`
w.ui.pixelTypeComboBox.currentIndex = w.ui.pixelTypeComboBox.findText("8 bit unsigned")
w.ui.imageSizeXSliderWidget.value = 64
w.ui.imageSizeYSliderWidget.value = 48
w.ui.imageSizeZSliderWidget.value = 10
w.ui.imageSkipSliderWidget.value = 0
`);

// auto-update: the check box on the Update button, which the module starts with checked; turned off
// and on again, as a user would to make sure
const autoUpdate = panel.locator("[data-name=updateButton] [role=checkbox]");
check("the check box shows auto-update on", await autoUpdate.getAttribute("aria-checked"), "true");
await autoUpdate.click();
await page.waitForTimeout(500);
check("unchecked, auto-update is off", await py("w.ui.updateButton.checkState == qt.Qt.Unchecked"), "True");
await autoUpdate.click();
await page.waitForTimeout(1500);
check("auto-update is on (checkState)", await py("w.ui.updateButton.checkState == qt.Qt.Checked"), "True");
const dims = () => py("(lambda n: repr(n.GetImageData().GetDimensions()) if n and n.GetImageData() else None)(w.ui.outputVolumeNodeSelector.currentNode())");
check("turning it on reads the file", await dims(), "(64, 48, 10)");

// drag the X dimension slider with the mouse
const slider = panel.locator("[data-name=imageSizeXSliderWidget]");
const track = await slider.locator("input[type=range]").boundingBox();
await page.mouse.move(track.x + 4, track.y + track.height / 2);
await page.mouse.down();
await page.mouse.move(track.x + track.width * 0.02, track.y + track.height / 2, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(1500);
const value = Number(await py("w.ui.imageSizeXSliderWidget.value"));
const box = Number(await slider.locator("input[type=number]").inputValue());
check("the slider moved", value, (v) => v !== 64);
check("the box beside it shows the new value", box, (v) => v === value);
check("the volume is read again at that size", await dims(), (d) => d?.startsWith(`(${value},`));

// the NRRD header the module writes next to the raw file is saved to the user's downloads
const download = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
await panel.getByRole("button", { name: /generate nrrd/i }).click();
const header = await download;
check("Generate NRRD header saves the header to the downloads", header ? header.suggestedFilename() : null, (n) => /\.nhdr$/.test(n ?? ""));
if (header) {
  const text = fs.readFileSync(await header.path(), "utf8");
  check("which describes the raw file", /sizes: \d+ 48 10/.test(text) && /data file: rawimageguess-test\.raw/.test(text), true);
}
await page.waitForTimeout(2500);
check("and only that is offered", downloads.length, 1);

// a range slider keeps the value of the handle that did not move
await exec(`
rw = ctk.ctkRangeWidget()
rw.minimum, rw.maximum = 0, 100
rw.setValues(20, 80)
w.layout.addWidget(rw)
rw.setObjectName("testRangeWidget")
`);
await page.waitForTimeout(500);
const range = panel.locator("[data-name=testRangeWidget]");
const numbers = range.locator("input[type=number]");
await numbers.nth(1).fill("70");
await numbers.nth(1).press("Enter");
await numbers.nth(0).fill("30");
await numbers.nth(0).press("Enter");
await page.waitForTimeout(500);
check("a range slider keeps the other value", await py("repr((rw.minimumValue, rw.maximumValue))"), "(30.0, 70.0)");

check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

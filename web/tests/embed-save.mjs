// What an embedding page needs to keep what is saved: readFiles gives the bytes of files of the
// application's file system back as File objects, and a saveHandler takes the files the user saves
// (Data panel "Save scene", a node's "Save to file", Scene Views "Save picture") instead of the
// browser downloading them - not even when the handler fails. Without a handler, downloads as before.
// A scene view's picture is part of the scene: it comes back with the saved .mrb.
// Usage: node tests/embed-save.mjs [url]
import fs from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
const downloads = [];
page.on("download", (d) => downloads.push(d));
let failures = 0;
const check = (what, got, expected) => {
  const ok = typeof expected === "function" ? expected(got) : got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${typeof got === "object" ? JSON.stringify(got) : got}`);
};
const exec = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
// the name the "Save scene as" prompt is answered with
let answer = "";
page.on("dialog", (d) => d.accept(answer));

await page.goto(base + "?sample=MRHead");
await page.waitForFunction(() => window.slicerWeb?.store?.status === "ready", null, { timeout: 300000 });
await page.waitForFunction(() => window.slicerWeb.store.sceneNodes?.length || window.slicerWeb.bridge, null, { timeout: 60000 });
await page.waitForFunction(async () => Number(await window.slicerWeb.bridge.evalPython(
  "len(slicer.util.getNodesByClass('vtkMRMLScalarVolumeNode'))", "eval")) > 0, null, { timeout: 180000, polling: 1000 });

// the page saving a scene, and reading it back
const read = await page.evaluate(async () => {
  const s = window.slicerWeb;
  await s.bridge.call("saveScene", ["/data/t/a.mrb"]);
  const [file] = await s.readFiles(["/data/t/a.mrb"]);
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return { name: file.name, size: file.size, fsSize: s.pyodide.FS.stat("/data/t/a.mrb").size, magic: String.fromCharCode(...head) };
});
check("readFiles gives the file by its name", read.name, "a.mrb");
check("with all its bytes", read.size, read.fsSize);
check("a zip file (.mrb)", read.magic, "PK");
check("a path that is not there is named in the error",
  await page.evaluate(() => window.slicerWeb.readFiles(["/nope"]).then(() => "resolved", (e) => e.message)), (m) => m.includes("/nope"));
check("nor is a folder a file",
  await page.evaluate(() => window.slicerWeb.readFiles(["/data/t"]).then(() => "resolved", (e) => e.message)), (m) => m.includes("/data/t"));

// a handler takes what the user saves
await page.evaluate(() => {
  window.handled = [];
  window.savedEvents = [];
  window.slicerWeb.bridge.events.on("file-saved", (e) => window.savedEvents.push(e.path));
  window.slicerWeb.saveHandler = async (path) => {
    const [file] = await window.slicerWeb.readFiles([path]);
    window.handled.push({ path, size: file.size });
  };
});
const saveScene = async (name) => {
  answer = name;
  await page.locator("button[title='Save scene']").click();
};
let before = downloads.length;
await saveScene("handled.mrb");
await page.waitForFunction(() => window.handled.length > 0, null, { timeout: 60000 }).catch(() => null);
await page.waitForTimeout(2000);
let handled = await page.evaluate(() => window.handled);
check("Save scene goes to the handler", handled[0]?.path, "/data/save/handled.mrb");
check("which can read it", handled[0]?.size, (n) => n > 1000);
check("and nothing is downloaded", downloads.length - before, 0);
check("file-saved is sent", await page.evaluate(() => window.savedEvents), (p) => p.includes("/data/save/handled.mrb"));

// a node's Save to file
await page.evaluate(() => { window.handled = []; });
before = downloads.length;
const row = page.locator("[data-name=shItem]", { hasText: "MRHead" }).first();
await row.hover();
await row.locator("button[title^='More for']").click();
await page.getByRole("menuitem", { name: "Save to file" }).click();
await page.waitForFunction(() => window.handled.length > 0, null, { timeout: 60000 }).catch(() => null);
await page.waitForTimeout(1000);
handled = await page.evaluate(() => window.handled);
check("a node's Save to file goes to the handler", handled[0]?.path, "/data/save/MRHead.nrrd");
check("and nothing is downloaded", downloads.length - before, 0);

// Scene Views: Save picture, and a scene view kept in the scene
await page.evaluate(() => { window.handled = []; window.slicerWeb.store.activeModule = "SceneViews"; });
await page.waitForTimeout(2000);
const panel = page.locator(".sw-panel-scroll").last();
before = downloads.length;
await panel.locator("[data-name=savePicture]").click();
await page.waitForFunction(() => window.handled.length > 0, null, { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(1000);
handled = await page.evaluate(() => window.handled);
check("Save picture goes to the handler", handled[0]?.path, (p) => /^\/data\/save\/Slicer-.+\.png$/.test(p ?? ""));
check("as a PNG", handled[0] ? await page.evaluate(async (p) => {
  const [f] = await window.slicerWeb.readFiles([p]);
  return String.fromCharCode(...new Uint8Array(await f.slice(1, 4).arrayBuffer()));
}, handled[0].path) : null, "PNG");
check("and nothing is downloaded", downloads.length - before, 0);

await panel.locator("input[placeholder=Name]").fill("Kept view");
await panel.locator("[data-name=create]").click();
await page.waitForTimeout(3000);
check("the scene view has a picture",
  await page.evaluate(async () => (await window.slicerWeb.bridge.call("sceneViews")).find((v) => v.name === "Kept view")?.thumbnail ? "yes" : "no"), "yes");
await page.evaluate(() => { window.handled = []; });
await saveScene("withview.mrb");
await page.waitForFunction(() => window.handled.length > 0, null, { timeout: 60000 }).catch(() => null);
const reloaded = await page.evaluate(async () => {
  const s = window.slicerWeb;
  const [mrb] = await s.readFiles(["/data/save/withview.mrb"]);
  await s.bridge.call("closeScene");
  const [path] = await s.writeFiles([mrb], "/data/reload");
  await s.bridge.call("loadFiles", [[path]]);
  const view = (await s.bridge.call("sceneViews")).find((v) => v.name === "Kept view");
  return view ? (view.thumbnail ? "with its picture" : "without its picture") : "missing";
});
check("the scene view comes back with the saved scene", reloaded, "with its picture");

// a handler that fails: still nothing downloaded, the error is logged
await page.evaluate(() => {
  window.slicerWeb.saveHandler = async () => { throw new Error("upload refused"); };
});
before = downloads.length;
const consoleBefore = consoleErrors.length;
await saveScene("failed.mrb");
await page.waitForTimeout(5000);
check("a failing handler: nothing is downloaded", downloads.length - before, 0);
check("and the failure is logged", consoleErrors.slice(consoleBefore).join("\n"), (t) => t.includes("/data/save/failed.mrb"));
await page.evaluate(() => {
  window.slicerWeb.saveHandler = () => { throw new Error("thrown at once"); };
});
before = downloads.length;
await saveScene("thrown.mrb");
await page.waitForTimeout(5000);
check("a handler throwing at once: nothing is downloaded", downloads.length - before, 0);

// no handler: a download, as before
await page.evaluate(() => { window.slicerWeb.saveHandler = null; });
const download = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
await saveScene("downloaded.mrb");
const saved = await download;
check("without a handler, Save scene downloads", saved ? saved.suggestedFilename() : null, "downloaded.mrb");
if (saved) check("a zip file (.mrb)", fs.readFileSync(await saved.path()).toString("latin1", 0, 2), "PK");

check("no errors", errors.length, 0);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);

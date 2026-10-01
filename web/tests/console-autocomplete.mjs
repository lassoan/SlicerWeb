// Python console: slicer.util names without "slicer.util." (as on the desktop), completion order
// (as typed from the start, then in any case from the start, then anywhere), the parentheses a
// completed function gets and where the cursor goes, ")" typed over the one already there, and the
// window shortcuts (Ctrl+3 Python console, Ctrl+0 application log, Ctrl+4 Extensions Manager).
// Usage: node tests/console-autocomplete.mjs [url]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(`${base}?sample=`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
let failed = false;
const check = (what, ok, detail) => { if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${detail}`); };
const py = async (code) => String(await page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), code)).replace(/^'|'$/g, "");
const complete = (text) => page.evaluate((t) => window.slicerWeb.bridge.call("completePython", [t, t.length]), text);

// slicer.util in the console namespace
check("getNode without slicer.util.", (await py("getNode is slicer.util.getNode")) === "True", "getNode is slicer.util.getNode");
check("arrayFromVolume too", (await py("arrayFromVolume is slicer.util.arrayFromVolume")) === "True", "arrayFromVolume is slicer.util.arrayFromVolume");

// order: as typed from the start, then any case from the start, then anywhere
await page.evaluate(() => window.slicerWeb.bridge.evalPython("abcTest = 1; AbdTest = 2; aBxTest = 3; xabzTest = 4", "exec"));
const order = (await complete("ab")).items.map((i) => i.text).filter((t) => t.endsWith("Test"));
check("completion order", JSON.stringify(order) === JSON.stringify(["abcTest", "AbdTest", "aBxTest", "xabzTest"]), order.join(", "));

// functions: whether they take arguments
const items = Object.fromEntries((await complete("slicer.mrmlScene.GetNumberOfNodes")).items.map((i) => [i.text, i]));
const noArgs = items["slicer.mrmlScene.GetNumberOfNodes"];
check("a VTK method without arguments", noArgs?.callable && noArgs.takesArguments === false, JSON.stringify(noArgs));
const getNode = (await complete("getNod")).items.find((i) => i.text === "getNode");
check("a Python function with arguments", getNode?.callable && getNode.takesArguments === true, JSON.stringify(getNode));
const byId = (await complete("slicer.mrmlScene.GetNodeByI")).items.find((i) => i.text === "slicer.mrmlScene.GetNodeByID");
check("a VTK method with arguments", byId?.callable && byId.takesArguments === true, JSON.stringify(byId));

// in the console: the shortcut opens it, Tab completes, the parentheses and the cursor
await page.keyboard.press("Control+3");
await page.waitForTimeout(800);
const input = page.locator("[data-name='pythonConsole'] textarea");
check("Ctrl+3 opens the Python console", await input.count() === 1, `${await input.count()} console(s)`);
const focused = () => page.evaluate(() => document.activeElement?.closest("[data-name='pythonConsole']") !== null && document.activeElement?.tagName === "TEXTAREA");
check("and the input line has the focus", await focused(), "");
const typeAndComplete = async (text) => {
  await input.fill("");
  await input.click();
  await input.pressSequentially(text, { delay: 20 });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(800);
  // more than one: the first suggestion
  if (await page.getByRole("listbox", { name: "Completions" }).count()) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  }
  return page.evaluate(() => {
    const el = document.querySelector("[data-name='pythonConsole'] textarea");
    return { value: el.value, cursor: el.selectionStart };
  });
};
// (GetNumberOfNodes first of GetNumberOfNodes, GetNumberOfNodesByClass)
const r1 = await typeAndComplete("slicer.mrmlScene.GetNumberOfNodes");
check("no arguments: cursor after the parentheses", r1.value === "slicer.mrmlScene.GetNumberOfNodes()" && r1.cursor === r1.value.length,
  `${JSON.stringify(r1.value)}, cursor at ${r1.cursor}`);
const r2 = await typeAndComplete("getNod");
check("arguments: cursor inside the parentheses", r2.value === "getNode()" && r2.cursor === "getNode(".length, `${JSON.stringify(r2.value)}, cursor at ${r2.cursor}`);
await page.keyboard.type('"vtkMRMLScene*")', { delay: 20 });
const typed = await input.inputValue();
check('a ")" typed is added, also next to one', typed === 'getNode("vtkMRMLScene*"))', JSON.stringify(typed));

// the matched part of each suggestion is highlighted: at the start, or where it is in the name
await input.fill("");
await input.pressSequentially("ab", { delay: 20 });
await page.keyboard.press("Tab");
await page.waitForTimeout(800);
const highlighted = await page.getByRole("listbox", { name: "Completions" }).getByRole("option").evaluateAll((options) =>
  options.map((o) => [o.querySelector("span")?.textContent ?? "", o.querySelector("[data-name=completionMatch]")?.textContent ?? ""])
    .filter(([name]) => name.includes("Test")));
const want = [["abcTest()", "ab"], ["AbdTest()", "Ab"], ["aBxTest()", "aB"], ["xabzTest()", "ab"]];
const got = highlighted.map(([name, match]) => [name.replace("()", "").trim(), match]);
check("the matched part is highlighted", JSON.stringify(got) === JSON.stringify(want.map(([n, m]) => [n.replace("()", ""), m])), JSON.stringify(got));
await page.keyboard.press("Escape");

// shortcuts, also while typing in the console
await input.click();
await page.keyboard.press("Control+0");
await page.waitForTimeout(500);
check("Ctrl+0 opens the application log", await page.locator("[data-name='logWindow']").count() > 0 || await page.getByText("Application log").count() > 0,
  `${await page.locator("[data-name='logWindow']").count()} log window(s)`);
await page.keyboard.press("Control+0");
await page.waitForTimeout(500);
check("Ctrl+0 again closes it", await page.locator("[data-name='logWindow']").count() === 0, `${await page.locator("[data-name='logWindow']").count()} log window(s)`);
await page.keyboard.press("Control+4");
await page.waitForTimeout(1000);
const manager = () => page.getByText("Extensions Manager", { exact: true }).count();
check("Ctrl+4 opens the Extensions Manager", await manager() > 0, `${await manager()}`);
await page.keyboard.press("Control+4");
await page.waitForTimeout(500);
check("Ctrl+4 again closes it", await manager() === 0, `${await manager()}`);
await page.keyboard.press("Control+3");
await page.waitForTimeout(500);
check("Ctrl+3 again closes the Python console", await input.count() === 0, `${await input.count()} console(s)`);
// shown from the menu: the input line has the focus as well
await page.getByRole("button", { name: /application menu/i }).click();
await page.waitForTimeout(300);
await page.locator("[data-name='menu:python']").click();
await page.waitForTimeout(800);
check("opened from the menu, the input line has the focus", await focused(), "");
await browser.close();
console.log(failed ? "FAIL" : "ok");
process.exit(failed ? 1 : 0);

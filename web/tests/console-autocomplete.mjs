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

// docstrings: the summary is the line that says what it does (past a VTK method's signature lines)
check("a Python function's summary", typeof getNode?.summary === "string" && getNode.summary.length > 10 && getNode.doc?.includes(getNode.summary),
  JSON.stringify(getNode?.summary));
check("a VTK method's summary, not its signature", noArgs?.summary === "Get number of nodes in the scene" && /^GetNumberOfNodes\(/m.test(noArgs.doc ?? ""),
  JSON.stringify(noArgs?.summary));
// one whose docstring has no description: its signature, which says the most there is
check("a VTK method without a description: its signature", byId?.summary?.startsWith("GetNodeByID("), JSON.stringify(byId?.summary));
const value = (await complete("abcTes")).items.find((i) => i.text === "abcTest");
check("no docstring for a value", value && value.summary === undefined, JSON.stringify(value));

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

// Page Down / Page Up page the list of suggestions (a page: what the list shows at a time), stopping at its ends
await input.fill("");
await input.pressSequentially("slicer.mrmlScene.G", { delay: 20 });
await page.keyboard.press("Tab");
await page.waitForTimeout(800);
const list = page.getByRole("listbox", { name: "Completions" });

// the docstring of the suggestion the list is on, and the summaries in the rows
const docPanel = page.locator("[data-name=completionDoc]");
const firstDoc = await docPanel.innerText().catch(() => "");
const summaries = await list.locator("[data-name=completionSummary]").allInnerTexts();
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(200);
const secondDoc = await docPanel.innerText().catch(() => "");
// under the list, above the prompt, and within the console (not over the views above it)
const panelPlaced = await page.evaluate(() => {
  const d = document.querySelector("[data-name=completionDoc]")?.getBoundingClientRect();
  const l = document.querySelector("[role=listbox]")?.getBoundingClientRect();
  const c = document.querySelector("[data-name=pythonConsole]")?.getBoundingClientRect();
  const t = document.querySelector("[data-name=pythonConsole] textarea")?.getBoundingClientRect();
  return !!d && !!l && !!c && !!t && d.top >= l.bottom - 1 && d.bottom <= t.top + 1 && l.top >= c.top - 1;
});
check("the docstring of the highlighted suggestion shows, under the list, in the console", firstDoc.length > 20 && secondDoc.length > 20 && firstDoc !== secondDoc && panelPlaced,
  `${JSON.stringify(firstDoc.split("\n").slice(0, 2).join(" | "))} then ${JSON.stringify(secondDoc.split("\n").slice(0, 2).join(" | "))}`);
check("the rows show summaries", summaries.filter((s) => s && !s.startsWith("slicer.")).length > summaries.length / 2,
  `${summaries.filter((s) => s && !s.startsWith("slicer.")).length} of ${summaries.length}: ${JSON.stringify(summaries.slice(0, 3))}`);
const shotPath = process.argv[3];
if (shotPath) await page.locator("[data-name=pythonConsole]").screenshot({ path: shotPath });
await page.keyboard.press("ArrowUp");
const active = () => list.evaluate((l) => [...l.querySelectorAll("[role=option]")].findIndex((o) => o.getAttribute("aria-selected") === "true"));
const shown = await list.evaluate((l) => Math.floor(l.clientHeight / l.querySelector("li").offsetHeight));
const total = await list.getByRole("option").count();
await page.keyboard.press("PageDown");
const afterDown = await active();
await page.keyboard.press("PageDown");
const afterTwo = await active();
await page.keyboard.press("PageUp");
const afterUp = await active();
for (let i = 0; i < Math.ceil(total / Math.max(1, shown - 1)) + 2; i++) await page.keyboard.press("PageDown");
const atEnd = await active();
const visible = await list.evaluate((l) => { const o = l.querySelector("[aria-selected=true]"); const a = o.getBoundingClientRect(), b = l.getBoundingClientRect(); return a.top >= b.top - 1 && a.bottom <= b.bottom + 1; });
for (let i = 0; i < Math.ceil(total / Math.max(1, shown - 1)) + 2; i++) await page.keyboard.press("PageUp");
const atStart = await active();
check("Page Down / Page Up page the suggestions", total > shown && afterDown >= 1 && afterTwo === 2 * afterDown && afterUp === afterDown && atEnd === total - 1 && atStart === 0 && visible,
  `${total} suggestions, ${shown} shown: down ${afterDown}, down ${afterTwo}, up ${afterUp}, to the end ${atEnd} (in view: ${visible}), to the start ${atStart}`);
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

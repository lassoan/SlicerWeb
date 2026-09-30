// Button groups of a Qt Designer file (<buttongroups>): the loader makes them as Qt's does, so that a
// radio button knows its group() and the group is one of the ui variables, and checking one button
// of an exclusive group unchecks the others. Loads the .ui file of a module and reports its groups.
// Usage: node tests/ui-button-groups.mjs [url] ExtensionName Module
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const base = args[0] && /^https?:/.test(args[0]) ? args.shift() : "http://localhost:5173/";
const [extension, module] = args;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e}`));
await page.goto(`${base}?sample=&extensions=${encodeURIComponent(extension)}`);
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForFunction(async (m) => String(await window.slicerWeb.bridge.evalPython(
  `str(hasattr(slicer.modules, ${JSON.stringify(m.toLowerCase())}))`, "eval")).includes("True"), module, { timeout: 600000, polling: 2000 });

await page.evaluate((m) => window.slicerWeb.bridge.evalPython(`
import json, qt, slicer
_ui = slicer.util.loadUI(slicer.modules.${m.toLowerCase()}.path.replace("${m}.py", "Resources/UI/${m}.ui"))
_groups = [g for g in _ui.findChildren(qt.QButtonGroup)]
_out = []
for _g in _groups:
    _buttons = list(_g.buttons())
    _entry = {"name": _g.objectName, "buttons": [b.objectName for b in _buttons], "exclusive": _g.exclusive,
              "groupOfButtons": all(b.group() is _g for b in _buttons)}
    if len(_buttons) > 1 and _g.exclusive:
        _buttons[0].setChecked(True)
        _buttons[1].setChecked(True)
        _entry["checkedAfterSecond"] = [b.objectName for b in _buttons if b.isChecked()]
    _out.append(_entry)
_result = json.dumps({"groups": _out, "inUiVariables": [n for n in (e["name"] for e in _out) if n in slicer.util.childWidgetVariables(_ui).__dict__]})
`, "exec"), module);
const result = JSON.parse(String(await page.evaluate(() => window.slicerWeb.bridge.evalPython("_result", "eval"))).replace(/^'|'$/g, ""));

let failed = !result.groups.length;
for (const g of result.groups) {
  const exclusiveOk = !("checkedAfterSecond" in g) || (g.checkedAfterSecond.length === 1 && g.checkedAfterSecond[0] === g.buttons[1]);
  const ok = g.groupOfButtons && g.buttons.length > 0 && exclusiveOk && result.inUiVariables.includes(g.name);
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${g.name}: ${g.buttons.join(", ")}; group() ${g.groupOfButtons ? "right" : "WRONG"}; ` +
    `exclusive ${g.exclusive}${"checkedAfterSecond" in g ? `, checked after checking the second: ${g.checkedAfterSecond.join(", ")}` : ""}; ` +
    `ui.${g.name} ${result.inUiVariables.includes(g.name) ? "there" : "MISSING"}`);
}
await browser.close();
console.log(failed ? "FAIL" : "ok");
process.exit(failed ? 1 : 0);

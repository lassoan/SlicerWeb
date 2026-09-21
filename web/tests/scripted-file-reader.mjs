// A module that brings its own file format: a class named <Module>FileReader (and FileWriter) is
// found and added to the list of readers and writers - vtkSlicerFileIOManager, the VTK class that
// stands where qSlicerCoreIOManager's list does on the desktop - so that such a file can be opened
// and saved like any other. The path widget of a module chooses a file in the browser.
// Usage: node tests/scripted-file-reader.mjs [url] [screenshot.png]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:5173/";
const shot = process.argv.find((a) => a.endsWith(".png"));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror] " + e));
await page.goto(base + "?sample=");
await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 300000 });
await page.waitForTimeout(2000);
await page.evaluate(() => { window.__logs = []; window.slicerWeb.bridge.events.on("log", (e) => window.__logs.push(e)); });
const run = (code) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c), code);
const value = (expr) => page.evaluate((c) => window.slicerWeb.bridge.evalPython(c, "eval"), expr);

// what the application itself reads, before any module has added anything
console.log("file types of the application:", await value(`", ".join(
    __import__("slicerweb.io_registry", fromlist=["x"]).file_types()[:6])`));
console.log("a volume is read by:", await value(`slicer.app.coreIOManager().fileType("/data/head.nrrd")`)
  .catch(async () => value(`__import__("slicer").app.coreIOManager().fileType("/data/head.nrrd")`)));

// a module with a reader and a writer of its own, written the way a module on the desktop is
await run(`
import os, slicer
os.makedirs("/data/modules", exist_ok=True)
module = '''
import os
import slicer
import vtk
from slicer.ScriptedLoadableModule import *


class MyFormat(ScriptedLoadableModule):
    def __init__(self, parent):
        ScriptedLoadableModule.__init__(self, parent)
        parent.title = "My Format"
        parent.categories = ["Testing"]
        parent.helpText = "Reads and writes .mft files."


class MyFormatWidget(ScriptedLoadableModuleWidget):
    def setup(self):
        ScriptedLoadableModuleWidget.setup(self)
        import qt, ctk
        self.pathEdit = ctk.ctkPathLineEdit()
        self.pathEdit.setNameFilters(["My file type (*.mft)"])
        self.pathEdit.objectName = "inputPath"
        self.layout.addWidget(self.pathEdit)
        self.loadButton = qt.QPushButton("Load")
        self.loadButton.objectName = "loadButton"
        self.loadButton.connect("clicked()", self.onLoad)
        self.layout.addWidget(self.loadButton)

    def onLoad(self):
        slicer.util.loadNodeFromFile(self.pathEdit.currentPath)


class MyFormatFileReader:
    def __init__(self, parent):
        self.parent = parent

    def description(self):
        return "My file type"

    def fileType(self):
        return "MyFileType"

    def extensions(self):
        return ["My file type (*.mft)"]

    def canLoadFileConfidence(self, filePath):
        if not self.parent.supportedNameFilters(filePath):
            return 0.0
        with open(filePath) as handle:
            return 0.9 if handle.readline().strip() == "magic" else 0.2

    def load(self, properties):
        filePath = properties["fileName"]
        with open(filePath) as handle:
            lines = handle.readlines()
        if not lines or lines[0].strip() != "magic":
            self.parent.userMessages().AddMessage(vtk.vtkCommand.ErrorEvent, "not my kind of file")
            return False
        name = properties.get("name") or os.path.splitext(os.path.basename(filePath))[0]
        node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLTextNode", name)
        node.SetText("".join(lines[1:]))
        node.SetAttribute("MyFileCategory", "aaa")
        self.parent.loadedNodes = [node.GetID()]
        return True


class MyFormatFileWriter:
    def __init__(self, parent):
        self.parent = parent

    def description(self):
        return "My file type"

    def fileType(self):
        return "MyFileType"

    def extensions(self, obj):
        return ["My file type (*.mft)"]

    def canWriteObjectConfidence(self, obj):
        if obj is None or not obj.IsA("vtkMRMLTextNode"):
            return 0.0
        return 0.9 if obj.GetAttribute("MyFileCategory") == "aaa" else 0.3

    def write(self, properties):
        node = slicer.mrmlScene.GetNodeByID(properties["nodeID"])
        with open(properties["fileName"], "w") as handle:
            handle.write("magic" + chr(10))
            handle.write(node.GetText())
        self.parent.writtenNodes = [node.GetID()]
        return True
'''
with open("/data/modules/MyFormat.py", "w") as handle:
    handle.write(module)
slicer.app.moduleManager().addModulePath("/data/modules")
slicer.app.moduleManager().loadModule("MyFormat")
# tell the page about the module that appeared, as loading an extension does
from slicerweb import host
host.emit("modules-changed", slicer.app.moduleManager().moduleSummaries())
_out = "module loaded: %s" % (slicer.app.moduleManager().module("MyFormat") is not None)
`);
console.log(await value("_out"));

console.log("the reader is in the list:", await value(`", ".join(
    line for line in __import__("slicerweb.io_registry", fromlist=["x"]).describe() if "MyFileType" in line)`));

// a file of that kind, read without anyone saying what it is
await run(`
with open("/data/example.mft", "w") as handle:
    handle.write("magic" + chr(10) + "the text of the file")
with open("/data/plain.txt", "w") as handle:
    handle.write("just text")
`);
console.log("file type of example.mft:", await value(`slicer.app.coreIOManager().fileType("/data/example.mft")`));
console.log("file type of plain.txt:  ", await value(`slicer.app.coreIOManager().fileType("/data/plain.txt")`));
await run(`node = slicer.util.loadNodeFromFile("/data/example.mft")`);
console.log("loaded:", await value(`"%s named %s holding %s" % (node.GetClassName(), node.GetName(), repr(node.GetText()))`));

// and written back out through the module's writer
console.log("writer chosen for the node:", await value(`"%s of %s, for %s" % (
    slicer.app.coreIOManager().writerForNode(node, "/data/written.mft").GetFileType(),
    slicer.app.coreIOManager().writerForNode(node, "/data/written.mft").GetOwner(),
    slicer.app.coreIOManager().fileWriterFileType(node))`));
await run(`saved = slicer.util.saveNode(node, "/data/written.mft")`);
console.log("saved:", await value(`str(saved)`), "|",
  await value(`repr(open("/data/written.mft").read())`));

// the path widget of the module: a file is chosen with the file picker of the browser
await page.locator("[data-name='moduleTitle']").click();
await page.getByPlaceholder("Search modules").fill("My Format");
await page.waitForTimeout(500);
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);
console.log("module panel shows:", (await page.locator(".sw-panel-scroll").last().innerText()).replace(/\s+/g, " ").slice(0, 120));
console.log("path elements in the panel:", await page.locator("sw-pathlineedit").count());
const pathWidget = page.locator("[data-name='inputPath']");
console.log("the module shows a path widget:", await pathWidget.count() > 0,
  "| with a Browse button:", await pathWidget.locator("[data-name='browse']").count() > 0);
console.log("it offers:", await pathWidget.locator("[data-name='filePicker']").getAttribute("accept"));

await pathWidget.locator("[data-name='filePicker']").setInputFiles({
  name: "chosen.mft", mimeType: "text/plain", buffer: Buffer.from("magic\nchosen through the file picker"),
});
await page.waitForTimeout(1500);
console.log("the path widget now holds:", await pathWidget.locator("[data-name='currentPath']").inputValue());
console.log("what the module sees as the path:", await value(`repr(
    slicer.modules.myformat.widgetRepresentation().pathEdit.currentPath)`));
await page.locator("[data-name='loadButton'] button").click();
await page.waitForTimeout(2000);
console.log("text nodes in the scene:", await value(`", ".join(
    "%s=%s" % (n.GetName(), repr(n.GetText())[:40])
    for n in slicer.util.getNodesByClass("vtkMRMLTextNode"))`));

// what a module brings goes away when it is reloaded, and comes back
console.log("reload:", await value(`"%s" % (slicer.util.reloadScriptedModule("MyFormat"),)`)
  .catch((e) => String(e).slice(0, 400)));
await page.waitForTimeout(1500);
console.log("after reloading, readers of MyFileType:", await value(`str(
    slicer.app.coreIOManager().registeredFileReaderCount("MyFileType"))`));
if (shot) await page.screenshot({ path: shot });
await browser.close();

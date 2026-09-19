// Copy the Pyodide distribution and patch its Emscripten dynamic linker for many shared libraries.
//
// Usage: node prepare-pyodide.mjs <pyodide dist dir> <output dir>
//
// Emscripten's reportUndefinedSymbols() walks the entire global offset table (GOT) after each
// loaded library. With the ~300 VTK/ITK/Slicer side modules the GOT holds several hundred thousand
// entries, so loading becomes quadratic (about 35 s of a 60 s startup). The patch keeps a set of the
// unresolved GOT entries and visits only those.
// Libraries loaded as dependencies of Python extension modules were loaded locally, and all their
// exports were copied into the local scope of each dependent module (about 15 s). lib*.so libraries
// are now loaded globally, and exports of global libraries are not copied.
import fs from "node:fs";
import path from "node:path";

export function patchPyodideAsm(text) {
  const patches = [
    [
      // GOT entries created as unresolved (-1) are recorded
      "rtn=GOT[symName]=new WebAssembly.Global({value:\"i32\",mutable:true},-1)}",
      "rtn=GOT[symName]=new WebAssembly.Global({value:\"i32\",mutable:true},-1);swPendingGOT.add(symName)}",
    ],
    [
      "var reportUndefinedSymbols=()=>{for(var[symName,entry]of Object.entries(GOT)){if(entry.value==-1){",
      "var swPendingGOT=new Set;var reportUndefinedSymbols=()=>{for(var symName of swPendingGOT){var entry=GOT[symName];if(entry.value!=-1){swPendingGOT.delete(symName);continue}{swPendingGOT.delete(symName);",
    ],
    [
      // Regular shared libraries (lib*.so: VTK, ITK, Slicer, ...) are loaded globally, as the
      // dependencies of a native executable are. Otherwise a library loaded as a dependency of a
      // Python extension module is local and its exports (up to ~100000) are copied into the local
      // scope of every module that depends on it (25 million copies at SlicerWeb startup).
      "function loadDynamicLibrary(libName,flags={global:true,nodelete:true},localScope,handle){libName=PATH.normalize(libName);",
      "function loadDynamicLibrary(libName,flags={global:true,nodelete:true},localScope,handle){libName=PATH.normalize(libName);if(!flags.global&&libName.endsWith(\".so\")&&libName.split(\"/\").pop().startsWith(\"lib\")){flags=Object.assign({},flags,{global:true})}",
    ],
    [
      // A library that is already loaded globally has its exports in the global symbol table, where
      // symbol resolution finds them after the local scope; copying all of them (up to ~100000) into
      // the local scope of every Python extension module that depends on it is not needed.
      "if(!flags.global){if(localScope){Object.assign(localScope,dso.exports)}}",
      "if(!flags.global){if(localScope&&!dso.global){Object.assign(localScope,dso.exports)}}",
    ],
  ];
  for (const [from, to] of patches) {
    const n = text.split(from).length - 1;
    if (n !== 1) throw new Error(`prepare-pyodide: expected exactly one match of ${JSON.stringify(from.slice(0, 60))}..., found ${n}`);
    text = text.replace(from, to);
  }
  return text;
}

export function preparePyodide(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const file = path.join(src, name);
    if (!fs.statSync(file).isFile()) continue;
    if (name === "pyodide.asm.mjs" || name === "pyodide.asm.js") {
      fs.writeFileSync(path.join(dst, name), patchPyodideAsm(fs.readFileSync(file, "utf8")));
    } else {
      fs.copyFileSync(file, path.join(dst, name));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) {
    console.error("Usage: node prepare-pyodide.mjs <pyodide dist dir> <output dir>");
    process.exit(2);
  }
  preparePyodide(src, dst);
  console.log(`Patched Pyodide written to ${dst}`);
}

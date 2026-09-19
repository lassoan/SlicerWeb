"""Package SlicerWeb install trees as Pyodide wheels.

Wheels (all installed into site-packages):

- vtk                  vtkmodules/ (Python modules) + vtk_libs/ (VTK shared libraries)
- slicerweb-itk        slicerweb_itk/ (ITK shared libraries)
- slicer-core          slicer/ package, kit modules (mrml.py, ...), slicer_home/lib|share/Slicer-X.Y
                       (MRML, logic, displayable managers, vtkAddon, vtkITK, SlicerWebCore, ...)
- slicer-modules-core  slicer_home/lib|share/Slicer-X.Y/qt-loadable-modules (Slicer core modules)
- slicerweb            slicerweb/ runtime and qt/ctk compatibility modules (pure Python)

Pyodide loads every shared library contained in a wheel when the wheel is installed; libraries needed
by other wheels are found by name among already loaded libraries, so installation order matters:
vtk, slicerweb-itk, slicer-core, slicer-modules-core, slicerweb.
"""

import argparse
import base64
import glob
import hashlib
import io
import os
import shutil
import sys
import zipfile

PLATFORM_TAG = os.environ.get("PYODIDE_PLATFORM_TAG", "pyemscripten_2026_0_wasm32")
PY_TAG = "cp314"


class Wheel:
    def __init__(self, name, version, pure=False, requires=(), summary=""):
        self.name = name
        self.dist = name.replace("-", "_")
        self.version = version
        self.tag = "py3-none-any" if pure else f"{PY_TAG}-{PY_TAG}-{PLATFORM_TAG}"
        self.files = {}  # archive path -> bytes or source file path
        self.requires = list(requires)
        self.summary = summary
        self.entry_points = {}

    def add_file(self, source, arcname):
        self.files[arcname.replace("\\", "/")] = source

    def add_bytes(self, data, arcname):
        self.files[arcname] = data if isinstance(data, bytes) else data.encode("utf8")

    def add_tree(self, source_dir, arc_prefix, include=None, exclude=None):
        count = 0
        for root, dirs, files in os.walk(source_dir):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for f in files:
                path = os.path.join(root, f)
                rel = os.path.relpath(path, source_dir)
                if include and not include(rel):
                    continue
                if exclude and exclude(rel):
                    continue
                self.add_file(path, os.path.join(arc_prefix, rel) if arc_prefix else rel)
                count += 1
        return count

    def write(self, out_dir):
        os.makedirs(out_dir, exist_ok=True)
        filename = f"{self.dist}-{self.version}-{self.tag}.whl"
        path = os.path.join(out_dir, filename)
        dist_info = f"{self.dist}-{self.version}.dist-info"
        metadata = [
            "Metadata-Version: 2.1",
            f"Name: {self.name}",
            f"Version: {self.version}",
            f"Summary: {self.summary}",
            "License: BSD-style (3D Slicer license); see https://slicer.org",
        ] + [f"Requires-Dist: {r}" for r in self.requires]
        wheel_meta = ["Wheel-Version: 1.0", "Generator: slicerweb-make-wheels", f"Root-Is-Purelib: {'true' if self.tag == 'py3-none-any' else 'false'}",
                      f"Tag: {self.tag}"]
        extra = {f"{dist_info}/METADATA": "\n".join(metadata) + "\n", f"{dist_info}/WHEEL": "\n".join(wheel_meta) + "\n"}
        if self.entry_points:
            lines = []
            for group, entries in self.entry_points.items():
                lines.append(f"[{group}]")
                lines += [f"{k} = {v}" for k, v in entries.items()]
            extra[f"{dist_info}/entry_points.txt"] = "\n".join(lines) + "\n"
        record = []
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for arcname, src in sorted(list(self.files.items()) + [(k, v.encode("utf8")) for k, v in extra.items()]):
                data = src if isinstance(src, bytes) else open(src, "rb").read()
                zf.writestr(arcname, data)
                digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
                record.append(f"{arcname},sha256={digest},{len(data)}")
            record.append(f"{dist_info}/RECORD,,")
            zf.writestr(f"{dist_info}/RECORD", "\n".join(record) + "\n")
        size = os.path.getsize(path) / 1e6
        print(f"  {filename}  ({len(self.files)} files, {size:.1f} MB)")
        return path


def is_wasm(path):
    with open(path, "rb") as f:
        return f.read(4) == b"\0asm"


def dylink_needed(path):
    """Names of the shared libraries a WebAssembly side module needs (dylink.0 WASM_DYLINK_NEEDED)."""
    def leb(b, i):
        result = shift = 0
        while True:
            x = b[i]
            i += 1
            result |= (x & 0x7F) << shift
            shift += 7
            if x < 0x80:
                return result, i

    b = open(path, "rb").read()
    i = 8
    while i < len(b):
        section_id = b[i]
        size, i = leb(b, i + 1)
        end = i + size
        if section_id == 0:
            name_len, j = leb(b, i)
            if b[j:j + name_len] == b"dylink.0":
                j += name_len
                while j < end:
                    kind = b[j]
                    sub_size, j = leb(b, j + 1)
                    if kind == 2:  # WASM_DYLINK_NEEDED
                        count, k = leb(b, j)
                        names = []
                        for _ in range(count):
                            n, k = leb(b, k)
                            names.append(b[k:k + n].decode())
                            k += n
                        return names
                    j += sub_size
                return []
        i = end
    return []


def needed_closure(roots, libraries):
    """Names of libraries (from {name: path}) needed, directly or indirectly, by the root libraries."""
    result = set()
    stack = [lib for root in roots for lib in dylink_needed(root)]
    while stack:
        name = os.path.basename(stack.pop())
        if name in libraries and name not in result:
            result.add(name)
            stack.extend(dylink_needed(libraries[name]))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--install", default="/build/install")
    parser.add_argument("--src", default="/build/src")
    parser.add_argument("--build", default="/build")
    parser.add_argument("--python", default="/work/python")
    parser.add_argument("--out", default="/dist/wheels")
    parser.add_argument("--extensions-out", default="/dist/extensions")
    args = parser.parse_args()

    if os.path.isdir(args.out):
        for old in glob.glob(os.path.join(args.out, "*.whl")):
            os.remove(old)
    print("Writing wheels to", args.out)

    # ---------------------------------------------------------------- VTK
    vtk_install = os.path.join(args.install, "vtk")
    site = glob.glob(os.path.join(vtk_install, "lib", "python3*", "site-packages"))[0]
    vtk_version = open(os.path.join(args.src, "VTK", "CMake", "vtkVersion.cmake")).read()
    ver = [line.split()[1].rstrip(")") for line in vtk_version.splitlines() if line.startswith("set(VTK_") and "_VERSION " in line][:3]
    w = Wheel("vtk", ".".join(ver), summary="VTK Python modules built for Pyodide (WebAssembly)")
    w.add_tree(site, "", exclude=lambda rel: rel.endswith(".pyc"))
    for lib in sorted(glob.glob(os.path.join(vtk_install, "lib", "*.so"))):
        # (libvtkWrappingTools is needed at runtime too: Slicer's wrapped kits link it)
        if not is_wasm(lib):
            continue
        w.add_file(lib, "vtk_libs/" + os.path.basename(lib))
    w.write(args.out)

    # ---------------------------------------------------------------- ITK
    # slicerweb-itk: the ITK libraries that Slicer's libraries need (loaded at startup);
    # slicerweb-itk-extra: the other ITK modules (e.g. filters used by extensions), installed with the
    # extensions that need them.
    itk_install = os.path.join(args.install, "itk")
    itk_libs = {os.path.basename(p): p for p in glob.glob(os.path.join(itk_install, "lib", "*.so"))}
    slicer_libs = [p for p in glob.glob(os.path.join(args.install, "slicer", "lib", "**", "*.so"), recursive=True) if is_wasm(p)]
    core_itk = needed_closure(slicer_libs, itk_libs)
    w = Wheel("slicerweb-itk", "5.4.7", summary="ITK shared libraries used by 3D Slicer, built for Pyodide (WebAssembly)")
    for name in sorted(core_itk):
        w.add_file(itk_libs[name], "slicerweb_itk/" + name)
    w.write(args.out)
    w = Wheel("slicerweb-itk-extra", "5.4.7", summary="Other ITK shared libraries (used by extensions), built for Pyodide")
    for name in sorted(set(itk_libs) - core_itk):
        w.add_file(itk_libs[name], "slicerweb_itk/" + name)
    w.write(args.out)
    args.core_itk = core_itk
    args.itk_libs = itk_libs

    # ---------------------------------------------------------------- Slicer core
    slicer_install = os.path.join(args.install, "slicer")
    lib_dir = glob.glob(os.path.join(slicer_install, "lib", "Slicer-*"))[0]
    slicer_ver = os.path.basename(lib_dir).split("-", 1)[1]
    share_dir = os.path.join(slicer_install, "share", f"Slicer-{slicer_ver}")
    slicer_src = os.path.join(args.src, "Slicer")
    version_full = slicer_ver + ".0"
    w = Wheel("slicer-core", version_full, summary="3D Slicer core libraries (MRML, logic, displayable managers) for Pyodide")
    w.add_tree(lib_dir, f"slicer_home/lib/Slicer-{slicer_ver}",
               exclude=lambda rel: rel.startswith("qt-loadable-modules") or rel.startswith("qt-scripted-modules") or rel.endswith(".a"))
    # Shared third-party libraries: SlicerExecutionModel ModuleDescriptionParser (used by MRMLCLI),
    # teem (vtkTeem, NRRD) and libarchive (.mrb scene bundles)
    third_party = glob.glob(os.path.join(args.build, "sem", "**", "libModuleDescriptionParser*.so"), recursive=True)
    third_party += glob.glob(os.path.join(args.install, "teem", "lib", "**", "libteem*.so"), recursive=True)
    third_party += glob.glob(os.path.join(args.install, "libarchive", "lib", "libarchive*.so"))
    for lib in third_party:
        if is_wasm(lib):
            w.add_file(lib, f"slicer_home/lib/Slicer-{slicer_ver}/" + os.path.basename(lib))
    if os.path.isdir(share_dir):
        w.add_tree(share_dir, f"slicer_home/share/Slicer-{slicer_ver}", exclude=lambda rel: rel.startswith("qt-loadable-modules"))
    # slicer Python package (unchanged from Slicer), kits, and kit modules
    base_python = os.path.join(slicer_src, "Base", "Python")
    w.add_tree(os.path.join(base_python, "slicer"), "slicer",
               exclude=lambda rel: rel.startswith("tests") or rel.endswith(".in") or rel.startswith("release"))
    # Same kits as desktop Slicer (without the PythonQt ones), plus the SlicerWeb views that replace
    # the qMRMLWidgets kit (vtkSlicerWebSliceView, vtkSlicerWebThreeDView).
    kits = ["mrml", "vtkAddon", "vtkSegmentationCore", "slicerwebcore", "logic"]
    w.add_bytes("available_kits = [ %s ]\n" % ", ".join(repr(k) for k in kits), "slicer/kits.py")
    for name in ("mrml.py", "vtkAddon.py", "vtkITK.py", "vtkSegmentationCore.py", "vtkTeem.py", "sitkUtils.py"):
        path = os.path.join(base_python, name)
        if os.path.exists(path):
            w.add_file(path, name)
    if not os.path.exists(os.path.join(base_python, "vtkTeem.py")):
        w.add_bytes('"""vtkTeem classes."""\nimport vtk  # noqa: F401\nfrom vtkTeemPython import *  # noqa: F401,F403\n', "vtkTeem.py")
    w.add_bytes('"""This module loads all the classes from the SlicerWebCore library into its namespace."""\n'
                "import vtk  # noqa: F401\nfrom SlicerWebCorePython import *  # noqa: F401,F403\ndel vtk\n", "slicerwebcore.py")
    w.add_bytes(f'SLICER_VERSION_FULL = "{version_full}"\n', "slicerweb_build_info.py")
    w.write(args.out)

    # ---------------------------------------------------------------- Slicer core modules
    modules_lib = os.path.join(lib_dir, "qt-loadable-modules")
    modules_share = os.path.join(share_dir, "qt-loadable-modules")
    w = Wheel("slicer-modules-core", version_full, summary="3D Slicer core loadable modules (Qt-free libraries) for Pyodide")
    w.add_tree(modules_lib, f"slicer_home/lib/Slicer-{slicer_ver}/qt-loadable-modules", exclude=lambda rel: rel.endswith(".a"))
    if os.path.isdir(modules_share):
        w.add_tree(modules_share, f"slicer_home/share/Slicer-{slicer_ver}/qt-loadable-modules")
    # Core Python scripted modules and packages used by extensions, in the desktop layout
    # (lib/Slicer-X.Y/qt-scripted-modules, module resources merged in qt-scripted-modules/Resources)
    scripted = f"slicer_home/lib/Slicer-{slicer_ver}/qt-scripted-modules"
    modules_src = os.path.join(slicer_src, "Modules")
    not_installed = lambda rel: rel.endswith(("CMakeLists.txt", ".in", ".pyc")) or "__pycache__" in rel  # noqa: E731
    for module in ("SampleData", "SegmentStatistics"):
        module_dir = os.path.join(modules_src, "Scripted", module)
        w.add_file(os.path.join(module_dir, module + ".py"), f"{scripted}/{module}.py")
        if os.path.isdir(os.path.join(module_dir, "Resources")):
            w.add_tree(os.path.join(module_dir, "Resources"), f"{scripted}/Resources", exclude=not_installed)
    for package_dir, package in (
            ("Scripted/SegmentStatistics/SegmentStatisticsPlugins", "SegmentStatisticsPlugins"),
            ("Loadable/SubjectHierarchy/Widgets/Python/SubjectHierarchyPlugins", "SubjectHierarchyPlugins"),
            ("Loadable/Segmentations/EditorEffects/Python/SegmentEditorEffects", "SegmentEditorEffects")):
        w.add_tree(os.path.join(modules_src, package_dir), f"{scripted}/{package}", exclude=not_installed)
    w.write(args.out)

    # ---------------------------------------------------------------- slicerweb runtime (pure Python)
    w = Wheel("slicerweb", "0.1.0", pure=True, summary="3D Slicer application services for the web browser")
    w.add_tree(args.python, "", exclude=lambda rel: rel.endswith(".pyc") or rel.startswith("tests"))
    w.write(args.out)

    write_extension_wheels(args, slicer_ver)


# ---------------------------------------------------------------------------- extensions
EXTENSION_FIELDS = ("HOMEPAGE", "CATEGORY", "CONTRIBUTORS", "DESCRIPTION", "ICONURL", "SCREENSHOTURLS", "STATUS", "DEPENDS")


def extension_metadata(source_dir):
    """EXTENSION_* settings of an extension's top-level CMakeLists.txt (as the Slicer extension index uses)."""
    import re

    text = open(os.path.join(source_dir, "CMakeLists.txt"), encoding="utf8").read()
    project = re.search(r"^\s*project\(\s*([A-Za-z0-9_]+)", text, re.M).group(1)
    meta = {"name": project}
    for field in EXTENSION_FIELDS:
        m = re.search(r"set\(\s*EXTENSION_%s\s+(.*?)\)\s*(#.*)?$" % field, text, re.M | re.S)
        if not m:
            continue
        value = m.group(1).strip()
        value = re.sub(r"\\\s*\n\s*", " ", value)  # line continuations
        if value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        meta[field.lower()] = " ".join(value.split())
    depends = meta.get("depends", "")
    meta["depends"] = [] if depends in ("", "NA") else depends.replace(";", " ").split()
    meta["contributors"] = [c.strip() for c in re.split(r"\),\s*", meta.get("contributors", "")) if c.strip()]
    meta["contributors"] = [c if c.endswith(")") or "(" not in c else c + ")" for c in meta["contributors"]]
    meta["screenshots"] = meta.pop("screenshoturls", "").split()
    meta["icon"] = meta.pop("iconurl", "")
    return meta


def write_extension_wheels(args, slicer_ver):
    """One wheel per extension installed in <install>/ext/<Name> (scripts/stages/80-extensions.sh),
    plus the extension index (index.json) read by the Extensions Manager."""
    import json
    import subprocess

    ext_root = os.path.join(args.install, "ext")
    if not os.path.isdir(ext_root):
        return
    os.makedirs(args.extensions_out, exist_ok=True)
    for old in glob.glob(os.path.join(args.extensions_out, "*.whl")):
        os.remove(old)
    print("Writing extension wheels to", args.extensions_out)
    index = []
    for name in sorted(os.listdir(ext_root)):
        install_dir = os.path.join(ext_root, name)
        source_dir = os.path.join(args.src, name)
        if not os.path.isfile(os.path.join(source_dir, "CMakeLists.txt")):
            continue
        meta = extension_metadata(source_dir)
        try:
            revision = subprocess.run(["git", "-C", source_dir, "rev-parse", "--short=10", "HEAD"], capture_output=True,
                                      text=True, check=True).stdout.strip()
        except Exception:
            revision = ""
        meta["revision"] = revision
        dist = "slicer-ext-" + name.lower()
        w = Wheel(dist, "0.1.0", summary=meta.get("description", name))
        # Same layout as the Slicer home (desktop extensions have their own tree, but in the browser all
        # modules share one virtual file system; file names do not collide)
        for sub in ("lib", "share"):
            d = os.path.join(install_dir, sub)
            if os.path.isdir(d):
                w.add_tree(d, "slicer_home/" + sub,
                           exclude=lambda rel: rel.endswith((".a", ".pyc", ".cmake")) or "/cmake/" in rel.replace("\\", "/")
                           or rel.startswith("cmake"))
        meta["modules"] = sorted(
            {os.path.splitext(os.path.basename(f))[0] for f in w.files
             if "/qt-scripted-modules/" in f and f.count("/") == 4 and f.endswith(".py")}
            | {os.path.basename(f).split(".")[0] for f in w.files if f.endswith(".slicerweb-module.json")})
        w.add_bytes(json.dumps(meta, indent=1), f"slicer_home/share/Slicer-{slicer_ver}/extensions/{name}.json")
        path = w.write(args.extensions_out)
        entry = dict(meta)
        entry.update({"version": revision or "0.1.0", "wheel": os.path.basename(path)})
        # Base wheels needed besides the startup wheels (relative to the wheels index)
        ext_libs = [p for p in glob.glob(os.path.join(install_dir, "**", "*.so"), recursive=True) if is_wasm(p)]
        itk_libs = getattr(args, "itk_libs", {})
        if needed_closure(ext_libs, itk_libs) - getattr(args, "core_itk", set()):
            entry["requires"] = ["slicerweb-itk-extra"]
        index.append(entry)
    with open(os.path.join(args.extensions_out, "index.json"), "w") as f:
        json.dump({"extensions": index}, f, indent=1)
    print(f"  index.json ({len(index)} extensions)")


if __name__ == "__main__":
    main()

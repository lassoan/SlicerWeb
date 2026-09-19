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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--install", default="/build/install")
    parser.add_argument("--src", default="/build/src")
    parser.add_argument("--build", default="/build")
    parser.add_argument("--python", default="/work/python")
    parser.add_argument("--out", default="/dist/wheels")
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
    itk_install = os.path.join(args.install, "itk")
    w = Wheel("slicerweb-itk", "5.4.7", summary="ITK shared libraries built for Pyodide (WebAssembly)")
    for lib in sorted(glob.glob(os.path.join(itk_install, "lib", "*.so"))):
        w.add_file(lib, "slicerweb_itk/" + os.path.basename(lib))
    w.write(args.out)

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
    w.write(args.out)

    # ---------------------------------------------------------------- slicerweb runtime (pure Python)
    w = Wheel("slicerweb", "0.1.0", pure=True, summary="3D Slicer application services for the web browser")
    w.add_tree(args.python, "", exclude=lambda rel: rel.endswith(".pyc") or rel.startswith("tests"))
    w.write(args.out)


if __name__ == "__main__":
    main()

"""The extensions a SlicerWeb build bundles, read from a folder of extension description files.

The folder holds one <Name>.json per extension, as in the Slicer ExtensionsIndex
(https://github.com/Slicer/ExtensionsIndex): scm_url and scm_revision say where the source is, and
build_dependencies which extensions have to be built first. A description may also have a
"slicerweb" section, for what only matters in the browser:

    "slicerweb": {
      "python_packages": ["scipy", "svmorph @ git+https://github.com/lassoan/svMorph.git@330908d"],
      "cmake_options": ["-DMyExtension_BUILD_SOMETHING=OFF"]
    }

python_packages are requirements as pip takes them. Those that the Pyodide distribution has
(SciPy, scikit-image, ...) are loaded from there when the extension is installed; the others are
installed into the extension's wheel, and must be pure Python (there is nothing here that could
compile them for WebAssembly). Dependencies are not followed: list each package the extension needs.

Commands (used by scripts/stages/80-extensions.sh):
  plan <folder>                        the extensions in build order, as shell commands
  python-packages <description> <dir>  install the Python packages of one extension into <dir>
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

# Packages that SlicerWeb itself provides, which are neither in the Pyodide distribution nor to be
# installed from PyPI (that would be the desktop build).
PROVIDED = {"vtk": "the vtk wheel of SlicerWeb"}


def fail(message):
    print(f"extension_catalog: {message}", file=sys.stderr)
    sys.exit(1)


def warn(message):
    print(f"extension_catalog: warning: {message}", file=sys.stderr)


def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def read_description(path):
    try:
        with open(path, encoding="utf8") as handle:
            description = json.load(handle)
    except (OSError, ValueError) as e:
        fail(f"{path}: {e}")
    name = os.path.splitext(os.path.basename(path))[0]
    if not re.fullmatch(r"[A-Za-z0-9_]+", name):
        fail(f"{path}: the file is named after the extension (its CMake project name)")
    if description.get("scm_type", "git") != "git":
        fail(f"{path}: only git sources are supported")
    for key in ("scm_url", "scm_revision"):
        if not description.get(key):
            fail(f"{path}: {key} is missing")
    web = description.get("slicerweb") or {}
    for key in ("python_packages", "cmake_options"):
        if not isinstance(web.get(key, []), list):
            fail(f"{path}: slicerweb.{key} is a list")
    return name, description


def plan(folder):
    """Shell commands that build the extensions, dependencies first:

        CATALOG=(Name ...)
        extension Name URL REVISION DESCRIPTION BUILD_SUBDIRECTORY "DEPENDENCY ..." [CMAKE_OPTION ...]
    """
    if not os.path.isdir(folder):
        fail(f"no extension folder {folder}")
    catalog = {}
    for entry in sorted(os.listdir(folder)):
        if entry.endswith(".json"):
            name, description = read_description(os.path.join(folder, entry))
            catalog[name] = (description, os.path.join(folder, entry))

    order, state = [], {}

    def visit(name, chain):
        if state.get(name) == "done":
            return
        if state.get(name) == "visiting":
            fail("dependency cycle: " + " -> ".join(chain + [name]))
        state[name] = "visiting"
        for dependency in catalog[name][0].get("build_dependencies") or []:
            if dependency in catalog:
                visit(dependency, chain + [name])
            else:
                # As the Slicer extension build would; here the extension's own CMake decides whether
                # it can do without (SlicerVMTK can without ExtraMarkups).
                warn(f"{name} depends on {dependency}, which is not in {folder}")
        state[name] = "done"
        order.append(name)

    for name in catalog:
        visit(name, [])
    print("CATALOG=(" + " ".join(order) + ")")
    for name in order:
        description, path = catalog[name]
        options = (description.get("slicerweb") or {}).get("cmake_options", [])
        # build_subdirectory: where the superbuild builds the extension itself (inner-build), as the
        # Slicer extension build uses it; "." for an extension without a superbuild.
        words = [name, description["scm_url"], str(description["scm_revision"]), path,
                 description.get("build_subdirectory") or ".",
                 " ".join(description.get("build_dependencies") or [])] + [str(o) for o in options]
        print("extension " + " ".join(shlex.quote(w) for w in words))


def pyodide_packages():
    """The packages of the Pyodide distribution, by normalized name."""
    root = os.environ.get("PYODIDE_ROOT") or subprocess.run(
        ["pyodide", "config", "get", "pyodide_root"], capture_output=True, text=True, check=True).stdout.strip()
    with open(os.path.join(root, "dist", "pyodide-lock.json"), encoding="utf8") as handle:
        lock = json.load(handle)
    return {normalize(key): (key, info.get("version", "")) for key, info in lock["packages"].items()}


def requirement_name(text):
    try:
        from packaging.requirements import Requirement
        requirement = Requirement(text)
        return requirement.name, requirement.specifier
    except ImportError:
        match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", text)
        if not match:
            fail(f"not a requirement: {text}")
        return match.group(1), None


def python_packages(description_path, install_dir):
    """Install what slicerweb.python_packages asks for: into <dir>/python-packages if pip has to
    install it, and into <dir>/slicerweb-extension.json ("pythonPackages") if Pyodide has it."""
    name, description = read_description(description_path)
    requirements = (description.get("slicerweb") or {}).get("python_packages", [])
    target = os.path.join(install_dir, "python-packages")
    shutil.rmtree(target, ignore_errors=True)
    if not requirements:
        return
    available = pyodide_packages()
    from_pyodide, from_pip = [], []
    for text in requirements:
        package, specifier = requirement_name(text)
        key = normalize(package)
        if key in PROVIDED:
            print(f"{name}: {package} is {PROVIDED[key]}", flush=True)
        elif key in available:
            lock_name, version = available[key]
            if specifier and version and not specifier.contains(version, prereleases=True):
                warn(f"{name} asks for {text}; Pyodide has {lock_name} {version}")
            print(f"{name}: {package} comes from the Pyodide distribution ({lock_name} {version})", flush=True)
            from_pyodide.append(lock_name)
        else:
            from_pip.append(text)

    if from_pip:
        print(f"{name}: installing {', '.join(from_pip)} into the wheel", flush=True)
        subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", "--no-compile", "--disable-pip-version-check",
                        "--target", target] + from_pip, check=True)
        # Scripts that pip makes for the command line; there is no command line here.
        shutil.rmtree(os.path.join(target, "bin"), ignore_errors=True)
        # And what pip records of each package: the extension's wheel may hold one .dist-info, its
        # own - micropip cannot install a wheel with more, and would read the requirements of the
        # packages in it (svmorph asks for JAX) as the extension's.
        for entry in os.listdir(target):
            if entry.endswith((".dist-info", ".egg-info")):
                shutil.rmtree(os.path.join(target, entry))
        compiled = [os.path.relpath(os.path.join(d, f), target) for d, _, files in os.walk(target) for f in files
                    if f.endswith((".so", ".pyd", ".dylib", ".dll"))]
        if compiled:
            fail(f"{name}: these packages hold compiled code, and are not in the Pyodide distribution: "
                 + ", ".join(compiled[:5]))

    metadata = os.path.join(install_dir, "slicerweb-extension.json")
    if from_pyodide:
        os.makedirs(install_dir, exist_ok=True)
        with open(metadata, "w", encoding="utf8") as handle:
            json.dump({"pythonPackages": from_pyodide}, handle, indent=1)
    elif os.path.exists(metadata):
        os.remove(metadata)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "plan":
        plan(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "python-packages":
        python_packages(sys.argv[2], sys.argv[3])
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)

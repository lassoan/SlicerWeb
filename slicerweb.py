#!/usr/bin/env python3
"""Build, publish and try a SlicerWeb application, as the env file of its folder says.

    python slicerweb.py build                       everything (each stage redoes only what changed)
    python slicerweb.py build extensions            all extensions
    python slicerweb.py build extensions SlicerRT   these extensions (names of the application's extensions)
    python slicerweb.py build 50-slicer 60-wheels   these stages of the build (scripts/stages)
    python slicerweb.py deploy [channel]            publish the build (channel latest by default)
    python slicerweb.py serve                       try the build in the browser (Ctrl+C stops it)
    python slicerweb.py stop [port]                 stop a server started by serve or dev (one without a window, say)
    python slicerweb.py dev                         the development server of the web application (Ctrl+C stops it)
    python slicerweb.py test tests/x.mjs [args]     run a test of the web application (web/tests)

    python slicerweb.py -C <folder> <command> ...   the same, for the application of that folder

The folder - the current folder, or the one -C (--folder) gives; parent folders are not searched -
is that of the application: its application.json configures the application and says which
extensions it has. It is the checkout of a repository of its own (docs/extensions.md), which the
build is published to; or an example of SlicerWeb (examples/full: all of its extensions,
examples/minimal), which is not published. Its env file, .env, says where everything is
on this computer, as NAME=value lines (copied from .env.example of an example); .gitignore keeps it
out of the repository. Nothing built goes in a checkout: everything goes to SW_DIST - also what npm
installs: the web application is built, served and tested in a copy of web/ in
SW_DIST/web-workspace, which follows the checkout (dev copies each change while it runs).

    SW_SLICERWEB    the SlicerWeb checkout (default: the one this script is in)
    SW_DIST         where everything built goes: wheels, extensions, the web application, sample data
    SW_SECRETS      a folder of secrets: github-token, read access to private extensions (optional)
    SW_BUILD_VOLUME the Docker volume of the build trees of SW_SLICERWEB (default slicerweb-build):
                    one for each SlicerWeb checkout, shared by the applications it builds
    SW_PORT         the port of serve (default 4175)
    SW_DEV_PORT     the port of dev (default 5173)

A relative path is relative to the folder. An environment variable of the same name overrides a
line.
"""
import sys

sys.dont_write_bytecode = True   # nothing generated in the checkout (scripts/__pycache__)

import hashlib  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402

COMMANDS = ("build", "deploy", "serve", "stop", "dev", "test")
# What npm and Vite write in the web folder: the copy has them, the checkout should not
GENERATED = {"node_modules", "dist", ".vite"}
# What the copy has of its own, beside those
WORKSPACE_FILES = {"package-lock.sha256"}


def is_slicerweb(folder):
    return os.path.isfile(os.path.join(folder, "build.py")) and os.path.isfile(os.path.join(folder, "slicerweb.py"))


def is_inside(folder, parent):
    folder, parent = os.path.normcase(os.path.abspath(folder)), os.path.normcase(os.path.abspath(parent))
    return folder == parent or folder.startswith(parent.rstrip(os.sep) + os.sep)


def read_settings(folder):
    """The settings of the application of a folder (one with application.json): its .env, and
    "application", the folder."""
    folder = os.path.abspath(folder)
    if not os.path.isdir(folder):
        sys.exit(f"Not a folder: {folder}")
    if not os.path.isfile(os.path.join(folder, "application.json")):
        sys.exit(f"{folder} is not the folder of an application (it has no application.json): run this in the "
                 "checkout of an application or an example of SlicerWeb (examples/full), or give one with -C <folder>")
    path = os.path.join(folder, ".env")
    if not os.path.isfile(path):
        sys.exit(f"{path} not found: copy .env.example of an example of SlicerWeb (examples/) there and set the "
                 "paths of this computer")
    values = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                name, value = line.split("=", 1)
                values[name.strip()] = value.split(" #", 1)[0].strip()
    for name in list(values):
        values[name] = os.environ.get(name) or values[name]
    for name in ("SW_SLICERWEB", "SW_DIST", "SW_SECRETS"):
        if values.get(name):
            values[name] = os.path.normpath(os.path.join(folder, os.path.expanduser(values[name])))
    values.setdefault("SW_SLICERWEB", os.path.dirname(os.path.abspath(__file__)))
    if not values.get("SW_DIST"):
        sys.exit(f"{path}: SW_DIST is not set (where everything built goes, outside the checkouts)")
    if not is_slicerweb(values["SW_SLICERWEB"]):
        sys.exit(f"{path}: SW_SLICERWEB is not a SlicerWeb checkout: {values['SW_SLICERWEB']}")
    values["application"] = folder
    return values


def environment(settings):
    """The environment of the scripts: the settings, and the GitHub token of SW_SECRETS (passed by
    environment, so that its value is not on any command line)."""
    env = dict(os.environ, SW_DIST=settings["SW_DIST"], PYTHONDONTWRITEBYTECODE="1")
    token_file = os.path.join(settings["SW_SECRETS"], "github-token") if settings.get("SW_SECRETS") else None
    if token_file and os.path.isfile(token_file) and not env.get("SW_GIT_TOKEN"):
        with open(token_file, encoding="utf-8") as handle:
            token = handle.read().strip()
        if token:
            env["SW_GIT_TOKEN"] = token
    return env


def run(command, settings, cwd=None):
    print("> " + " ".join(command), flush=True)
    return subprocess.run(command, env=environment(settings), cwd=cwd or settings["SW_SLICERWEB"]).returncode


def extension_names(settings):
    """The extensions of the build: those of SlicerWeb that the application names (or all), and its own."""
    sys.path.insert(0, os.path.join(settings["SW_SLICERWEB"], "scripts"))
    import localsettings
    localsettings.use_application(settings["application"])
    return set(localsettings.application_extension_names()) | set(localsettings.application_extension_files())


def build(settings, args):
    command = [sys.executable, "build.py", "--dist", settings["SW_DIST"], "--application", settings["application"]]
    stages_folder = os.path.join(settings["SW_SLICERWEB"], "scripts", "stages")
    stages = sorted(os.path.splitext(f)[0] for f in os.listdir(stages_folder) if f.endswith(".sh"))
    if not args:
        return run(command + ["all"], settings)
    if args[0] == "extensions":
        names = args[1:]
        if names:
            known = extension_names(settings)
            unknown = [n for n in names if n not in known]
            if unknown:
                sys.exit(f"Not an extension of this application: {', '.join(unknown)}\n"
                         f"  its extensions: {', '.join(sorted(known))}")
            command += ["--extensions", " ".join(names)]
        return run(command + ["80-extensions"], settings)
    unknown = [a for a in args if a not in stages]
    if unknown:
        sys.exit(f"Not a stage of the build: {', '.join(unknown)} (extensions are built with: build extensions "
                 f"[names])\n  stages: {', '.join(stages)}")
    return run(command + args, settings)


def deploy(settings, args):
    if is_inside(settings["application"], settings["SW_SLICERWEB"]):
        sys.exit("deploy publishes an application to the repository its folder is the checkout of: an example of "
                 "SlicerWeb is not published (copy it to a repository of its own)")
    if len(args) > 1:
        sys.exit("deploy [channel]")
    channel = args[0] if args else "latest"
    return run([sys.executable, os.path.join("scripts", "publish_runtime.py"), "--application", settings["application"],
                "--dist", settings["SW_DIST"], "--channel", channel, "--publish"], settings)


def port_in_use(port):
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def sync_tree(source, target):
    """Make target a copy of source - files that changed are copied, files that are gone deleted - but
    for what npm and Vite generate. Returns the number of files copied or deleted."""
    changes = 0
    for folder, dirs, files in os.walk(source):
        dirs[:] = [d for d in dirs if d not in GENERATED]
        relative = os.path.relpath(folder, source)
        target_folder = os.path.normpath(os.path.join(target, relative))
        os.makedirs(target_folder, exist_ok=True)
        for name in files:
            if relative == "." and name.endswith(".png"):
                continue   # screenshots that tests leave
            src, dst = os.path.join(folder, name), os.path.join(target_folder, name)
            a = os.stat(src)
            try:
                b = os.stat(dst)
                if b.st_size == a.st_size and int(b.st_mtime) == int(a.st_mtime):
                    continue
            except FileNotFoundError:
                pass
            shutil.copy2(src, dst)
            changes += 1
    for folder, dirs, files in os.walk(target):
        relative = os.path.relpath(folder, target)
        if relative == ".":
            dirs[:] = [d for d in dirs if d not in GENERATED]
        source_folder = os.path.normpath(os.path.join(source, relative))
        for name in files:
            if relative == "." and (name in WORKSPACE_FILES or name.endswith(".png")):
                continue
            if not os.path.exists(os.path.join(source_folder, name)):
                os.remove(os.path.join(folder, name))
                changes += 1
        for name in list(dirs):
            if not os.path.exists(os.path.join(source_folder, name)):
                shutil.rmtree(os.path.join(folder, name))
                dirs.remove(name)
                changes += 1
    return changes


def app_version(settings):
    """The commit of the SlicerWeb checkout, with "+" when files of it differ (as vite.config.ts says it)."""
    def git(*args):
        return subprocess.run(["git", "-C", settings["SW_SLICERWEB"], *args], capture_output=True, text=True).stdout.strip()
    commit = git("rev-parse", "HEAD")
    return commit + ("+" if commit and git("status", "--porcelain", "--untracked-files=no") else "")


def web_workspace(settings):
    """The copy of web/ in SW_DIST/web-workspace, up to date and with its npm packages, and the
    environment to run npm, Vite and the tests there with."""
    source = os.path.join(settings["SW_SLICERWEB"], "web")
    workspace = os.path.join(settings["SW_DIST"], "web-workspace")
    sync_tree(source, workspace)
    dist = settings["SW_DIST"]
    # the configuration of the application as its application.json has it now (wheels/application.json)
    sys.path.insert(0, os.path.join(settings["SW_SLICERWEB"], "scripts"))
    import localsettings
    localsettings.use_application(settings["application"])
    localsettings.write_application_config(dist)
    env = dict(environment(settings),
               SLICERWEB_WHEELS=os.path.join(dist, "wheels"),
               SLICERWEB_EXTENSIONS=os.path.join(dist, "extensions"),
               SLICERWEB_SAMPLE_DATA=os.path.join(dist, "sample-data"),
               SLICERWEB_APP_VERSION=app_version(settings),
               VITE_CONFIG_NATIVE_IGNORE_WARNING="true")
    # npm packages: installed again when package-lock.json changes
    with open(os.path.join(workspace, "package-lock.json"), "rb") as handle:
        lock = hashlib.sha256(handle.read()).hexdigest()
    stamp = os.path.join(workspace, "package-lock.sha256")
    installed = ""
    if os.path.exists(stamp):
        with open(stamp, encoding="utf-8") as handle:
            installed = handle.read().strip()
    if lock != installed or not os.path.isdir(os.path.join(workspace, "node_modules")):
        npm = shutil.which("npm") or "npm"
        print(f"> npm ci (in {workspace})", flush=True)
        if subprocess.run([npm, "ci"], env=env, cwd=workspace).returncode != 0:
            sys.exit("npm ci failed")
        with open(stamp, "w", encoding="utf-8") as handle:
            handle.write(lock)
    return workspace, env


def serve(settings, args):
    if args:
        sys.exit("serve (the port is SW_PORT of .env)")
    port = int(settings.get("SW_PORT") or 4175)
    dist = settings["SW_DIST"]
    if not os.path.isdir(os.path.join(dist, "wheels")):
        sys.exit(f"No build in {dist}: build first")
    if port_in_use(port):
        sys.exit(f"Port {port} is already in use: a server is running there. Stop it (stop), or open http://localhost:{port}/")
    workspace, env = web_workspace(settings)
    npx = shutil.which("npx") or "npx"
    node = shutil.which("node") or "node"
    for step in ([node, os.path.join("scripts", "fetch-sample-data.mjs")],
                 [npx, "vite", "build", "--outDir", os.path.join(dist, "web"), "--emptyOutDir"]):
        print("> " + " ".join(step), flush=True)
        if subprocess.run(step, env=env, cwd=workspace).returncode != 0:
            return 1
    print(f"Serving {dist} at http://localhost:{port}/ (Ctrl+C stops it)", flush=True)
    try:
        # (a browser is opened for someone at a terminal, not for a script)
        return subprocess.run([npx, "vite", "preview", "--outDir", os.path.join(dist, "web"), "--port", str(port), "--strictPort"]
                              + (["--open"] if sys.stdout.isatty() else []), env=env, cwd=workspace).returncode
    except KeyboardInterrupt:
        return 0


def dev(settings, args):
    """The development server of the web application, in the copy of web/: a change of the checkout is
    copied there as it is saved, and Vite reloads it."""
    if args:
        sys.exit("dev (the port is SW_DEV_PORT of .env)")
    port = int(settings.get("SW_DEV_PORT") or 5173)
    if port_in_use(port):
        sys.exit(f"Port {port} is already in use: a server is running there. Stop it (stop {port}), or open http://localhost:{port}/")
    workspace, env = web_workspace(settings)
    source = os.path.join(settings["SW_SLICERWEB"], "web")
    stopping = threading.Event()

    def follow():
        while not stopping.wait(0.5):
            try:
                sync_tree(source, workspace)
            except OSError:
                pass   # a file being written: next time
    threading.Thread(target=follow, daemon=True).start()
    npx = shutil.which("npx") or "npx"
    print(f"Development server of {source} (copied to {workspace} as it changes) at http://localhost:{port}/", flush=True)
    try:
        return subprocess.run([npx, "vite", "--port", str(port), "--strictPort"], env=env, cwd=workspace).returncode
    except KeyboardInterrupt:
        return 0
    finally:
        stopping.set()


def test(settings, args):
    """A test of the web application (web/tests), run in the copy of web/, where its npm packages are."""
    if not args:
        sys.exit("test tests/<name>.mjs [arguments]")
    workspace, env = web_workspace(settings)
    node = shutil.which("node") or "node"
    script = args[0].replace(chr(92), "/")
    if script.startswith("web/"):
        script = script[len("web/"):]
    return subprocess.run([node, script, *args[1:]], env=env, cwd=workspace).returncode


def stop(settings, args):
    if len(args) > 1:
        sys.exit("stop [port] (default: SW_PORT of .env)")
    port = int(args[0]) if args else int(settings.get("SW_PORT") or 4175)
    if not port_in_use(port):
        print(f"Nothing is serving on port {port}")
        return 0
    if os.name == "nt":
        script = (f"$c = Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue; "
                  "foreach ($x in $c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $x.OwningProcess); "
                  f"Write-Host ('Stopping ' + $p.Name + ' (process ' + $x.OwningProcess + ') on port {port}'); "
                  "Stop-Process -Id $x.OwningProcess -Force }")
        return subprocess.run(["powershell", "-NoProfile", "-Command", script]).returncode
    pids = subprocess.run(["lsof", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split()
    for pid in pids:
        print(f"Stopping process {pid} on port {port}")
        subprocess.run(["kill", pid])
    return 0


def main():
    sys.stdout.reconfigure(line_buffering=True)
    argv = sys.argv[1:]
    folder = os.getcwd()
    if argv and argv[0] in ("-C", "--folder"):
        if len(argv) < 2:
            sys.exit(f"{argv[0]} <folder>: the folder of the application (with application.json)")
        folder, argv = argv[1], argv[2:]
    if not argv or argv[0] not in COMMANDS:
        print(__doc__)
        return 2
    settings = read_settings(folder)
    command, args = argv[0], argv[1:]
    where = f"{os.path.join(settings['application'], '.env')} -> {settings['SW_DIST']}"
    print(f"{command} {' '.join(args)}: {where}".replace("  ", " "), flush=True)
    return {"build": build, "deploy": deploy, "serve": serve, "stop": stop, "dev": dev, "test": test}[command](settings, args)


if __name__ == "__main__":
    sys.exit(main())

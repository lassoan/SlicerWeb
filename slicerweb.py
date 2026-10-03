#!/usr/bin/env python3
"""Build, publish and try a SlicerWeb application, as a settings file says.

    python slicerweb.py <settings file> build                       everything (each stage redoes only what changed)
    python slicerweb.py <settings file> build extensions            all extensions
    python slicerweb.py <settings file> build SlicerHeart SlicerRT  these extensions (or stages: build 60-wheels)
    python slicerweb.py <settings file> deploy [channel]            publish the build (channel latest by default)
    python slicerweb.py <settings file> serve                       try the build in the browser (Ctrl+C stops it)
    python slicerweb.py <settings file> stop [port]                 stop a server started by serve or dev (one without a window, say)
    python slicerweb.py <settings file> dev                         the development server of the web application (Ctrl+C stops it)
    python slicerweb.py <settings file> test tests/x.mjs [args]     run a test of the web application (web/tests)

On Windows, slicerweb.bat <settings file> <command> does the same.

The settings file says where everything is, as NAME=value lines (deployment.env.example). It is
kept outside the checkouts: they hold sources only, and everything built goes to SW_DIST - also what
npm installs: the web application is built, served and tested in a copy of web/ in
SW_DIST/web-workspace, which follows the checkout (dev copies each change while it runs).

    SW_SLICERWEB    the SlicerWeb checkout (default: the one this script is in)
    SW_DEPLOYMENT   a deployment checkout (docs/extensions.md): its application.json configures the
                    application and says which extensions it has, and the build is published to its
                    repository. Without one: the extensions of SlicerWeb, defaults, and no deploy
    SW_DIST         where everything built goes: wheels, extensions, the web application, sample data
    SW_SECRETS      a folder of secrets: github-token, read access to private extensions (optional)
    SW_PORT         the port of serve (default 4175)
    SW_DEV_PORT     the port of dev (default 5173)

A relative path is relative to the settings file. An environment variable of the same name
overrides a line.
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


def read_settings(path):
    if not os.path.isfile(path):
        sys.exit(f"Settings file not found: {path}")
    folder = os.path.dirname(os.path.abspath(path))
    values = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                name, value = line.split("=", 1)
                values[name.strip()] = value.split(" #", 1)[0].strip()
    for name in list(values):
        values[name] = os.environ.get(name) or values[name]
    for name in ("SW_SLICERWEB", "SW_DEPLOYMENT", "SW_DIST", "SW_SECRETS"):
        if values.get(name):
            values[name] = os.path.normpath(os.path.join(folder, os.path.expanduser(values[name])))
    values.setdefault("SW_SLICERWEB", os.path.dirname(os.path.abspath(__file__)))
    if not values.get("SW_DIST"):
        sys.exit(f"{path}: SW_DIST is not set (where everything built goes, outside the checkouts)")
    for name in ("SW_SLICERWEB", "SW_DEPLOYMENT"):
        if values.get(name) and not os.path.isdir(values[name]):
            sys.exit(f"{path}: {name} is not a folder: {values[name]}")
    if not os.path.isfile(os.path.join(values["SW_SLICERWEB"], "build.py")):
        sys.exit(f"{path}: SW_SLICERWEB is not a SlicerWeb checkout: {values['SW_SLICERWEB']}")
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
    """The extensions of the build: those of SlicerWeb that the deployment names and its own, or all of
    SlicerWeb's."""
    sys.path.insert(0, os.path.join(settings["SW_SLICERWEB"], "scripts"))
    import localsettings
    names = set()
    if settings.get("SW_DEPLOYMENT"):
        localsettings.use_deployment(settings["SW_DEPLOYMENT"])
        names.update(localsettings.deployment_extension_names())
        names.update(localsettings.deployment_extension_files())
    else:
        folder = os.path.join(settings["SW_SLICERWEB"], "extensions")
        names.update(os.path.splitext(f)[0] for f in os.listdir(folder) if f.endswith(".json"))
    return names


def build(settings, args):
    command = [sys.executable, "build.py", "--dist", settings["SW_DIST"]]
    if settings.get("SW_DEPLOYMENT"):
        command += ["--deployment", settings["SW_DEPLOYMENT"]]
    stages_folder = os.path.join(settings["SW_SLICERWEB"], "scripts", "stages")
    stages = sorted(os.path.splitext(f)[0] for f in os.listdir(stages_folder) if f.endswith(".sh"))
    if not args:
        return run(command + ["all"], settings)
    if args == ["extensions"]:
        return run(command + ["80-extensions"], settings)
    known = extension_names(settings)
    chosen_stages = [a for a in args if a in stages]
    extensions = [a for a in args if a not in stages]
    unknown = [a for a in extensions if a not in known]
    if unknown:
        sys.exit(f"Not an extension of this build nor a stage: {', '.join(unknown)}\n"
                 f"  extensions: {', '.join(sorted(known))}\n  stages: {', '.join(stages)}")
    if extensions:
        command += ["--extensions", " ".join(extensions)]
        if "80-extensions" not in chosen_stages:
            chosen_stages.append("80-extensions")
    return run(command + chosen_stages, settings)


def deploy(settings, args):
    if not settings.get("SW_DEPLOYMENT"):
        sys.exit("deploy publishes a deployment: set SW_DEPLOYMENT in the settings file")
    if len(args) > 1:
        sys.exit("deploy [channel]")
    channel = args[0] if args else "latest"
    return run([sys.executable, os.path.join("scripts", "publish_runtime.py"), "--deployment", settings["SW_DEPLOYMENT"],
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
    # the configuration of the application as the deployment has it now (wheels/application.json)
    sys.path.insert(0, os.path.join(settings["SW_SLICERWEB"], "scripts"))
    import localsettings
    if settings.get("SW_DEPLOYMENT"):
        localsettings.use_deployment(settings["SW_DEPLOYMENT"])
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
        sys.exit("serve (the port is SW_PORT of the settings file)")
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
        sys.exit("dev (the port is SW_DEV_PORT of the settings file)")
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
        sys.exit("stop [port] (default: SW_PORT of the settings file)")
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
    if len(sys.argv) < 3 or sys.argv[2] not in COMMANDS:
        print(__doc__)
        return 2
    settings = read_settings(sys.argv[1])
    command, args = sys.argv[2], sys.argv[3:]
    where = f"{settings.get('SW_DEPLOYMENT') or 'SlicerWeb extensions'} -> {settings['SW_DIST']}"
    print(f"{command} {' '.join(args)}: {where}".replace("  ", " "), flush=True)
    return {"build": build, "deploy": deploy, "serve": serve, "stop": stop, "dev": dev, "test": test}[command](settings, args)


if __name__ == "__main__":
    sys.exit(main())

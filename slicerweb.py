#!/usr/bin/env python3
"""Build, publish and try a SlicerWeb application, as a settings file says.

    python slicerweb.py <settings file> build                       everything (each stage redoes only what changed)
    python slicerweb.py <settings file> build extensions            all extensions
    python slicerweb.py <settings file> build SlicerHeart SlicerRT  these extensions (or stages: build 60-wheels)
    python slicerweb.py <settings file> deploy [channel]            publish the build (channel latest by default)
    python slicerweb.py <settings file> serve                       try the build in the browser (Ctrl+C stops it)
    python slicerweb.py <settings file> stop                        stop a server started by serve (one without a window, say)

On Windows, slicerweb.bat <settings file> <command> does the same.

The settings file says where everything is, as NAME=value lines (deployment.env.example). It is
kept outside the checkouts: they hold sources only, and everything built goes to SW_DIST.

    SW_SLICERWEB    the SlicerWeb checkout (default: the one this script is in)
    SW_DEPLOYMENT   a deployment checkout (docs/extensions.md): the extensions of SlicerWeb its
                    extensions.json names and those of its extensions/, and the repository the build
                    is published to. Without one: the extensions of SlicerWeb, and no deploy
    SW_DIST         where everything built goes: wheels, extensions, the web application, sample data
    SW_SECRETS      a folder of secrets: github-token, read access to private extensions (optional)
    SW_PORT         the port of serve (default 4175)

A relative path is relative to the settings file. An environment variable of the same name
overrides a line.
"""
import os
import shutil
import subprocess
import sys

COMMANDS = ("build", "deploy", "serve", "stop")


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
    env = dict(os.environ, SW_DIST=settings["SW_DIST"])
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
        own = os.path.join(settings["SW_DEPLOYMENT"], "extensions")
        if os.path.isdir(own):
            names.update(os.path.splitext(f)[0] for f in os.listdir(own) if f.endswith(".json"))
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


def serve(settings, args):
    if args:
        sys.exit("serve (the port is SW_PORT of the settings file)")
    port = int(settings.get("SW_PORT") or 4175)
    dist = settings["SW_DIST"]
    if not os.path.isdir(os.path.join(dist, "wheels")):
        sys.exit(f"No build in {dist}: build first")
    if port_in_use(port):
        sys.exit(f"Port {port} is already in use: a server is running there. Stop it (stop), or open http://localhost:{port}/")
    web = os.path.join(settings["SW_SLICERWEB"], "web")
    env = dict(environment(settings),
               SLICERWEB_WHEELS=os.path.join(dist, "wheels"),
               SLICERWEB_EXTENSIONS=os.path.join(dist, "extensions"),
               SLICERWEB_SAMPLE_DATA=os.path.join(dist, "sample-data"),
               VITE_CONFIG_NATIVE_IGNORE_WARNING="true")
    npm = shutil.which("npm") or "npm"
    npx = shutil.which("npx") or "npx"
    node = shutil.which("node") or "node"
    steps = []
    if not os.path.isdir(os.path.join(web, "node_modules")):
        steps.append([npm, "install"])
    steps += [[node, os.path.join("scripts", "fetch-sample-data.mjs")],
              [npx, "vite", "build", "--outDir", os.path.join(dist, "web"), "--emptyOutDir"]]
    for step in steps:
        print("> " + " ".join(step), flush=True)
        if subprocess.run(step, env=env, cwd=web).returncode != 0:
            return 1
    print(f"Serving {dist} at http://localhost:{port}/ (Ctrl+C stops it)", flush=True)
    try:
        # (a browser is opened for someone at a terminal, not for a script)
        return subprocess.run([npx, "vite", "preview", "--outDir", os.path.join(dist, "web"), "--port", str(port), "--strictPort"]
                              + (["--open"] if sys.stdout.isatty() else []), env=env, cwd=web).returncode
    except KeyboardInterrupt:
        return 0


def stop(settings, args):
    if args:
        sys.exit("stop (the port is SW_PORT of the settings file)")
    port = int(settings.get("SW_PORT") or 4175)
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
    return {"build": build, "deploy": deploy, "serve": serve, "stop": stop}[command](settings, args)


if __name__ == "__main__":
    sys.exit(main())

"""Settings of this computer for the build and deploy scripts (build.py, scripts/publish_*.py).

Settings are read from the env file of the application (--application), .env in its folder -
NAME=value lines, as in sources.env, kept out of its repository by .gitignore (examples/*/.env.example
of this repository) - and an environment variable of the same name overrides them. A setting that
neither gives has the default the script passes.

    SW_DIST=D:/SlicerWeb-build/dist        where the wheels and web bundles are copied
    SW_EXTENSIONS_DIR=C:/D/SlicerWebExtensions
    SW_BUILD_VOLUME=slicerweb-build        the Docker volume of the build trees of this checkout
    SW_SECRETS=D:/SlicerWeb-build/secrets/slicerweb   a folder of secrets, outside the checkouts

An application - a folder that says which extensions its build has (docs/extensions.md): those of
this repository it names in its application.json (or all of them), and description files of its own
in a folder it names, private extensions among them - is the checkout of a repository of its own,
or one of examples/ of this repository (--application):

    <application>/application.json         what the application is
    <application>/.env                     SW_DIST=... (default: ~/SlicerWeb-build/dist-<name>)

No checkout holds secrets. A secret is taken from its environment variable, else from a file of the
folder that SW_SECRETS names (github-token: read access to private repositories). A relative path
of .env is relative to the folder of the .env.
"""
import json
import os
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_env_file(path):
    values = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    name, value = line.split("=", 1)
                    values[name.strip()] = value.split(" #", 1)[0].strip()
    return values


_local = {}            # the .env of the application (none without one: the environment only)
_local_folder = ROOT   # the folder of that .env
_application = None    # the folder of the application

#: The configuration of an application, at the root of its folder (docs/extensions.md)
APPLICATION_CONFIG = "application.json"


def use_settings_folder(path):
    """Take the settings of a folder (its .env): that of an application, or one only of settings and
    secrets, as that of the test site. Returns its absolute path, or exits with a message if it is
    not a folder."""
    global _local, _local_folder
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        raise SystemExit(f"Not a folder: {path}")
    _local = _read_env_file(os.path.join(path, ".env"))
    _local_folder = path
    return path


def use_application(path):
    """Take the application of a folder, and its settings (its .env). Returns its absolute path, or
    exits with a message if it is not the folder of an application (one with application.json)."""
    global _application
    path = os.path.abspath(path)
    if not os.path.isfile(os.path.join(path, APPLICATION_CONFIG)):
        raise SystemExit(f"Not the folder of an application (a folder with {APPLICATION_CONFIG}): {path}")
    _application = use_settings_folder(path)
    return path


def application_folder():
    return _application


#: The features an application.json may set, and the values each may have (the first is the default)
FEATURES = {
    "developerMode": ("enabledByDefault", "disabledByDefault", "unavailable"),
    "pythonConsole": (True, False),
    "extensionsManager": (True, False),
    "webxr": ("unavailable", "disabledByDefault", "enabledByDefault"),
}


def application_config():
    """The application.json of the application ({} without one), checked: exits with a message on
    what it cannot have."""
    if not _application:
        return {}
    path = os.path.join(_application, APPLICATION_CONFIG)
    try:
        with open(path, encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError) as e:
        raise SystemExit(f"{path}: {e}")
    if not isinstance(config, dict):
        raise SystemExit(f"{path}: an object of sections (extensions, features)")
    unknown = sorted(set(config) - {"extensions", "features"})
    if unknown:
        raise SystemExit(f"{path}: unknown sections {', '.join(unknown)} (it may have: extensions, features)")
    extensions = config.get("extensions", {})
    if not isinstance(extensions, dict) or set(extensions) - {"slicerweb", "folder"}:
        raise SystemExit(f'{path}: "extensions" has "slicerweb" (names of extensions of SlicerWeb, or "all") and '
                         '"folder" (a folder of description files of its own)')
    names = extensions.get("slicerweb", [])
    if names != "all" and (not isinstance(names, list) or not all(isinstance(n, str) for n in names)):
        raise SystemExit(f'{path}: "extensions.slicerweb" is a list of extension names, or "all"')
    if "folder" in extensions and not isinstance(extensions["folder"], str):
        raise SystemExit(f'{path}: "extensions.folder" is the path of a folder, relative to {APPLICATION_CONFIG}')
    features = config.get("features", {})
    if not isinstance(features, dict):
        raise SystemExit(f'{path}: "features" is an object')
    for name, value in features.items():
        if name not in FEATURES:
            raise SystemExit(f"{path}: unknown feature {name} (features: {', '.join(FEATURES)})")
        if value not in FEATURES[name] or type(value) is not type(FEATURES[name][0]):
            raise SystemExit(f"{path}: features.{name} is one of {', '.join(json.dumps(v) for v in FEATURES[name])}, not {json.dumps(value)}")
    return config


def application_extension_names():
    """The extensions of this repository that the application names in the extensions section of its
    application.json ({"extensions": {"slicerweb": ["SlicerHeart", ...]}}, docs/extensions.md), or
    all of them ("slicerweb": "all"). Exits with a message on a name that extensions/ of this
    repository has no description of."""
    names = application_config().get("extensions", {}).get("slicerweb", [])
    if names == "all":
        return sorted(os.path.splitext(f)[0] for f in os.listdir(os.path.join(ROOT, "extensions")) if f.endswith(".json"))
    unknown = [n for n in names if not os.path.isfile(os.path.join(ROOT, "extensions", f"{n}.json"))]
    if unknown:
        available = sorted(os.path.splitext(f)[0] for f in os.listdir(os.path.join(ROOT, "extensions")) if f.endswith(".json"))
        raise SystemExit(f"{os.path.join(_application, APPLICATION_CONFIG)} names extensions that SlicerWeb has no description of: "
                         f"{', '.join(unknown)} (it has: {', '.join(available)})")
    return names


def application_extensions_folder():
    """The folder of the application's own extension description files (extensions.folder of its
    application.json, relative to it), or None."""
    folder = application_config().get("extensions", {}).get("folder")
    if not folder:
        return None
    path = os.path.normpath(os.path.join(_application, folder))
    if not os.path.isdir(path):
        raise SystemExit(f"{os.path.join(_application, APPLICATION_CONFIG)}: extensions.folder is not a folder: {path}")
    return path


def application_extension_files():
    """{name: path} of the application's own extension description files."""
    folder = application_extensions_folder()
    if not folder:
        return {}
    return {os.path.splitext(f)[0]: os.path.join(folder, f) for f in sorted(os.listdir(folder)) if f.endswith(".json")}


def assemble_application_extensions(folder):
    """Write the description files of the application's extensions into folder (emptied first): those
    of this repository that its application.json names, and those of its own extensions folder, which
    take the place of one of the same name (to build another revision of it, say). Returns
    {name: "slicerweb" or "application"}, where each came from."""
    if os.path.isdir(folder):
        shutil.rmtree(folder)
    os.makedirs(folder)
    origins = {}
    for name in application_extension_names():
        shutil.copyfile(os.path.join(ROOT, "extensions", f"{name}.json"), os.path.join(folder, f"{name}.json"))
        origins[name] = "slicerweb"
    for name, path in application_extension_files().items():
        if origins.get(name) == "slicerweb":
            print(f"{name}: the description of the application ({path}) is used, not that of SlicerWeb")
        shutil.copyfile(path, os.path.join(folder, f"{name}.json"))
        origins[name] = "application"
    return origins


def write_application_config(dist):
    """The configuration of the application - its application.json, but for the extensions - into
    <dist>/wheels/application.json, where the application reads it at startup
    (web/src/core/appConfig.ts) and which goes with the runtime to the site. Without the folder of
    an application, an empty one: the application has its defaults (and the browser asks for no
    file that is not there)."""
    wheels = os.path.join(dist, "wheels")
    path = os.path.join(wheels, APPLICATION_CONFIG)
    config = {name: section for name, section in application_config().items() if name != "extensions"}
    os.makedirs(wheels, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=1)


def default_dist():
    """Where a build is copied: SW_DIST, else ~/SlicerWeb-build/dist (dist-<name> for the folder of
    an application, so that it does not replace the build of another)."""
    name = f"dist-{os.path.basename(_application)}" if _application else "dist"
    return setting("SW_DIST", os.path.join(os.path.expanduser("~"), "SlicerWeb-build", name))


def application_repository():
    """owner/name of the GitHub repository the folder of the application is a checkout of (its
    origin), or None. Only of a folder that is the root of its repository: an example of SlicerWeb
    (examples/) is not published with SlicerWeb's repository."""
    if not _application:
        return None
    top = subprocess.run(["git", "-C", _application, "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    if not top or os.path.normcase(os.path.abspath(top)) != os.path.normcase(_application):
        return None
    url =subprocess.run(["git", "-C", _application, "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
    for prefix in ("https://github.com/", "git@github.com:", "ssh://git@github.com/"):
        if url.startswith(prefix):
            return url[len(prefix):].removesuffix(".git").strip("/")
    return None


def setting(name, default=None):
    """The value of a setting: the environment variable, else .env, else the default."""
    value = os.environ.get(name)
    if value:
        return value
    return _local.get(name, default)


def secrets_folder():
    """The folder of secrets that SW_SECRETS names (relative to the folder of .env), or None."""
    folder = setting("SW_SECRETS")
    return os.path.normpath(os.path.join(_local_folder, os.path.expanduser(folder))) if folder else None


def secret(name, fileName):
    """A secret: the environment variable, else <SW_SECRETS>/<fileName>, else None."""
    value = os.environ.get(name)
    if value:
        return value.strip()
    folder = secrets_folder()
    if folder:
        path = os.path.join(folder, fileName)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                return handle.read().strip() or None
    return None

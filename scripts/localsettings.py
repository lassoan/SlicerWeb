"""Settings of this computer for the build and deploy scripts (build.py, scripts/publish_*.py).

Settings are read from local.env at the root of this repository - NAME=value lines, as in
sources.env, kept out of the repository (.gitignore) - and an environment variable of the same name
overrides them. A setting that neither gives has the default the script passes.

    SW_DIST=D:/SlicerWeb-build/dist        where the wheels and web bundles are copied
    SW_EXTENSIONS_DIR=C:/D/SlicerWebExtensions

This repository holds no secrets. A deployment - a checkout of a repository that says which
extensions its build has (docs/extensions.md): those of this repository it names in its
extensions.json, and description files of its own in its extensions/, private extensions among them -
is a folder of its own (--deployment), with its own local.env, which is then read instead of this
repository's, and its secrets in .secrets/ (both kept out of that repository by its .gitignore):

    <deployment>/local.env                 SW_DIST=... (default: ~/SlicerWeb-build/dist-<name>)
    <deployment>/.secrets/github-token     read access to its private repositories

A secret is taken from its environment variable, else from <deployment>/.secrets/.
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
                    values[name.strip()] = value.strip()
    return values


_local = _read_env_file(os.path.join(ROOT, "local.env"))
_deployment = None


def use_deployment(path, extensions=True):
    """Take the settings of a deployment folder, over those of this repository. Returns its absolute
    path, or exits with a message if it is not a deployment (a folder with extensions.json or
    extensions/, unless extensions is False: a folder only of settings and secrets, as that of the
    test site)."""
    global _deployment, _local
    path = os.path.abspath(path)
    has_extensions = os.path.isfile(os.path.join(path, "extensions.json")) or os.path.isdir(os.path.join(path, "extensions"))
    if not os.path.isdir(path) or (extensions and not has_extensions):
        raise SystemExit(f"Not a deployment (a folder with extensions.json or extensions/): {path}")
    _deployment = path
    # its own settings only: SW_DIST of this repository would have the build of the deployment replace its own
    _local = _read_env_file(os.path.join(path, "local.env"))
    return path


def deployment():
    return _deployment


def deployment_extension_names():
    """The extensions of this repository that the deployment names in its extensions.json:
    {"slicerweb": ["SlicerHeart", ...]} (docs/extensions.md). Exits with a message on a name that
    extensions/ of this repository has no description of."""
    path = os.path.join(_deployment, "extensions.json")
    if not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8") as handle:
            names = json.load(handle).get("slicerweb", [])
    except (OSError, ValueError, AttributeError) as e:
        raise SystemExit(f"{path}: {e}")
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise SystemExit(f'{path}: "slicerweb" is a list of extension names')
    unknown = [n for n in names if not os.path.isfile(os.path.join(ROOT, "extensions", f"{n}.json"))]
    if unknown:
        available = sorted(os.path.splitext(f)[0] for f in os.listdir(os.path.join(ROOT, "extensions")) if f.endswith(".json"))
        raise SystemExit(f"{path} names extensions that SlicerWeb has no description of: {', '.join(unknown)}"
                         f" (it has: {', '.join(available)})")
    return names


def assemble_deployment_extensions(folder):
    """Write the description files of the deployment's extensions into folder (emptied first): those
    of this repository that its extensions.json names, and its own extensions/*.json, which take
    the place of one of the same name (to build another revision of it, say). Returns
    {name: "slicerweb" or "deployment"}, where each came from."""
    if os.path.isdir(folder):
        shutil.rmtree(folder)
    os.makedirs(folder)
    origins = {}
    for name in deployment_extension_names():
        shutil.copyfile(os.path.join(ROOT, "extensions", f"{name}.json"), os.path.join(folder, f"{name}.json"))
        origins[name] = "slicerweb"
    own = os.path.join(_deployment, "extensions")
    for file in sorted(os.listdir(own)) if os.path.isdir(own) else []:
        if file.endswith(".json"):
            name = os.path.splitext(file)[0]
            if origins.get(name) == "slicerweb":
                print(f"{name}: the description of the deployment (extensions/{file}) is used, not that of SlicerWeb")
            shutil.copyfile(os.path.join(own, file), os.path.join(folder, file))
            origins[name] = "deployment"
    return origins


def default_dist():
    """Where a build is copied: SW_DIST, else ~/SlicerWeb-build/dist (dist-<name> for a deployment,
    so that it does not replace the build of another)."""
    name = f"dist-{os.path.basename(_deployment)}" if _deployment else "dist"
    return setting("SW_DIST", os.path.join(os.path.expanduser("~"), "SlicerWeb-build", name))


def deployment_repository():
    """owner/name of the GitHub repository a deployment folder is a checkout of (its origin)."""
    if not _deployment:
        return None
    url = subprocess.run(["git", "-C", _deployment, "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
    for prefix in ("https://github.com/", "git@github.com:", "ssh://git@github.com/"):
        if url.startswith(prefix):
            return url[len(prefix):].removesuffix(".git").strip("/")
    return None


def setting(name, default=None):
    """The value of a setting: the environment variable, else local.env, else the default."""
    value = os.environ.get(name)
    if value:
        return value
    return _local.get(name, default)


def secret(name, fileName):
    """A secret: the environment variable, else <deployment>/.secrets/<fileName>, else None."""
    value = os.environ.get(name)
    if value:
        return value.strip()
    if _deployment:
        path = os.path.join(_deployment, ".secrets", fileName)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                return handle.read().strip() or None
    return None

"""Settings of this computer for the build and deploy scripts (build.py, scripts/publish_*.py).

Settings are read from local.env at the root of this repository - NAME=value lines, as in
sources.env, kept out of the repository (.gitignore) - and an environment variable of the same name
overrides them. A setting that neither gives has the default the script passes.

    SW_DIST=D:/SlicerWeb-build/dist        where the wheels and web bundles are copied
    SW_EXTENSIONS_DIR=C:/D/SlicerWebExtensions

This repository holds no secrets. A deployment - a checkout of a repository with an extensions/
folder of its own, private extensions among them (docs/extensions.md) - is a folder of its own
(--deployment), with its own local.env, which is then read instead of this repository's, and its
secrets in .secrets/ (both kept out of that repository by its .gitignore):

    <deployment>/local.env                 SW_DIST=... (default: ~/SlicerWeb-build/dist-<name>)
    <deployment>/.secrets/github-token     read access to its private repositories

A secret is taken from its environment variable, else from <deployment>/.secrets/.
"""
import os
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
    path, or exits with a message if it is not a deployment (a folder with extensions/, unless
    extensions is False: a folder only of settings and secrets, as that of the test site)."""
    global _deployment, _local
    path = os.path.abspath(path)
    if not os.path.isdir(path) or (extensions and not os.path.isdir(os.path.join(path, "extensions"))):
        raise SystemExit(f"Not a deployment (a folder with extensions/): {path}")
    _deployment = path
    # its own settings only: SW_DIST of this repository would have the build of the deployment replace its own
    _local = _read_env_file(os.path.join(path, "local.env"))
    return path


def deployment():
    return _deployment


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

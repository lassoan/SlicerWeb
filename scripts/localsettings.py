"""Settings of this computer for the build and deploy scripts (build.py, scripts/publish_*.py).

They are read from local.env at the root of the repository - NAME=value lines, as in sources.env,
kept out of the repository (.gitignore) - and an environment variable of the same name overrides
the file. A setting that neither gives has the default the script passes.

    SW_DIST=D:/SlicerWeb-build/dist        where the wheels and web bundles are copied
    SW_EXTENSIONS_DIR=C:/D/SlicerWebExtensions
    CLOUDFLARE_ACCOUNT_ID=...              (publish_test_site.py)
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_FILE = os.path.join(ROOT, "local.env")


def _read_local():
    values = {}
    if os.path.exists(LOCAL_FILE):
        with open(LOCAL_FILE, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    name, value = line.split("=", 1)
                    values[name.strip()] = value.strip()
    return values


_local = _read_local()


def setting(name, default=None):
    """The value of a setting: the environment variable, else local.env, else the default."""
    value = os.environ.get(name)
    if value:
        return value
    return _local.get(name, default)


def secret(name, fileName):
    """A secret: the environment variable, else .secrets/<fileName> (git-ignored), else None."""
    value = os.environ.get(name)
    if value:
        return value.strip()
    path = os.path.join(ROOT, ".secrets", fileName)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip() or None
    return None

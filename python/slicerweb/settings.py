"""Minimal QSettings-compatible settings store.

Values are kept in a JSON file in the Emscripten file system. The web application persists
the file to IndexedDB (IDBFS) so that settings survive page reloads.
"""

import json
import os


class Settings:
    def __init__(self, path=None):
        self._path = path or os.path.join(os.path.expanduser("~"), ".config", "slicerweb", "settings.json")
        self._values = {}
        self._groups = []
        try:
            with open(self._path) as f:
                self._values = json.load(f)
        except (OSError, ValueError):
            self._values = {}

    def _key(self, key):
        return "/".join(self._groups + [key]) if self._groups else key

    def value(self, key, defaultValue=None, type=None):
        v = self._values.get(self._key(key), defaultValue)
        if type is not None and v is not None:
            try:
                if type is bool and isinstance(v, str):
                    return v.lower() in ("1", "true", "yes")
                return type(v)
            except (TypeError, ValueError):
                return defaultValue
        return v

    def setValue(self, key, value):
        self._values[self._key(key)] = value
        self.sync()

    def contains(self, key):
        return self._key(key) in self._values

    def remove(self, key):
        prefix = self._key(key)
        for k in [k for k in self._values if k == prefix or k.startswith(prefix + "/")]:
            del self._values[k]
        self.sync()

    def allKeys(self):
        return list(self._values.keys())

    def childKeys(self):
        prefix = "/".join(self._groups) + "/" if self._groups else ""
        return [k[len(prefix):] for k in self._values if k.startswith(prefix) and "/" not in k[len(prefix):]]

    def beginGroup(self, group):
        self._groups.append(group)

    def endGroup(self):
        if self._groups:
            self._groups.pop()

    def group(self):
        return "/".join(self._groups)

    def sync(self):
        try:
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
            with open(self._path, "w") as f:
                json.dump(self._values, f, indent=1)
        except OSError:
            pass
        from . import host

        host.call("persistFileSystem")

    def fileName(self):
        return self._path

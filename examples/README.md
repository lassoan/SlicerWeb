# Examples

Applications built from this checkout. Each is a folder like the repository of an application
([docs/extensions.md](../docs/extensions.md)): `application.json` says which extensions the
application has and which features it offers, and `.env` - copied from `.env.example`, kept out of
the repository by `.gitignore` - says where everything is on this computer. They are not published:
to publish one, copy it to a repository of its own, with a workflow such as that of
[lassoan/slicerweb-app](https://github.com/lassoan/slicerweb-app).

- `full/`: every extension of `extensions/` (`"slicerweb": "all"`), with every feature on. This is the
  application SlicerWeb is developed and tested with.
- `minimal/`: one extension of SlicerWeb, named (`SegmentEditorExtraEffects`), one of its own,
  described in its `extensions/` folder (`MarkupsToModel`, a copy of SlicerWeb's description, to show
  the format), and the developer mode, the Python console and the Extensions Manager off by default
  or not offered.

```sh
cd examples/full
cp .env.example .env       # then set the paths of this computer
python ../../slicerweb.py build
python ../../slicerweb.py dev
```

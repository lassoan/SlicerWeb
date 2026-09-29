#!/usr/bin/env python3
"""Upload the WebAssembly runtime of a local build to the "runtime" release, where the
"Publish app" workflow takes it from (.github/workflows/publish-app.yml).

    python scripts/publish_runtime.py
    python scripts/publish_runtime.py --publish       # also start the workflow that rebuilds the site
    python scripts/publish_runtime.py --repository myorg/slicerweb-deploy --publish

The wheels take hours to compile and no GitHub runner could build them, so they are built here and
uploaded: the workflow only builds the web application around them. They are not committed,
because every rebuild would be another 57 MB in the history of this repository for ever; a release
asset is replaced, not accumulated.

Needs the GitHub CLI, signed in with a token that may write to the repository (gh auth login).

A build with extensions of another folder (build.py --extensions-dir), private ones among them,
goes to a release of a private repository of its own, whose "Publish app" workflow calls this
repository's (docs/extensions.md). It is not uploaded to a public repository: extensions that
extensions/ of this repository does not have would be published with it.
"""
import argparse
import datetime
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from localsettings import ROOT, setting  # noqa: E402


def gh(*args, capture=False):
    """Run the GitHub CLI; its output when captured, else whether it succeeded."""
    result = subprocess.run(["gh", *args], capture_output=capture, text=True)
    if capture:
        return result.stdout.strip() if result.returncode == 0 else None
    return result.returncode == 0


def main():
    # each line as soon as it is written, also into a file or a pipe (in order with what gh, docker or
    # cloudflared write)
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("--dist", default=setting("SW_DIST", os.path.join(os.path.expanduser("~"), "SlicerWeb-build", "dist")),
                        help="where the build copied the wheels and extensions (SW_DIST)")
    parser.add_argument("--repository", default=setting("SW_RUNTIME_REPOSITORY", "lassoan/SlicerWeb"),
                        help="the repository whose release receives them")
    parser.add_argument("--tag", default="runtime", help="the release")
    parser.add_argument("--publish", action="store_true", help="then start the workflow that rebuilds the site")
    parser.add_argument("--dry-run", action="store_true", help="check and package, but upload nothing")
    args = parser.parse_args()

    for name in ("wheels", "extensions"):
        if not os.path.isdir(os.path.join(args.dist, name)):
            sys.exit(f"Not found: {os.path.join(args.dist, name)} (run: python build.py 60-wheels 80-extensions)")

    visibility = gh("repo", "view", args.repository, "--json", "visibility", "--jq", ".visibility", capture=True)
    if visibility is None:
        sys.exit(f"Repository {args.repository} cannot be read")
    if visibility == "PUBLIC":
        with open(os.path.join(args.dist, "extensions", "index.json"), encoding="utf-8") as handle:
            built = [e["name"] for e in json.load(handle).get("extensions", [])]
        ours = {os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(ROOT, "extensions", "*.json"))}
        others = [name for name in built if name not in ours]
        if others:
            sys.exit(f"{args.repository} is public, and the build has extensions that extensions/ of SlicerWeb has not: "
                     f"{', '.join(others)}. Upload it to a private repository (--repository).")

    staging = tempfile.mkdtemp(prefix="slicerweb-runtime-")
    try:
        assets = []
        for name in ("wheels", "extensions"):
            # the files of the folder at the root of the archive, as the workflow unpacks them
            archive = shutil.make_archive(os.path.join(staging, name), "zip", os.path.join(args.dist, name))
            print(f"{name} ({os.path.getsize(archive) / 1048576:.1f} MB)")
            assets.append(archive)
        if args.dry_run:
            print(f"Dry run: nothing uploaded to {args.repository} (release {args.tag})")
            return 0

        # The release is a place to keep files, not an announcement: it is a prerelease, and its notes
        # say which build the files came from.
        commit = subprocess.run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
        notes = ("WebAssembly runtime of SlicerWeb: the wheels the application is built on (VTK, ITK, the Slicer libraries and "
                 "modules) and the extension wheels.\n\n"
                 f"Built {datetime.datetime.now():%Y-%m-%d %H:%M} from {commit}.")
        if gh("release", "view", args.tag, "--repo", args.repository, capture=True) is not None:
            print(f"Updating release {args.tag}")
            ok = gh("release", "edit", args.tag, "--repo", args.repository, "--notes", notes)
        else:
            print(f"Creating release {args.tag}")
            ok = gh("release", "create", args.tag, "--repo", args.repository, "--title", "Runtime wheels", "--notes", notes,
                    "--prerelease", "--target", "main")
        if not ok:
            sys.exit("The release could not be written")
        if not gh("release", "upload", args.tag, "--repo", args.repository, "--clobber", *assets):
            sys.exit("The wheels could not be uploaded")
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    if args.publish:
        if not gh("workflow", "run", "publish-app.yml", "--repo", args.repository):
            sys.exit("The workflow could not be started")
        print(f"Publishing: gh run watch --repo {args.repository}")
    else:
        print(f"Uploaded. Rebuild the site with: gh workflow run publish-app.yml --repo {args.repository}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

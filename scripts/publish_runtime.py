#!/usr/bin/env python3
"""Upload the WebAssembly runtime of a local build to a release - "runtime", or "runtime-<channel>" -
where the "Publish app" workflow takes it from (.github/workflows/publish-app.yml).

    python scripts/publish_runtime.py --deployment ../slicerweb-app --channel latest --publish
    python scripts/publish_runtime.py --deployment ../SlicerHeartWebViewer-deploy --channel latest --publish
    python scripts/publish_runtime.py --repository myorg/slicerweb-deploy --channel stable --publish
    python scripts/publish_runtime.py --publish       # the "runtime" release of this repository

The published application, https://lassoan.github.io/slicerweb-app/, is a deployment like any other
(lassoan/slicerweb-app, docs/extensions.md): its build goes to the runtime-latest release there.

A deployment repository can publish several channels - latest, stable, 1.0.0, ... - each to a
branch of its own, deploy/<channel>, from a runtime release of its own, runtime-<channel>, so that a
version keeps the build it was published with (docs/extensions.md). --channel uploads to that
release and, with --publish, runs the repository's workflow for that channel.

The wheels take hours to compile and no GitHub runner could build them, so they are built here and
uploaded: the workflow only builds the web application around them. They are not committed,
because every rebuild would be another 57 MB in the history of this repository for ever; a release
asset is replaced, not accumulated.

Needs the GitHub CLI, signed in with a token that may write to the repository (gh auth login).

A deployment's build goes to a release of the deployment's repository, whose "Publish app" workflow
calls this repository's (docs/extensions.md). With --deployment, a checkout of that repository, the
dist folder and the repository are those of the deployment (its local.env, else the dist folder
build.py --deployment used, and the repository it is a checkout of). A build is not uploaded to a
public repository if it has an extension whose source cannot be read without a token: private
extensions go to a private repository.
"""
import sys

sys.dont_write_bytecode = True   # nothing generated in the checkout (scripts/__pycache__)

import argparse  # noqa: E402
import base64  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import localsettings  # noqa: E402
from localsettings import ROOT, setting  # noqa: E402


def gh(*args, capture=False):
    """Run the GitHub CLI; its output when captured, else whether it succeeded."""
    result = subprocess.run(["gh", *args], capture_output=capture, text=True)
    if capture:
        return result.stdout.strip() if result.returncode == 0 else None
    return result.returncode == 0


#: the repository the web application is built from by the workflow (its input slicerwebRepository)
SLICERWEB_REPOSITORY = "lassoan/SlicerWeb"


def read_build_info(dist):
    """wheels/build-info.json of the build (build.py), or None for a build made before it was written."""
    path = os.path.join(dist, "wheels", "build-info.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def describe(info):
    if not info:
        return "Build of unknown date and commit (no wheels/build-info.json: rebuild with build.py)."
    def version(v):
        return f"{v['commit'][:7]}{' with uncommitted changes' if v.get('modified') else ''}" if v and v.get("commit") else "?"
    text = f"Built {info.get('date', '?')} from SlicerWeb {version(info.get('slicerweb'))}"
    if info.get("deployment"):
        text += f" and {info['deployment'].get('name', 'the deployment')} {version(info['deployment'])}"
    return text + "."


def workflow_has_input(repository, name):
    """Whether the "Publish app" workflow of the repository takes an input of that name."""
    content = gh("api", f"repos/{repository}/contents/.github/workflows/publish-app.yml", "--jq", ".content", capture=True)
    if not content:
        return False
    text = base64.b64decode(content).decode("utf-8", "replace")
    return f"\n      {name}:" in text and "workflow_dispatch" in text


def public_extension(name, dist):
    """Whether an extension of a build may go to a public repository: one described in extensions/ of
    SlicerWeb, as it is there, or one of a deployment (<dist>/extension-descriptions, which build.py
    --deployment writes) whose source can be read without a token. A build of another folder of
    descriptions (--extensions-dir) has only those of SlicerWeb that it can be told apart by."""
    ours = os.path.join(ROOT, "extensions", f"{name}.json")
    built = os.path.join(dist, "extension-descriptions", f"{name}.json")
    if not os.path.isfile(built):
        return os.path.isfile(ours)
    with open(built, encoding="utf-8") as handle:
        description = handle.read()
    if os.path.isfile(ours):
        with open(ours, encoding="utf-8") as handle:
            if handle.read() == description:
                return True
    url = json.loads(description).get("scm_url", "")
    if not url.startswith("https://"):
        return False
    # without the credentials of this computer: what anyone can read
    environment = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="", GCM_INTERACTIVE="never")
    result = subprocess.run(["git", "-c", "credential.helper=", "ls-remote", "--exit-code", url, "HEAD"],
                            capture_output=True, env=environment)
    return result.returncode == 0


def main():
    # each line as soon as it is written, also into a file or a pipe (in order with what gh, docker or
    # cloudflared write)
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("--deployment", default=None, help="a deployment folder, a checkout of the repository to publish (see above)")
    parser.add_argument("--dist", default=None, help="where the build copied the wheels and extensions (SW_DIST)")
    parser.add_argument("--repository", default=None, help="the repository whose release receives them (SW_RUNTIME_REPOSITORY)")
    parser.add_argument("--tag", default=None, help="the release (default: runtime, or runtime-<channel>)")
    parser.add_argument("--channel", default=None,
                        help="a deployment channel (latest, stable, 1.0.0, ...): release runtime-<channel>, published to branch deploy/<channel>")
    parser.add_argument("--publish", action="store_true", help="then start the workflow that rebuilds the site")
    parser.add_argument("--dry-run", action="store_true", help="check and package, but upload nothing")
    args = parser.parse_args()
    if args.deployment:
        localsettings.use_deployment(args.deployment)
        args.repository = args.repository or setting("SW_RUNTIME_REPOSITORY") or localsettings.deployment_repository()
        if not args.repository:
            parser.error("the deployment folder is not a checkout of a GitHub repository: give --repository")
    args.dist = args.dist or localsettings.default_dist()
    args.repository = args.repository or setting("SW_RUNTIME_REPOSITORY", "lassoan/SlicerWeb")
    if args.channel and not all(c.isalnum() or c in "._-" for c in args.channel):
        parser.error(f"a channel is a name like latest, stable or 1.0.0, not {args.channel!r}")
    if args.tag is None:
        args.tag = f"runtime-{args.channel}" if args.channel else "runtime"

    for name in ("wheels", "extensions"):
        if not os.path.isdir(os.path.join(args.dist, name)):
            sys.exit(f"Not found: {os.path.join(args.dist, name)} (run: python build.py 60-wheels 80-extensions)")
    # The configuration of the application as the deployment has it now: a change of it needs no build
    if args.deployment:
        localsettings.write_application_config(args.dist)

    visibility = gh("repo", "view", args.repository, "--json", "visibility", "--jq", ".visibility", capture=True)
    if visibility is None:
        sys.exit(f"Repository {args.repository} cannot be read")
    if visibility == "PUBLIC":
        with open(os.path.join(args.dist, "extensions", "index.json"), encoding="utf-8") as handle:
            built = [e["name"] for e in json.load(handle).get("extensions", [])]
        private = [name for name in built if not public_extension(name, args.dist)]
        if private:
            sys.exit(f"{args.repository} is public, and the build has extensions whose source cannot be read without a "
                     f"token: {', '.join(private)}. Upload it to a private repository (--repository).")

    # What the build is made of (build.py writes it), and the web application built around it: of the
    # same commit of SlicerWeb, where the workflow can be told which (an input slicerwebRef)
    info = read_build_info(args.dist)
    print(describe(info))
    slicerwebRef = None
    if args.publish and info and info.get("slicerweb") and workflow_has_input(args.repository, "slicerwebRef"):
        slicerwebRef = info["slicerweb"]["commit"]
        if gh("api", f"repos/{SLICERWEB_REPOSITORY}/commits/{slicerwebRef}", "--silent", capture=True) is None:
            sys.exit(f"The build is of SlicerWeb {slicerwebRef[:7]}, which is not in {SLICERWEB_REPOSITORY}: push it first, "
                     "so that the web application is built from the same commit")
        if info["slicerweb"].get("modified"):
            print(f"Warning: the build was made with changes of SlicerWeb that are not committed; the web application is "
                  f"built from {slicerwebRef[:7]} without them")

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
        notes = ("WebAssembly runtime of SlicerWeb: the wheels the application is built on (VTK, ITK, the Slicer libraries and "
                 "modules) and the extension wheels.\n\n" + describe(info))
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
        inputs = ["-f", f"channel={args.channel}"] if args.channel else []
        if slicerwebRef:
            inputs += ["-f", f"slicerwebRef={slicerwebRef}"]
        if not gh("workflow", "run", "publish-app.yml", "--repo", args.repository, *inputs):
            sys.exit("The workflow could not be started")
        print(f"Publishing: gh run watch --repo {args.repository}")
    else:
        print(f"Uploaded. Rebuild the site with: gh workflow run publish-app.yml --repo {args.repository}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

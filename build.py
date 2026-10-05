#!/usr/bin/env python3
"""Run SlicerWeb build stages inside the toolchain container (on Windows, Linux or macOS).

slicerweb.py runs this as the env file of an application says (python slicerweb.py build, in
the folder of the application: a deployment, or examples/full); this is what it calls.

    python build.py 00-sources 10-vtk-compiletools 20-vtk
    python build.py all
    python build.py --deployment ../SlicerHeartWebViewer-app 60-wheels 80-extensions
    python build.py --extensions-dir ../SlicerWebExtensions 80-extensions
    python build.py --extensions SlicerHeart 80-extensions      # only rebuild some of them
    python build.py shell

Needs Docker and Python 3.8 or later. The stages themselves run in the container
(scripts/build.sh); this only starts it, with the build volume, this repository, the folder the
wheels and web bundles are copied to (--dist, or SW_DIST in .env or the environment), and the
extension folder (--extensions-dir, or SW_EXTENSIONS_DIR) mounted.

The build volume (SW_BUILD_VOLUME, default slicerweb-build) is a Docker volume with the build trees
of VTK, ITK, Slicer and the extensions, built from the sources this checkout pins. It belongs to one
checkout: the first build records which, and a build of another checkout is refused - give each
SlicerWeb checkout a volume of its own (the applications built with one checkout share it).

A deployment (--deployment, docs/extensions.md) is a checkout of a repository of its own: its
extensions are those of extensions/ here that its application.json names, and the description
files of its own extensions folder (put together in <dist>/extension-descriptions, which is the
extension folder of the build), and the configuration of its application goes to
<dist>/wheels/application.json, and its .env has its settings (SW_DIST, by default
~/SlicerWeb-build/dist-<name of the folder>).

A GitHub token for private repositories is taken from the SW_GIT_TOKEN environment variable, or
from the file github-token of the folder SW_SECRETS names - no checkout holds secrets; without one,
only public repositories can be fetched. It is passed by name, so that its value is not on the command line. Everything the build runs can read
it - the extensions' own code included - so the token to use is a fine-grained one that can only
read the repositories it is needed for.
"""
import sys

sys.dont_write_bytecode = True   # nothing generated in the checkout (scripts/__pycache__)

import argparse  # noqa: E402
import datetime  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
import localsettings  # noqa: E402
from localsettings import ROOT, secret, setting  # noqa: E402

IMAGE = "slicerweb-toolchain:emsdk5.0.3"
DEFAULT_VOLUME = "slicerweb-build"   # Docker volume with the build trees (lives in Docker's data disk)


def main():
    # each line as soon as it is written, also into a file or a pipe (in order with what gh, docker or
    # cloudflared write)
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("stages", nargs="*", default=["all"], help="stages to run (default: all), or shell")
    parser.add_argument("--deployment", default=None,
                        help="a deployment folder: its application.json and .env (see above)")
    parser.add_argument("--extensions-dir", default=None,
                        help="folder of extension description files for 80-extensions (default: extensions/ of this repository); "
                             "the build then has those extensions only - the others are removed from it and from --dist, so "
                             "give a build of another folder a --dist of its own")
    parser.add_argument("--extensions", default=os.environ.get("SW_EXTENSIONS", ""),
                        help="names of the extensions to build this time, separated by spaces (default: all)")
    parser.add_argument("--dist", default=None, help="where the wheels and web bundles are copied (SW_DIST)")
    args = parser.parse_args()
    if args.deployment:
        localsettings.use_deployment(args.deployment)
    args.extensions_dir = args.extensions_dir or setting("SW_EXTENSIONS_DIR")
    args.dist = args.dist or localsettings.default_dist()

    dist = os.path.abspath(args.dist)
    os.makedirs(dist, exist_ok=True)
    if args.deployment and not args.extensions_dir:
        # Those of extensions/ here that it names, and its own (docs/extensions.md)
        args.extensions_dir = os.path.join(dist, "extension-descriptions")
        origins = localsettings.assemble_deployment_extensions(args.extensions_dir)
        print(f"Extensions of the deployment: {', '.join(sorted(n for n, o in origins.items() if o == 'slicerweb')) or 'none'} from SlicerWeb; "
              f"{', '.join(sorted(n for n, o in origins.items() if o == 'deployment')) or 'none'} of its own")

    if subprocess.run(["docker", "image", "inspect", IMAGE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        if subprocess.run(["docker", "build", "-t", IMAGE, os.path.join(ROOT, "docker")]).returncode != 0:
            return 1

    # The build volume of this checkout (scripts/build.sh refuses one that another checkout built in)
    volume = setting("SW_BUILD_VOLUME", DEFAULT_VOLUME)
    # This checkout is read-only in the container: everything built goes to the build volume and to
    # the dist folder, nothing into the sources (Python writes no bytecode next to them either)
    command = ["docker", "run", "--rm", "-i",
               "-v", f"{volume}:/build", "-v", f"{ROOT}:/work:ro", "-v", f"{dist}:/dist",
               "-e", f"SW_CHECKOUT={os.path.normcase(ROOT)}", "-e", f"SW_BUILD_VOLUME={volume}",
               "-e", "PYTHONDONTWRITEBYTECODE=1",
               "-e", f"SW_PROFILE={os.environ.get('SW_PROFILE', '')}",
               "-e", f"SW_CONFIGURE_ONLY={os.environ.get('SW_CONFIGURE_ONLY', '')}",
               "-e", f"SW_EXTENSIONS={args.extensions}"]
    # The extension folder, mounted where 80-extensions reads it (extensions/ of this repository is /work/extensions)
    if args.extensions_dir:
        extensionsDir = os.path.abspath(args.extensions_dir)
        if not os.path.isdir(extensionsDir):
            parser.error(f"not a folder: {extensionsDir}")
        command += ["-v", f"{extensionsDir}:/extensions:ro", "-e", "SW_EXTENSIONS_DIR=/extensions"]
    env = dict(os.environ)
    token = secret("SW_GIT_TOKEN", "github-token")
    if token:
        env["SW_GIT_TOKEN"] = token
        command += ["-e", "SW_GIT_TOKEN"]   # by name: the value is taken from the environment
    if "shell" in args.stages and sys.stdin.isatty():
        command.append("-t")
    command += [IMAGE, "bash", "/work/scripts/build.sh"] + args.stages
    result = subprocess.run(command, env=env).returncode
    if result == 0 and "shell" not in args.stages:
        write_build_info(dist)
        localsettings.write_application_config(dist)
    return result


def git_version(folder):
    """{commit, modified} of a checkout: its commit, and whether files of it differ from that commit."""
    def git(*args):
        return subprocess.run(["git", "-C", folder, *args], capture_output=True, text=True).stdout.strip()
    commit = git("rev-parse", "HEAD")
    if not commit:
        return None
    return {"commit": commit, "modified": bool(git("status", "--porcelain", "--untracked-files=no"))}


def write_build_info(dist):
    """What the build is made of, next to the wheels (wheels/build-info.json): when it was built and
    from which commits of this repository and of the deployment. It goes wherever the wheels go - the
    runtime release, the site - and the application shows it at the end of its menu. (The revisions
    of the extensions are in extensions/index.json.)"""
    wheels = os.path.join(dist, "wheels")
    if not os.path.isdir(wheels):
        return
    info = {"date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "slicerweb": git_version(ROOT)}
    deployment = localsettings.deployment()
    if deployment:
        info["deployment"] = {"name": localsettings.deployment_repository() or os.path.basename(deployment),
                              **(git_version(deployment) or {})}
    with open(os.path.join(wheels, "build-info.json"), "w", encoding="utf-8") as handle:
        json.dump(info, handle, indent=1)
    print(f"Build info: {json.dumps(info)}")


if __name__ == "__main__":
    sys.exit(main())

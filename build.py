#!/usr/bin/env python3
"""Run SlicerWeb build stages inside the toolchain container (on Windows, Linux or macOS).

    python build.py 00-sources 10-vtk-compiletools 20-vtk
    python build.py all
    python build.py --extensions-dir ../SlicerWebExtensions 80-extensions
    python build.py --extensions SlicerHeart 80-extensions      # only rebuild some of them
    python build.py shell

Needs Docker and Python 3.8 or later. The stages themselves run in the container
(scripts/build.sh); this only starts it, with the build volume, this repository, the folder the
wheels and web bundles are copied to (--dist, or SW_DIST in local.env or the environment), and the
extension folder (--extensions-dir, or SW_EXTENSIONS_DIR) mounted.

A GitHub token for private repositories is taken from the SW_GIT_TOKEN environment variable, or
from the file .secrets/github-token; without one, only public repositories can be fetched. It is
passed by name, so that its value is not on the command line. Everything the build runs can read
it - the extensions' own code included - so the token to use is a fine-grained one that can only
read the repositories it is needed for.
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
from localsettings import ROOT, secret, setting  # noqa: E402

IMAGE = "slicerweb-toolchain:emsdk5.0.3"
VOLUME = "slicerweb-build"   # Docker volume with the build trees (lives in Docker's data disk)


def main():
    # each line as soon as it is written, also into a file or a pipe (in order with what gh, docker or
    # cloudflared write)
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("stages", nargs="*", default=["all"], help="stages to run (default: all), or shell")
    parser.add_argument("--extensions-dir", default=setting("SW_EXTENSIONS_DIR"),
                        help="folder of extension description files for 80-extensions (default: extensions/ of this repository); "
                             "the build then has those extensions only - the others are removed from it and from --dist, so "
                             "give a build of another folder a --dist of its own")
    parser.add_argument("--extensions", default=os.environ.get("SW_EXTENSIONS", ""),
                        help="names of the extensions to build this time, separated by spaces (default: all)")
    parser.add_argument("--dist", default=setting("SW_DIST", os.path.join(os.path.expanduser("~"), "SlicerWeb-build", "dist")),
                        help="where the wheels and web bundles are copied")
    args = parser.parse_args()

    dist = os.path.abspath(args.dist)
    os.makedirs(dist, exist_ok=True)

    if subprocess.run(["docker", "image", "inspect", IMAGE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        if subprocess.run(["docker", "build", "-t", IMAGE, os.path.join(ROOT, "docker")]).returncode != 0:
            return 1

    command = ["docker", "run", "--rm", "-i",
               "-v", f"{VOLUME}:/build", "-v", f"{ROOT}:/work", "-v", f"{dist}:/dist",
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
    return subprocess.run(command, env=env).returncode


if __name__ == "__main__":
    sys.exit(main())

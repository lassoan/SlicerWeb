#!/usr/bin/env python3
"""Publish the download proxy (download-proxy/worker.js) as a Cloudflare Worker, so that the
application published as static files can read files of servers that refuse cross-origin requests.

    python scripts/publish_download_proxy.py --deployment ../SlicerWeb-test-site

What it needs, in local.env of that folder (or the environment) - a folder of its own, outside this
repository, which holds no secrets:

    CLOUDFLARE_ACCOUNT_ID=...
    DOWNLOAD_PROXY_NAME=slicerweb-download          name of the Worker (default)
    DOWNLOAD_PROXY_ORIGINS=https://lassoan.github.io
                     sites whose pages may use it, separated by commas (default: this one);
                     pages served from localhost may always use it
    DOWNLOAD_PROXY_MAX_BYTES=4294967296             largest file it passes on (default: 4 GB)

and an API token with the "Workers Scripts - Edit" account permission, in the file
.secrets/cloudflare-api-token of that folder or in CLOUDFLARE_API_TOKEN.

The Worker is published at https://<name>.<account subdomain>.workers.dev/, and that address is
checked before it is printed. The application is then built with it (.github/workflows/publish-app.yml
takes it from the repository variable SLICERWEB_DOWNLOAD_PROXY):

    VITE_DOWNLOAD_PROXY=https://<name>.<account subdomain>.workers.dev/?url=
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import localsettings  # noqa: E402
from localsettings import ROOT, secret, setting  # noqa: E402

#: Cloudflare turns away Python's own user agent (Python-urllib: 403)
USER_AGENT = "SlicerWeb publish_download_proxy.py"
COMPATIBILITY_DATE = "2026-09-01"
#: a small file to check the published Worker with
CHECK_URL = "https://github.com/lassoan/SlicerWeb/raw/main/README.md"


def api(method, url, token, body=None, contentType="application/json"):
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, method=method, data=data,
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": contentType,
                                              "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        said = error.read().decode(errors="replace")
        hint = (" (the token needs the \"Workers Scripts - Edit\" account permission)"
                if error.code in (401, 403) else "")
        sys.exit(f"{method} {url} failed: {error.code} {error.reason}{hint}\n{said}")


def multipart(parts):
    """A multipart/form-data body of (name, filename, content type, bytes) parts, and its content type."""
    boundary = uuid.uuid4().hex
    body = b""
    for name, filename, contentType, content in parts:
        disposition = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        body += (f"--{boundary}\r\nContent-Disposition: {disposition}\r\nContent-Type: {contentType}\r\n\r\n").encode()
        body += content + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def check(base, origin):
    """Exits with a message unless the Worker at *base* passes on a file for a page of *origin*, and
    turns away a request that is not from one."""
    def get(headers):
        request = urllib.request.Request(base + urllib.parse.quote(CHECK_URL, safe=""),
                                         headers={"User-Agent": USER_AGENT, **headers})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    # a new workers.dev address can take a little while to be known everywhere
    for attempt in range(12):
        try:
            status, headers, content = get({"Origin": origin})
            break
        except urllib.error.URLError as error:
            if attempt == 11:
                sys.exit(f"{base} could not be reached: {error.reason}")
            time.sleep(10)
    if status != 200 or headers.get("Access-Control-Allow-Origin") != origin or not content:
        sys.exit(f"{base} did not pass on {CHECK_URL} for a page of {origin}: {status}\n{content[:500].decode(errors='replace')}")
    status, _, _ = get({})
    if status != 403:
        sys.exit(f"{base} answered {status} to a request that is not from a page of an allowed site (403 expected)")


def main():
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("--deployment", default=None, help="the folder of the Cloudflare settings and secrets (see above)")
    args = parser.parse_args()
    if args.deployment:
        localsettings.use_deployment(args.deployment, extensions=False)

    account = setting("CLOUDFLARE_ACCOUNT_ID")
    if not account:
        sys.exit("CLOUDFLARE_ACCOUNT_ID is not set (local.env of the --deployment folder, or the environment)")
    token = secret("CLOUDFLARE_API_TOKEN", "cloudflare-api-token")
    if not token:
        sys.exit("Save the API token (Workers Scripts - Edit) in .secrets/cloudflare-api-token of the --deployment folder")
    name = setting("DOWNLOAD_PROXY_NAME", "slicerweb-download")
    origins = setting("DOWNLOAD_PROXY_ORIGINS", "https://lassoan.github.io")
    maxBytes = setting("DOWNLOAD_PROXY_MAX_BYTES", str(4 * 1024 ** 3))

    scripts = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers"
    with open(os.path.join(ROOT, "download-proxy", "worker.js"), "rb") as handle:
        code = handle.read()
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": COMPATIBILITY_DATE,
        "bindings": [
            {"type": "plain_text", "name": "ALLOWED_ORIGINS", "text": origins},
            {"type": "plain_text", "name": "MAX_BYTES", "text": maxBytes},
        ],
    }
    body, contentType = multipart([("metadata", None, "application/json", json.dumps(metadata).encode()),
                                   ("worker.js", "worker.js", "application/javascript+module", code)])
    print(f"Publishing the Worker {name} (pages of {origins} may use it)")
    api("PUT", f"{scripts}/scripts/{name}", token, body, contentType)
    api("POST", f"{scripts}/scripts/{name}/subdomain", token, {"enabled": True, "previews_enabled": False})
    subdomain = api("GET", f"{scripts}/subdomain", token)["result"]["subdomain"]
    base = f"https://{name}.{subdomain}.workers.dev/?url="

    print(f"Checking {base}")
    check(base, origins.split(",")[0].strip().rstrip("/"))
    print(f"""
The download proxy works. Build the application with it:

    VITE_DOWNLOAD_PROXY={base}

For the published site, set it as the repository variable the workflow reads:

    gh variable set SLICERWEB_DOWNLOAD_PROXY --repo lassoan/SlicerWeb --body "{base}"
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())

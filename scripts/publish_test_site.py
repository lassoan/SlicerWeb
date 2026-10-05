#!/usr/bin/env python3
"""Publish a local build of SlicerWeb as a test site through a Cloudflare tunnel, restricted by
Cloudflare Access to the email addresses of one domain.

    python scripts/publish_test_site.py --settings ../SlicerWeb-test-site

What it needs, in .env of that folder (or the environment) - a folder of its own, outside this
repository, which holds no secrets:

    TEST_SITE_HOSTNAME=slicerweb.example.org     the hostname of the tunnel
    TEST_SITE_EMAIL_DOMAIN=example.org           who may sign in
    CLOUDFLARE_ACCOUNT_ID=...
    CLOUDFLARED=/path/to/cloudflared             (default: cloudflared, on the PATH)
    CLOUDFLARED_CONFIG=/path/to/config.yml       the configuration of the tunnel
    TEST_SITE_LOCAL_URL=http://localhost:4173/   where the site is served here (default)

and an API token with the "Access: Apps and Policies - Edit" account permission, in the file
cloudflare-api-token of the folder that SW_SECRETS in that .env names, or in CLOUDFLARE_API_TOKEN.
The tunnel and its DNS record are made once with cloudflared. The site is served here with:
cd web; npx vite preview --port 4173

The tunnel is started only after Access protection of the hostname has been verified.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import localsettings  # noqa: E402
from localsettings import secret, setting  # noqa: E402


#: Cloudflare turns away Python's own user agent (Python-urllib: 403) from a site behind Access
USER_AGENT = "SlicerWeb publish_test_site.py"


def api(method, url, token, body=None):
    request = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                                              "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def access_redirect(url):
    """Where an unauthenticated request for the site is sent (the Location of the redirect)."""
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=15) as response:
            return response.headers.get("Location", "")
    except urllib.error.HTTPError as error:   # a redirect not followed comes back as an error
        return error.headers.get("Location", "") if error.headers else ""
    except urllib.error.URLError:
        return ""


def main():
    # each line as soon as it is written, also into a file or a pipe (in order with what gh, docker or
    # cloudflared write)
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("--settings", default=None, help="the folder of the settings and secrets of the test site (see above)")
    args = parser.parse_args()
    if args.settings:
        localsettings.use_settings_folder(args.settings)
    missing = [name for name in ("TEST_SITE_HOSTNAME", "TEST_SITE_EMAIL_DOMAIN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARED_CONFIG")
               if not setting(name)]
    if missing:
        sys.exit(f"Set {', '.join(missing)} in .env (see: python scripts/publish_test_site.py --help)")
    hostname, emailDomain = setting("TEST_SITE_HOSTNAME"), setting("TEST_SITE_EMAIL_DOMAIN")
    token = secret("CLOUDFLARE_API_TOKEN", "cloudflare-api-token")
    if not token:
        sys.exit("Save the API token (Access: Apps and Policies - Edit) in cloudflare-api-token of the folder SW_SECRETS names (.env of the --settings folder)")
    apps = f"https://api.cloudflare.com/client/v4/accounts/{setting('CLOUDFLARE_ACCOUNT_ID')}/access/apps"

    app = {
        "name": "SlicerWeb test site",
        "domain": hostname,
        "type": "self_hosted",
        "session_duration": "24h",
        "app_launcher_visible": False,
        "policies": [{
            "name": f"Allow {emailDomain}",
            "decision": "allow",
            "include": [{"email_domain": {"domain": emailDomain}}],
        }],
    }
    existing = next((a for a in api("GET", apps, token)["result"] if a.get("domain") == hostname), None)
    if existing:
        print(f"Updating Access application {existing['id']} for {hostname}")
        api("PUT", f"{apps}/{existing['id']}", token, app)
    else:
        print(f"Creating Access application for {hostname}")
        api("POST", apps, token, app)

    # Verify: an unauthenticated request must be redirected to the Access login page
    for _ in range(30):
        if "cloudflareaccess.com" in access_redirect(f"https://{hostname}/"):
            break
        time.sleep(2)
    else:
        sys.exit(f"https://{hostname}/ is not protected by Cloudflare Access; the tunnel is not started")
    print(f"Access protection verified (only @{emailDomain} addresses can sign in)")

    local = setting("TEST_SITE_LOCAL_URL", "http://localhost:4173/")
    try:
        urllib.request.urlopen(urllib.request.Request(local, headers={"User-Agent": USER_AGENT}), timeout=5).close()
    except (urllib.error.URLError, OSError):
        sys.exit(f"The site is not served on {local} (run: cd web; npx vite preview --port 4173)")

    print(f"Starting tunnel: https://{hostname}/")
    return subprocess.run([setting("CLOUDFLARED", "cloudflared"), "--config", setting("CLOUDFLARED_CONFIG"), "tunnel", "run"]).returncode


if __name__ == "__main__":
    sys.exit(main())

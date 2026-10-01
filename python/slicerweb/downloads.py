"""Downloads for Python code that expects urllib (slicer.util.downloadFile, SampleData, tests).

Pyodide has no sockets, so urllib cannot open connections. Downloads are done by the browser with a
synchronous XMLHttpRequest, so that they can be used from synchronous Python code (module logic,
self tests). Hosts that do not allow cross-origin requests (e.g. GitHub release assets) cannot be
read by the page at all, so a file from one is looked for in two other places first: the copies the
site carries of the sample data (sample-data/mirror.json, written when the site is built), and the
application's download proxy where there is one (web/vite.assets.ts on the development server; a
site of static files, such as the published one, has one only where it was built with the address
of one, see download-proxy/worker.js).
"""

import logging
import os
import urllib.parse
import urllib.request

logger = logging.getLogger("slicerweb.downloads")

_JS_DOWNLOAD = """
(function (url, proxyBase) {
  function get(u) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", u, false);  // synchronous: the caller is synchronous Python code
    // read the response as binary (responseType cannot be used with synchronous requests)
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send(null);
    if (xhr.status && xhr.status >= 400) throw new Error(xhr.status + " " + xhr.statusText);
    const text = xhr.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }
  try {
    return get(url);
  } catch (e) {
    if (!proxyBase) throw e;
    try {
      return get(proxyBase + encodeURIComponent(url));  // other origin: download proxy
    } catch (proxyError) {
      // A site behind a sign-in answers a request whose sign-in has expired with a redirect to
      // the sign-in page, which arrives here as no answer at all rather than as a status.
      const said = String((proxyError && proxyError.message) || proxyError);
      throw new Error(/[0-9]{3}/.test(said) ? said
        : said + " (this site did not answer; if the sign-in has expired, reload the page and try again)");
    }
  }
})
"""

_download = None
_mirror = None


def _site_base():
    """Where the application is published, with a trailing slash."""
    import js

    base = str(js.document.baseURI)
    return base[: base.rfind("/") + 1]


def _proxy_base():
    """The start of the address through which files of other sites are fetched for the page (the
    address of the file is appended to it), or "" where nothing fetches them."""
    try:
        import slicerweb_downloads

        proxy = getattr(slicerweb_downloads, "proxy", None)
        if proxy is not None:
            return str(proxy)
    except ImportError:
        pass
    try:
        return _site_base() + "download?url="   # the development server's
    except Exception:
        return ""


def _mirrored(url):
    """The copy this site holds of this file, or "" where it holds none.

    The map is read once, and its absence is remembered: a site that carries no sample data (the
    development server, which fetches it instead) must not be asked for it before every download.
    """
    global _mirror
    if _mirror is None:
        _mirror = {}
        try:
            import json

            _mirror = json.loads(bytes(download(_site_base() + "sample-data/mirror.json", mirrored=False)))
        except Exception:
            logger.debug("This site holds no copies of sample data", exc_info=True)
    name = _mirror.get(str(url))
    return _site_base() + "sample-data/" + name if name else ""


def direct_download_url(url):
    """The address the file itself is downloaded from, for an address that leads to a page about it.

    A Dropbox share link (www.dropbox.com/scl/fi/... or /s/..., ?dl=0) answers with a page that
    shows the file, and even with ?dl=1 it sends the file through a redirect that other sites may not
    read. The same link on dl.dropboxusercontent.com answers with the file, readable by any site
    (as directDownloadURL in web/src/core/runtime.ts). Other addresses are returned as they are.
    """
    parsed = urllib.parse.urlsplit(str(url))
    if parsed.hostname in ("www.dropbox.com", "dropbox.com") and (
            parsed.path.startswith("/scl/fi/") or parsed.path.startswith("/s/")):
        query = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True) if k not in ("dl", "raw")]
        query.append(("dl", "1"))
        return urllib.parse.urlunsplit((parsed.scheme, "dl.dropboxusercontent.com", parsed.path,
                                        urllib.parse.urlencode(query), parsed.fragment))
    return str(url)


def download(url, mirrored=True):
    """Contents of a URL as bytes (synchronous)."""
    global _download
    import js

    if _download is None:
        _download = js.eval(_JS_DOWNLOAD)
    copy = _mirrored(url) if mirrored else ""
    url = direct_download_url(url)
    if copy:
        try:
            return bytes(memoryview(_download(copy, "").to_py()))
        except Exception:
            # The copy is named in the map but is not there: ask where the file itself is.
            logger.debug("The copy of %s this site holds could not be read", url, exc_info=True)
    data = _download(str(url), _proxy_base())
    return bytes(memoryview(data.to_py()))


class DownloadRequired(Exception):
    """A file has to be fetched by the page before the code that wants it can go on.

    A download done here blocks everything: Python holds the one thread the page draws with, so a
    synchronous request leaves the window frozen with nothing to show for it, which is what a user
    sees as "nothing happens". Where something can run the call again - a widget's slot, see
    qtcompat.core - this is raised instead, the page fetches the file while it goes on drawing, and
    the call is made again with the file in place.
    """

    def __init__(self, url, path):
        super().__init__(f"{url} has not been downloaded yet")
        self.url = url
        self.path = path


#: Raised downloads are only useful where something will run the call again; qtcompat.core counts
#: the slot calls it drives, and only inside one is DownloadRequired worth raising.
retryable_calls = 0


def page_can_download():
    """Whether the page can fetch a file on its own (registered by the web application)."""
    try:
        import slicerweb_downloads  # noqa: F401
    except ImportError:
        return False
    return True


def download_in_page(url, path, onProgress=None, onDone=None, onFailed=None):
    """Ask the page to fetch *url* into *path*, reporting how far along it is. Returns at once."""
    import slicerweb_downloads

    from .qtcompat import dom

    proxies = [dom.proxy(onProgress or (lambda received, total: None)),
               dom.proxy(onDone or (lambda path: None)),
               dom.proxy(onFailed or (lambda message: None))]
    _page_downloads.append(proxies)   # kept alive until the download ends
    slicerweb_downloads.download(str(url), str(path), *proxies)


_page_downloads = []


def urlretrieve(url, filename=None, reporthook=None, data=None):
    """urllib.request.urlretrieve for the browser."""
    if (retryable_calls and filename and not os.path.exists(filename)
            and page_can_download() and not data):
        raise DownloadRequired(url, filename)
    logger.info("Downloading %s", url)
    content = download(str(url))
    if filename is None:
        import tempfile

        handle, filename = tempfile.mkstemp()
        os.close(handle)
    directory = os.path.dirname(filename)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(filename, "wb") as f:
        f.write(content)
    if reporthook:
        try:
            reporthook(1, len(content), len(content))
        except Exception:
            logger.debug("Download report hook failed", exc_info=True)
    return filename, {"Content-Length": str(len(content))}


def install():
    """Use the browser for urllib downloads (slicer.util.downloadFile, SampleData, module tests)."""
    urllib.request.urlretrieve = urlretrieve

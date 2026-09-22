"""Downloads for Python code that expects urllib (slicer.util.downloadFile, SampleData, tests).

Pyodide has no sockets, so urllib cannot open connections. Downloads are done by the browser with a
synchronous XMLHttpRequest, so that they can be used from synchronous Python code (module logic,
self tests). Hosts that do not allow cross-origin requests (e.g. GitHub release assets) cannot be
read by the page at all, so a file from one is looked for in two other places first: the copies the
site carries of the sample data (sample-data/mirror.json, written when the site is built), and the
application's download proxy where there is one (see web/vite.assets.ts; a site of static files,
such as the published one, has none).
"""

import logging
import os
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


def _has_proxy():
    """Whether this site fetches files of other sites for the page."""
    try:
        import slicerweb_downloads

        return bool(getattr(slicerweb_downloads, "proxy", True))
    except ImportError:
        return True


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


def download(url, mirrored=True):
    """Contents of a URL as bytes (synchronous)."""
    global _download
    import js

    if _download is None:
        _download = js.eval(_JS_DOWNLOAD)
    copy = _mirrored(url) if mirrored else ""
    if copy:
        try:
            return bytes(memoryview(_download(copy, "").to_py()))
        except Exception:
            # The copy is named in the map but is not there: ask where the file itself is.
            logger.debug("The copy of %s this site holds could not be read", url, exc_info=True)
    proxyBase = ""
    if _has_proxy():
        try:
            proxyBase = _site_base() + "download?url="
        except Exception:
            pass
    data = _download(str(url), proxyBase)
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

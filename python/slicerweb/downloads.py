"""Downloads for Python code that expects urllib (slicer.util.downloadFile, SampleData, tests).

Pyodide has no sockets, so urllib cannot open connections. Downloads are done by the browser with a
synchronous XMLHttpRequest, so that they can be used from synchronous Python code (module logic,
self tests). Hosts that do not allow cross-origin requests (e.g. GitHub release assets) are fetched
through the application's download proxy (see web/vite.assets.ts).
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
    return get(proxyBase + encodeURIComponent(url));  // other origin: download proxy
  }
})
"""

_download = None


def download(url):
    """Contents of a URL as bytes (synchronous)."""
    global _download
    import js

    if _download is None:
        _download = js.eval(_JS_DOWNLOAD)
    proxyBase = ""
    try:
        base = str(js.document.baseURI)
        proxyBase = base[: base.rfind("/") + 1] + "download?url="
    except Exception:
        pass
    data = _download(url, proxyBase)
    return bytes(memoryview(data.to_py()))


def urlretrieve(url, filename=None, reporthook=None, data=None):
    """urllib.request.urlretrieve for the browser."""
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

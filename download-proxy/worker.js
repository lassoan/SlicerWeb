/**
 * Download proxy of SlicerWeb: fetches a file of another site for the page.
 *
 * Most servers do not let another site read their files (they send no cross-origin headers), and a
 * site of static files - the application published on GitHub Pages - has nothing that could fetch
 * them instead. This Cloudflare Worker does what the development server's /download does
 * (web/vite.assets.ts): GET ?url=<address> answers with the file at that address, with the headers
 * that let the page read it. The application asks it only when it cannot read a file itself
 * (web/src/core/runtime.ts, python/slicerweb/downloads.py), so servers that allow cross-origin
 * requests never see it.
 *
 * Only pages of the sites in ALLOWED_ORIGINS may use it, so that it is not a free proxy for any
 * other site. It sends no cookies or credentials of the user (the browser does not give it any),
 * keeps nothing, and refuses files larger than MAX_BYTES.
 *
 * Settings (variables of the Worker, see scripts/publish_download_proxy.py):
 *   ALLOWED_ORIGINS  origins of the pages that may use it, separated by commas; pages served from
 *                    localhost or 127.0.0.1 (on any port) may always use it
 *   MAX_BYTES        largest file it passes on (default: 4 GB)
 */

const DEFAULT_MAX_BYTES = 4 * 1024 ** 3;

/** Headers of the answer of the other site that are passed on to the page. */
const PASSED_HEADERS = ["content-type", "content-disposition", "last-modified", "etag", "accept-ranges", "content-range"];

function allowedOrigin(origin, env) {
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
  return allowed.includes(url.origin);
}

function answer(status, text, origin) {
  const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin" };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return new Response(text, { status, headers });
}

export default {
  async fetch(request, env) {
    // A request of a page for another site carries the site the page is on (fetch and
    // XMLHttpRequest send it): one without it is not from a page of an allowed site.
    const origin = request.headers.get("Origin");
    if (!allowedOrigin(origin, env)) {
      return answer(403, "This download proxy serves only the pages of SlicerWeb.", null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, HEAD",
          "Access-Control-Allow-Headers": "Range",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return answer(405, "download: only GET and HEAD", origin);
    }

    const target = new URL(request.url).searchParams.get("url");
    let targetURL;
    try {
      targetURL = new URL(target ?? "");
    } catch {
      targetURL = null;
    }
    if (!targetURL || (targetURL.protocol !== "http:" && targetURL.protocol !== "https:")) {
      return answer(400, "download: url parameter is missing or not http(s)", origin);
    }

    const headers = { "User-Agent": "SlicerWeb download proxy" };
    const range = request.headers.get("Range");
    if (range) headers["Range"] = range;
    let response;
    try {
      response = await fetch(targetURL.href, { method: request.method, headers, redirect: "follow" });
    } catch (e) {
      return answer(502, `download failed: ${e}`, origin);
    }

    const maxBytes = Number(env.MAX_BYTES) || DEFAULT_MAX_BYTES;
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > maxBytes) {
      response.body?.cancel();
      return answer(413, `download: the file is ${size} bytes, larger than the ${maxBytes} bytes this proxy passes on`, origin);
    }

    const passed = new Headers();
    for (const name of PASSED_HEADERS) {
      const value = response.headers.get(name);
      if (value) passed.set(name, value);
    }
    // The Worker's fetch has already decompressed a compressed answer, so its Content-Length - the
    // compressed size - would be wrong for the body passed on: the size is given only where it holds.
    const sized = size > 0 && !response.headers.get("content-encoding");
    if (sized) passed.set("Content-Length", String(size));
    passed.set("Access-Control-Allow-Origin", origin);
    passed.set("Access-Control-Expose-Headers", "Content-Disposition, Content-Range, Accept-Ranges, ETag, Last-Modified");
    passed.set("Cache-Control", "no-store");
    passed.set("Vary", "Origin");
    // The body is passed on as it arrives: nothing is held here, whatever the size of the file. An
    // answer that did not say its size (or not the size of what is passed on) is cut off where it goes past the largest allowed.
    let body = response.body;
    if (body && !sized) {
      let received = 0;
      body = body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maxBytes) controller.error(new Error(`download: larger than ${maxBytes} bytes`));
          else controller.enqueue(chunk);
        },
      }));
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: passed });
  },
};

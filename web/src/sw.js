/* The service worker: what a start needs, kept in the browser so that a restart is quick and works
 * without a network.
 *
 * Everything a start fetches is immutable for a given build - the runtime, the wheels, the
 * application's own files, the packages from the Pyodide distribution - so it is served from the
 * cache once it has been seen, and the network is asked only for what is missing. The page itself
 * is the exception: it is asked of the network first, so that a new build is noticed, and taken
 * from the cache only when the network is not there.
 *
 * A wheel keeps its name from build to build, so the cache is named after the build (the stamp is
 * put in by the build, see vite.assets.ts) and a new build starts an empty one; the old caches go
 * when it takes over. The page reloads itself once when a new worker takes over mid-start, so that
 * nothing of the old build is used with the new one (see main.ts).
 */
const BUILD = "__BUILD__";
const CACHE = `slicerweb-${BUILD}`;
const BASE = new URL("./", self.registration.scope).href;
// Set once a page of a newer build has been seen: from then on this worker keeps nothing, and
// serves nothing it kept, until the new worker takes over.
let standingDown = false;

/** Whether this is something a start needs and that never changes within a build. */
function isImmutable(url) {
  if (url.origin === self.location.origin && url.href.startsWith(BASE)) {
    const path = url.href.slice(BASE.length);
    return /^(pyodide|wheels|extensions|sample-data|assets)\//.test(path) || /^[^/]+\.(png|css|js|mjs)$/.test(path);
  }
  return url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/pyodide/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("slicerweb-") && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

/**
 * Whether a file keeps its name from one publish to the next while its content changes. A wheel
 * does, and so does the index of wheels: fetched through the browser's own cache they can come
 * back as the previous publish's, so the first fetch of each for a build goes past that cache.
 */
function keepsItsName(url) {
  return /\.whl$/.test(url.pathname) || /\/(wheels|extensions)\/index\.json$/.test(url.pathname);
}

async function fromCacheFirst(request) {
  if (standingDown) return fetch(keepsItsName(new URL(request.url)) ? new Request(request, { cache: "reload" }) : request);
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(keepsItsName(new URL(request.url)) ? new Request(request, { cache: "reload" }) : request);
  if (response.ok || response.type === "opaque") cache.put(request, response.clone()).catch(() => {});
  return response;
}

/** The build a page belongs to, from the stamp the build put in it. */
function buildOf(html) {
  return /name="slicerweb-build" content="([^"]*)"/.exec(html)?.[1] ?? "";
}

async function fromNetworkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // A page of a newer build, served while this worker is still in charge: nothing this
      // worker has kept belongs with it, so the cache goes, and what the page asks for comes from
      // the network until the new worker takes over. (The new worker is installing meanwhile.)
      const html = await response.clone().text();
      if (buildOf(html) && buildOf(html) !== BUILD) {
        standingDown = true;
        await caches.delete(CACHE);
        return response;
      }
      cache.put(BASE, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    // Whatever the address asks for (?sample=..., say), the page is the same one.
    const cached = await cache.match(BASE, { ignoreSearch: true, ignoreVary: true });
    if (cached) return cached;
    throw error;
  }
}

/**
 * What the page loaded before this worker was in charge of it. The first start of all fetches
 * its files with no worker to see them, so once that start is done the page sends the list, and
 * what is not yet kept is fetched again - from the browser's own cache, mostly - and kept.
 */
self.addEventListener("message", (event) => {
  if (event.data?.type !== "keep" || !Array.isArray(event.data.urls) || standingDown) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const href of event.data.urls) {
      try {
        const url = new URL(href);
        const key = url.href === BASE || (url.origin === self.location.origin && url.pathname === new URL(BASE).pathname) ? BASE : url.href;
        if (!(isImmutable(url) || key === BASE)) continue;
        if (await cache.match(key, { ignoreVary: true })) continue;
        const response = await fetch(key);
        if (response.ok || response.type === "opaque") await cache.put(key, response);
      } catch {
        // not kept this time; the next start will ask again
      }
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (request.mode === "navigate" || (url.origin === self.location.origin && url.href === BASE)) {
    event.respondWith(fromNetworkFirst(request));
  } else if (isImmutable(url)) {
    event.respondWith(fromCacheFirst(request));
  }
});

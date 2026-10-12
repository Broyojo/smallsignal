// This worker owns only the static application shell. User Projects and
// browser recovery records are deliberately outside Cache Storage.
// Replaced by the Vite build with a digest of the emitted index.html. This
// changes when its content-hashed application asset graph changes, allowing
// activate() to remove the prior shell instead of retaining it indefinitely.
const CACHE = "icm-static-shell-__ICM_BUILD_ID__";

function scopeUrl() {
  return new URL(self.registration.scope);
}

function shellUrls() {
  const scope = scopeUrl();
  return [
    new URL("./", scope).toString(),
    new URL("manifest.webmanifest", scope).toString(),
    new URL("icon.svg?v=nmos-4", scope).toString(),
    new URL("icon-192.png?v=nmos-4", scope).toString(),
    new URL("icon-512.png?v=nmos-4", scope).toString(),
  ];
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(shellUrls())),
  );
  // Do not skipWaiting: a new shell must never take over an editor with
  // unsaved in-memory work. The browser activates it after the old client ends.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) => key.startsWith("icm-static-shell-") && key !== CACHE,
              )
              .map((key) => caches.delete(key)),
          ),
        ),
      // The browser requests a page while this worker starts, instead of
      // after (#1673). Without navigation preload, or when it cannot be
      // turned on, the fetch handler requests the page as before; activation
      // never fails for it.
      self.registration.navigationPreload?.enable().catch(() => undefined),
    ]),
  );
});

function isStaticAsset(request) {
  return (
    ["script", "style", "image", "font", "manifest"].includes(
      request.destination,
    ) ||
    // The PDF exporter reads the faces it embeds with fetch(), which has no
    // destination; a font file is the same asset either way.
    /\.(?:ttf|woff2?)$/u.test(new URL(request.url).pathname)
  );
}

function isSameOriginApi(request) {
  const requestUrl = new URL(request.url);
  const scope = scopeUrl();
  return (
    requestUrl.origin === scope.origin &&
    (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/"))
  );
}

/**
 * Whether a response is the kind of thing the request asked for.
 *
 * Asset names carry a content hash, so this cache is keyed on names that
 * promise never to change meaning — which makes a wrong answer permanent.
 * A single-page-application fallback answers a missing asset with the app
 * shell under `200 text/html`; caching that as a script would leave the name
 * broken for as long as the cache lives, long after the deploy that caused
 * it. Store only what matches.
 */
function servesWhatWasAsked(request, response) {
  if (
    (response.headers.get("cache-control") ?? "")
      .toLowerCase()
      .includes("no-store")
  ) {
    return false;
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!type) return true;
  if (request.destination === "script") return type.includes("javascript");
  if (request.destination === "style") return type.includes("css");
  return !type.includes("text/html");
}

function storeResponse(event, key, response) {
  // Clone before respondWith hands the original body to the browser.
  const copy = response.clone();
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.put(key, copy))
      .catch(() => {
        // Quota or storage failure must not break an otherwise valid response.
      }),
  );
}

// The page the browser already requested for a navigation, or, without
// navigation preload, a request made now.
async function navigationResponse(event) {
  return (await event.preloadResponse) ?? fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  if (event.request.mode === "navigate") {
    // A navigation to an API, such as signing in, stays uncached. Where the
    // browser preloads it, it is answered with that response so that the
    // request is not made twice.
    if (isSameOriginApi(event.request)) {
      if (event.preloadResponse) event.respondWith(navigationResponse(event));
      return;
    }
    // Navigation is network-first so a deployed build can replace index.html
    // and point at its fresh, content-hashed Vite assets. Offline falls back
    // only to the known shell, never to a Project or arbitrary cached request.
    event.respondWith(
      navigationResponse(event)
        .then((response) => {
          if (response.ok) {
            storeResponse(event, scopeUrl(), response);
          }
          return response;
        })
        .catch(() => caches.match(scopeUrl())),
    );
    return;
  }

  // APIs own their own HTTP caching policy. In particular, Gallery previews
  // use revisioned URLs; putting them in the build-scoped shell cache would
  // ignore that policy and keep an old or access-controlled image alive.
  if (isSameOriginApi(event.request)) return;

  // Only same-origin static assets are cached. This intentionally excludes
  // arbitrary GETs, imported files, Project downloads, and future APIs.
  if (
    isStaticAsset(event.request) &&
    new URL(event.request.url).origin === scopeUrl().origin
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok && servesWhatWasAsked(event.request, response)) {
            storeResponse(event, event.request, response);
          }
          return response;
        });
      }),
    );
  }
});

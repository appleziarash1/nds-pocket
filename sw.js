/* NDS Pocket service worker.
   Two jobs:
   1. Inject COOP/COEP so the page becomes cross-origin isolated. That is what
      unlocks SharedArrayBuffer and therefore the faster threaded DS cores.
      GitHub Pages cannot send these headers, so a service worker is required.
   2. Cache the app shell so the site opens offline. Emulator cores come from the
      CDN and are cached opportunistically as they are used. */

// Bump this whenever index.html, styles.css or app.js change. Shell assets are
// served cache-first, so without a bump a returning visitor gets the new HTML
// with the old scripts still cached.
const VERSION = "v7";
const SHELL = `ndspocket-shell-${VERSION}`;
const RUNTIME = `ndspocket-runtime-${VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// The EmulatorJS front end. The loader, its stylesheet and the minified bundle are
// injected as plain <script>/<link> tags with no crossorigin attribute, so the page
// fetches them without CORS and they must be cached the same way (opaque). Warming
// them means a cold offline start does not have to have played a game first.
const EJS_BASE = "https://cdn.emulatorjs.org/stable/data/";
const WARM_NO_CORS = [
  EJS_BASE + "loader.js",
  EJS_BASE + "emulator.min.css",
  EJS_BASE + "emulator.min.js",
];

// The default melonds core and the files the loader needs to launch it. These are
// read by `fetch`/`XHR`, which use CORS (the CDN allows it), so they are warmed with
// mode "cors": an opaque entry would be rejected when the core asks for a cors read.
// Other cores fill in on first use; between them these are what offline play needs.
const WARM_CORS = [
  EJS_BASE + "version.json",
  EJS_BASE + "extract7z.js",
  EJS_BASE + "cores/melonds.json",
  EJS_BASE + "cores/melonds-wasm.data",
  EJS_BASE + "localization/en-US.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .catch(() => { /* a missing optional asset shouldn't block install */ })
      .then(() => warmRuntime())
      .then(() => self.skipWaiting())
  );
});

// Best effort, and deliberately not awaited for install's success: a CDN hiccup must
// not stop the worker from activating. Each asset lands in the runtime cache under
// its URL, so the page's later request matches it.
function warmOne(cache, url, mode) {
  return fetch(url, { mode })
    .then((res) => { if (res) return cache.put(url, res.clone()); })
    .catch(() => { /* offline install: fill it on first use instead */ });
}

function warmRuntime() {
  return caches.open(RUNTIME).then((cache) =>
    Promise.all([
      ...WARM_NO_CORS.map((u) => warmOne(cache, u, "no-cors")),
      ...WARM_CORS.map((u) => warmOne(cache, u, "cors")),
    ])
  ).catch(() => {});
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

// Documents need COOP+COEP to become cross-origin isolated (which unlocks
// SharedArrayBuffer, and with it the threaded cores). Subresources only need
// CORP so the isolated document is allowed to load them.
const COI = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
const CORP = { "Cross-Origin-Resource-Policy": "cross-origin" };

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Navigations: network first so a fresh deploy shows up, shell cached as fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("./index.html", copy)).catch(() => {});
          return withHeaders(res, COI);
        })
        .catch(() => caches.match("./index.html").then((r) => (r ? withHeaders(r, COI) : Response.error())))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isCore = /(^|\/)data\/(cores|src|localization)\//.test(url.pathname) || url.hostname === "cdn.emulatorjs.org";

  if (!sameOrigin && !isCore) {
    event.respondWith(fetch(request));
    return;
  }

  // App shell: network first, like navigations. Cache-first would hand a returning
  // visitor the previous deploy's scripts alongside the new index.html, and a mix
  // like that throws when a script changed shape. The shell is a handful of tiny
  // files, so the round trip is not worth the risk.
  //
  // index.html requests these with a ?v= cache-busting query so that even a client
  // still controlled by an older worker fetches the new file — an older worker's
  // cache lookup keys on the full URL, so the query is what misses it. The offline
  // fallback therefore matches ignoring the query, or it would never hit.
  const isShell = sameOrigin && SHELL_ASSETS.some((u) => new URL(u, self.location.href).pathname === url.pathname);
  if (isShell) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => {});
          }
          return withHeaders(res, CORP);
        })
        .catch(() => caches.match(request, { ignoreSearch: true })
          .then((r) => (r ? withHeaders(r, CORP) : Response.error())))
    );
    return;
  }

  // Cache first, refresh in the background: cores are immutable per release, so a
  // stale-while-revalidate read is a good fit.
  //
  // The EmulatorJS loader, its stylesheet and the minified bundle are injected as
  // plain <script>/<link> tags with no crossorigin attribute, so the browser fetches
  // them without CORS and they arrive as opaque responses (status 0). Those bytes
  // cannot be read or re-wrapped here, but they can still be stored and handed back
  // to the same kind of tag, which is exactly what a cold offline start needs. An
  // earlier guard accepted only "basic"/"cors" and quietly dropped them, so the page
  // shell cached while the emulator itself did not.
  event.respondWith(
    Promise.resolve(caches.match(request)).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          const storable = res && (res.type === "opaque" || res.status === 200);
          const usable = res && (res.type === "opaque" || res.type === "basic" || res.type === "cors");
          if (storable && usable) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit || Response.error());

      const response = Promise.resolve(hit || network);
      // Only same-origin responses can be re-wrapped; an opaque one has no readable
      // body and would throw if passed to the Response constructor.
      return sameOrigin ? response.then((r) => withHeaders(r, CORP)) : response;
    })
  );
});

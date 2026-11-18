// Service worker: keeps a copy of the app's screens on the phone,
// so the app opens even with a bad connection and phones treat it as installable.
// Money data (/api/...) is never stored here; it always comes from the server.

const CACHE = "splitter-v1";
const SCREENS = [
  "/",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SCREENS);
    })
  );
  self.skipWaiting();
});

// Remove copies left by older versions
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) {
            return name !== CACHE;
          })
          .map(function (name) {
            return caches.delete(name);
          })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  const url = new URL(event.request.url);
  const isOurs = url.origin === self.location.origin;
  if (event.request.method !== "GET" || !isOurs || url.pathname.startsWith("/api/")) return;

  // Ask the network first so updates show at once; use the saved copy only when offline
  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put(event.request, copy);
          });
        }
        return response;
      })
      .catch(function () {
        return caches.match(event.request).then(function (saved) {
          // Group pages (/g/...) use the same screen as the home page
          return saved || caches.match("/");
        });
      })
  );
});

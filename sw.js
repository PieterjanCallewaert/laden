var CACHE = "laden-v3";
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Altijd eerst het netwerk; de cache dient enkel als reserve zonder verbinding.
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  var key = url.origin + url.pathname;
  e.respondWith(
    fetch(e.request).then(function (r) {
      if (r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
      return r;
    }).catch(function () { return caches.match(key); })
  );
});

// CFM Service Worker v202605182232
const CACHE_NAME = 'cfm-v202605182232';

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Przepuść Google Fonts bez cache (żeby zawsze działały)
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(fetch(e.request).catch(function() {
      return new Response('', {status: 503});
    }));
    return;
  }

  // Przepuść Apps Script / Google Sheets (API)
  if (url.includes('script.google.com') || url.includes('docs.google.com')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Dla plików aplikacji: sieć najpierw, cache jako backup
  e.respondWith(
    fetch(e.request).then(function(response) {
      var clone = response.clone();
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(e.request, clone);
      });
      return response;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});

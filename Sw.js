// CFM Service Worker v202605162146
// Wymusza odświeżenie cache przy każdej nowej wersji

const CACHE_NAME = 'cfm-cache-202605162146';

// Przy instalacji – usuń stary cache
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

// Przy aktywacji – usuń wszystkie stare cache
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

// Fetch – zawsze pobieraj świeży plik z sieci, cache tylko jako backup
self.addEventListener('fetch', function(e) {
  e.respondWith(
    fetch(e.request).then(function(response) {
      // Zapisz świeżą kopię w cache
      var clone = response.clone();
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(e.request, clone);
      });
      return response;
    }).catch(function() {
      // Brak sieci – użyj cache
      return caches.match(e.request);
    })
  );
});

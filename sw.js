// Service worker : l'app s'ouvre sans connexion.
// Quand tu modifies un fichier de l'app, change le numéro de version ci-dessous (v2 -> v3...).
var CACHE = 'qada-shell-v2';
var FONTS = 'qada-fonts-v1';
var SHELL = [
  './', './index.html', './app.js', './estimate.js', './config.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Chaque fichier est récupéré directement sur le réseau (jamais depuis un cache intermédiaire).
      return Promise.all(SHELL.map(function (u) {
        return fetch(new Request(u, { cache: 'reload' })).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      var fromV1 = keys.indexOf('qada-shell-v1') >= 0;
      return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== FONTS; }).map(function (k) { return caches.delete(k); }))
        .then(function () { return fromV1; });
    }).then(function (fromV1) {
      return self.clients.claim().then(function () {
        if (!fromV1) return;
        // Passage de la v1 à la v2, une seule fois : on recharge les pages ouvertes pour qu'elles
        // utilisent tout de suite le nouveau code (l'ancien ne connaît pas les nouveaux champs).
        return self.clients.matchAll({ type: 'window' }).then(function (cs) {
          cs.forEach(function (c) { try { c.navigate(c.url); } catch (x) {} });
        });
      });
    })
  );
});

// Réseau d'abord (toujours la dernière version quand on est en ligne), cache en secours hors ligne.
function networkFirst(req) {
  return caches.open(CACHE).then(function (cache) {
    return new Promise(function (resolve) {
      var done = false;
      var fallback = function () {
        return cache.match(req, { ignoreSearch: true }).then(function (hit) {
          return hit || (req.mode === 'navigate' ? cache.match('./index.html') : undefined);
        });
      };
      var timer = setTimeout(function () {
        fallback().then(function (hit) { if (hit && !done) { done = true; resolve(hit); } });
      }, 4000);
      fetch(req.url, { cache: 'no-cache' }).then(function (res) {
        clearTimeout(timer);
        if (res && res.ok) cache.put(req, res.clone());
        if (!done) { done = true; resolve(res); }
      }, function () {
        clearTimeout(timer);
        fallback().then(function (hit) { if (!done) { done = true; resolve(hit || Response.error()); } });
      });
    });
  });
}

function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(staleWhileRevalidate(req, FONTS));
  }
  // Tout le reste (Supabase compris) passe directement par le réseau, jamais mis en cache.
});

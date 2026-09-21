/* La Cuota — service worker: funciona sin conexión */
var CACHE = 'lacuota-v46';
var FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './logica.js',
  './nube.js',
  './vendor/jspdf.umd.min.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './recuperar.html'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      /* cache:'reload': la precarga IGNORA la caché HTTP del navegador.
         Sin esto, el teléfono puede guardar un index.html viejo junto a
         un app.js nuevo (mezcla de versiones) y la app no arranca. */
      return c.addAll(FILES.map(function(u){ return new Request(u, {cache:'reload'}); }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; })
        .map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

/* Tocar la notificación abre la app (como una notificación normal) */
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(function(list){
      for(var i=0;i<list.length;i++){
        if(list[i].url.indexOf(self.location.origin)===0) return list[i].focus();
      }
      return clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', function(e){
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  // La nube (Firebase) siempre va directo a la red: jamás se cachea,
  // si no el teléfono vería datos viejos aunque refresque.
  if (url.origin !== self.location.origin){ e.respondWith(fetch(e.request)); return; }
  // version.json jamás se cachea: es la que avisa que hay actualización.
  if (url.pathname.split('/').pop() === 'version.json'){ e.respondWith(fetch(e.request)); return; }
  e.respondWith(
    caches.match(e.request, {ignoreSearch: true}).then(function(hit){
      return hit || fetch(e.request).then(function(res){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
        return res;
      }).catch(function(){ return caches.match('./index.html'); });
    })
  );
});

/* La Cuota — service worker: funciona sin conexión */
var CACHE = 'lacuota-v69';

/* Archivos de la app: se re-cachean en cada versión (release.sh actualiza CACHE). */
var APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './logica.js',
  './nube.js',
  './manifest.json',
  './recuperar.html'
];

/* Archivos estáticos que no cambian entre versiones: se descargan una sola vez
   y persisten en VENDOR_CACHE aunque CACHE cambie. Actualizar este caché
   solo es necesario al cambiar alguno de estos archivos. */
var VENDOR_CACHE = 'lacuota-vendor';
var VENDOR_FILES = [
  './vendor/jspdf.umd.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    /* 1. Vendor: solo descarga los archivos que no estén ya en caché. */
    caches.open(VENDOR_CACHE).then(function(vc){
      return Promise.all(VENDOR_FILES.map(function(u){
        return vc.match(u).then(function(hit){
          if(hit) return;
          return vc.add(new Request(u, {cache:'reload'}));
        });
      }));
    }).then(function(){
      /* 2. App: siempre descarga los archivos de la versión nueva, ignorando
         la caché HTTP del navegador para evitar mezcla de versiones. */
      return caches.open(CACHE).then(function(c){
        return c.addAll(APP_FILES.map(function(u){
          return new Request(u, {cache:'reload'});
        }));
      });
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      /* Elimina cachés viejas de la app pero preserva el caché de vendor. */
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE && k !== VENDOR_CACHE; })
          .map(function(k){ return caches.delete(k); })
      );
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

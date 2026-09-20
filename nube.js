/* La Cuota — capa de nube sobre Google Realtime Database.
   REST (PUT/GET/DELETE) + EventSource para cambios en vivo, todo por el puerto 443.
   La app funciona 100% local sin base configurada: ningún código falla si la nube
   no responde. Cuando NUBE_DB_URL está vacío, todo es local. */
(function(){
'use strict';

// ============================================================
//  PEGA AQUÍ LA DIRECCIÓN DE TU BASE (la crea Deivy en Firebase)
//  Ejemplo: 'https://la-cuota-default-rtdb.firebaseio.com'
// ============================================================
var NUBE_DB_URL = 'https://la-cuota-default-rtdb.firebaseio.com';

function url(path){ return NUBE_DB_URL + '/lacuota/' + path + '.json'; }
function gidOk(gid){ return /^[A-Za-z0-9_-]{1,64}$/.test(String(gid||'')); }

var subs = {};

var Nube = {
  /** true cuando hay una base configurada y lista */
  lista: function(){ return !!NUBE_DB_URL; },

  /** Publica el estado completo del grupo (meta, miembros, pagos). */
  publicar: function(gid, estado){
    if(!NUBE_DB_URL || !gidOk(gid)) return Promise.resolve(false);
    return fetch(url('groups/' + encodeURIComponent(gid)), {
      method: 'PUT',
      body: JSON.stringify(estado)
    }).then(function(r){ return r.ok; }).catch(function(){ return false; });
  },

  /** Lee el estado del grupo una vez. Devuelve null si no existe o falla. */
  obtener: function(gid){
    if(!NUBE_DB_URL || !gidOk(gid)) return Promise.resolve(null);
    return fetch(url('groups/' + encodeURIComponent(gid)))
      .then(function(r){ return r.ok ? r.json() : null; })
      .catch(function(){ return null; });
  },

  /** Se suscribe a cambios del grupo. Devuelve función para cancelar. */
  suscribir: function(gid, alCambiar){
    if(!NUBE_DB_URL || !gidOk(gid)) return function(){};
    if(subs[gid]){ try{ subs[gid](); }catch(e){} }
    var es = null;
    try{ es = new EventSource(url('groups/' + encodeURIComponent(gid))); }
    catch(e){ return function(){}; }
    es.onmessage = function(ev){
      var data = null;
      try{ data = JSON.parse(ev.data); }catch(e){ return; }
      alCambiar(data);
    };
    es.onerror = function(){ /* reintenta solo en silencio */ };
    subs[gid] = function(){ try{ es.close(); }catch(e){} delete subs[gid]; };
    return subs[gid];
  },

  /** Borra los datos del grupo en la nube */
  borrar: function(gid){
    if(!NUBE_DB_URL || !gidOk(gid)) return Promise.resolve(false);
    return fetch(url('groups/' + encodeURIComponent(gid)), { method: 'DELETE' })
      .then(function(r){ return r.ok; }).catch(function(){ return false; });
  }
};

window.CuotaNube = Nube;
})();

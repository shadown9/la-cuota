/* La Cuota — capa de nube (preparada, no conectada todavía).
   Cuando Deivy configure la base Firebase propia de La Cuota, se implementa
   esta misma interfaz sobre Realtime Database. La app funciona 100% local
   sin ella: ningún código de la app falla si la nube no responde. */
(function(){
  'use strict';

  var Nube = {
    /** true cuando hay una base configurada y lista */
    lista: function(){ return false; },

    /** Publica el estado del grupo (para sincronizar entre teléfonos) */
    publicar: function(/* grupoId, estado */){ return Promise.resolve(false); },

    /** Se suscribe a cambios de un grupo. Devuelve función para cancelar. */
    suscribir: function(/* grupoId, alCambiar */){ return function(){}; },

    /** Borra los datos del grupo en la nube */
    borrar: function(/* grupoId */){ return Promise.resolve(false); }
  };

  window.CuotaNube = Nube;
})();

/* La Cuota — interfaz. Lógica pura en logica.js, nube en nube.js. */
(function(){
'use strict';
/* Sin splash web: el splash nativo de Android cubre el arranque con su
   propia animación de salida del sistema. El splash web agregaba una
   transición extra (blanco sobre blanco con corte duro al revelar el
   contenido) que se percibía como un golpe en la pantalla. Al quitarlo,
   el contenido ya está pintado cuando el sistema desvanece su splash. */
var L = window.CuotaLogica;

/* ---------- estado ---------- */
var KEY = 'lacuota_v1';
var S = load();

function load(){
  try{
    var raw = localStorage.getItem(KEY);
    if (raw){ var s = JSON.parse(raw); s.groups=s.groups||{}; s.members=s.members||{}; s.payments=s.payments||{};
      s.payTs=s.payTs||{}; s.delMembers=s.delMembers||{}; s.unpays=s.unpays||{}; s.ui=s.ui||{};
      s.googleOk=!!s.googleOk; s.googleSub=s.googleSub||''; s.googleTrialStart=s.googleTrialStart||0; s.expectNoSession=!!s.expectNoSession; s.payVia=s.payVia||''; return s; }
  }catch(e){}
  return {groups:{}, members:{}, payments:{}, payTs:{}, delMembers:{}, unpays:{}, onboarded:false, trialStart:0, payActive:false, payEmail:'', payVia:'', notifyPay:false, ui:{},
    /* Identidad: la prueba gratis exige una cuenta de Google verificada en
       el servidor (una cuenta = una prueba). */
    googleOk:false, googleSub:'', googleTrialStart:0};
}
function persist(){ try{ localStorage.setItem(KEY, JSON.stringify(S)); }catch(e){} }
function save(){ persist(); nubePushSoon(); }

/* ---------- NUBE ---------- */
var nubeT=null, nubeUnsub=null;
function nubeLista(){ return window.CuotaNube && CuotaNube.lista(); }
function nubePushSoon(){
  if(!nubeLista()) return;
  clearTimeout(nubeT);
  nubeT=setTimeout(nubePushAll, 2000);
}
var nubePushing=false;
function nubePushAll(){
  if(!nubeLista() || nubePushing) return;
  var gids=Object.keys(S.groups);
  if(!gids.length) return;
  nubePushing=true;
  // Subir fusionando: primero trae la nube, mezcla con lo local y sube
  // el resultado. Así un teléfono con datos viejos jamás borra lo nuevo.
  var chain=Promise.resolve();
  gids.forEach(function(gid){
    chain=chain.then(function(){
      var local=L.groupSnapshot(S, gid);
      return CuotaNube.obtener(gid).then(function(remote){
        var state=local;
        if(remote && remote.meta){
          var m=L.mergeGroup(local, remote);
          state=m.state;
          if(m.changed){ L.applySnapshot(S, gid, m.state); persist(); if(gid===curGid) renderGroup(); }
        }
        return CuotaNube.publicar(gid, state).then(function(subido){
          /* Los grupos siguen a la cuenta: registrar este grupo como propio
             (fire-and-forget, jamás bloquea la subida). */
          if(subido) reclamarGrupo(gid);
        });
      }).catch(function(){});
    });
  });
  /* v106: marca de última sincronización exitosa (migración a envoltura
     nativa: la app nueva usa lastSyncTs para saber qué tan frescos están
     los datos de la nube). */
  chain.then(function(){
    nubePushing=false;
    try{ localStorage.setItem('lacuota_lastSyncTs', String(Date.now())); }catch(e){}
  }, function(){ nubePushing=false; });
}
function nubePull(gid, done){
  if(!nubeLista()){ if(done)done(false); return; }
  CuotaNube.obtener(gid).then(function(remote){
    if(!remote || !remote.meta){ if(done)done(false); return; }
    var m=L.mergeGroup(L.groupSnapshot(S, gid), remote);
    if(m.changed){ L.applySnapshot(S, gid, m.state); save(); if(done)done(true); }
    else if(done)done(false);
  });
}
function nubeWatch(gid){
  nubeUnwatch();
  if(!nubeLista()) return;
  nubeUnsub=CuotaNube.suscribir(gid, function(){
    // La nube avisa que algo cambió: cancelar cualquier subida pendiente
    // (puede traer datos viejos) y traer todo para fusionar en silencio.
    clearTimeout(nubeT);
    nubePull(gid, function(changed){ if(changed && curGid===gid) renderGroup(); });
  });
}
function nubeUnwatch(){ if(nubeUnsub){ try{ nubeUnsub(); }catch(e){} nubeUnsub=null; } }

/* ---------- los grupos siguen a la cuenta ---------- */
/* Registra este grupo como propio en el servidor (fire-and-forget: jamás
   bloquea la interfaz; reintenta una vez en silencio si falla la red). */
function reclamarGrupo(gid){
  var sess = S.googleSess || '';
  if(!sess || !/^[A-Za-z0-9_-]{5,64}$/.test(gid || '')) return;
  var intento = 0;
  (function enviar(){
    intento++;
    fetch(PAY_VERIFY_URL + '/me/claim', {method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({sess: sess, gid: gid})})
      .then(function(r){ if(!r.ok && intento < 2) setTimeout(enviar, 5000); })
      .catch(function(){ if(intento < 2) setTimeout(enviar, 5000); });
  })();
}
/* Tras entrar sin grupos locales: pide al servidor la lista de grupos de
   esta cuenta y los trae de la nube uno por uno (reusa la recuperación). */
function traerGruposDeLaCuenta(cb){
  var sess = S.googleSess || '';
  function fin(){ if(cb) cb(); }
  if(!sess || !nubeLista()){ fin(); return; }
  fetch(PAY_VERIFY_URL + '/me/groups?sess=' + encodeURIComponent(sess))
    .then(function(r){ return r.json().then(function(d){ return {ok: r.ok, d: d}; }); })
    .then(function(x){
      var gids = (x.ok && x.d && x.d.ok && Array.isArray(x.d.gids)) ? x.d.gids : [];
      var i = 0;
      (function next(){
        if(i >= gids.length){ fin(); return; }
        var gid = gids[i++];
        if(!/^[A-Za-z0-9_-]{5,64}$/.test(gid)){ next(); return; }
        fetchGroupToLocal(gid, function(){ next(); });
      })();
    })
    .catch(function(){ fin(); });
}

/* ---------- utilidades ---------- */
function $(id){ return document.getElementById(id); }
/* on(): como addEventListener pero tolerante — si el HTML en caché es más
   viejo que el JS y el elemento no existe, se ignora en vez de tumbar
   la app entera con una pantalla en blanco. */
function on(id, ev, fn){ var el=$(id); if(el) el.addEventListener(ev, fn); return el; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function initials(name){ var p=String(name||'?').trim().split(/\s+/); return (p[0][0]+(p[1]?p[1][0]:'')).toUpperCase(); }

var toastT=null;
function toast(msg){
  var t=$('toast'); t.textContent=msg; t.hidden=false;
  clearTimeout(toastT); toastT=setTimeout(function(){ t.hidden=true; }, 2600);
}

/* ---------- NOTIFICACIONES CON EL LOGO DE LA APP ----------
   La app instalada pide ella misma el permiso y avisa con
   registration.showNotification: la notificación llega con el nombre
   y el logo de La Cuota, como una notificación normal del teléfono,
   no como un aviso genérico de Chrome. */
function notifLista(){ return ('Notification' in window) && ('serviceWorker' in navigator); }
function pedirPermisoNotif(cb){
  /* Llamar dentro del toque del usuario: la app pide el permiso ella misma. */
  try{
    if(!notifLista()){ if(cb)cb(false); return; }
    if(Notification.permission==='granted'){ if(cb)cb(true); return; }
    if(Notification.permission==='denied'){ if(cb)cb(false); return; }
    Notification.requestPermission().then(function(p){ if(cb)cb(p==='granted'); }).catch(function(){ if(cb)cb(false); });
  }catch(e){ if(cb)cb(false); }
}
function avisarConLogo(titulo, cuerpo){
  /* Aviso del sistema con el logo de La Cuota. Si no hay permiso o no se
     puede, quien llama ya mostró el toast dentro de la app. */
  try{
    if(!notifLista() || Notification.permission!=='granted') return;
    navigator.serviceWorker.ready.then(function(reg){
      reg.showNotification(titulo, {
        body: cuerpo,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: 'lacuota-aviso'
      });
    }).catch(function(){});
  }catch(e){}
}
window.__lacuotaNotif = { pedir: pedirPermisoNotif, avisar: avisarConLogo };

/* ---------- DEUDA ACUMULADA ---------- */
function periodKeyToDate(key){
  var k=String(key||'');
  try{
    if(k.charAt(0)==='d'||k.charAt(0)==='s'){
      var p=k.slice(1).split('-');
      return new Date(parseInt(p[0]),parseInt(p[1])-1,parseInt(p[2]));
    }
    var q=k.split('-');
    return new Date(parseInt(q[0]),parseInt(q[1])-1,1);
  }catch(e){ return null; }
}
function pastUnpaidCount(gid, memberId, curPeriodKey){
  var pays=S.payments[gid]||{};
  var mem=S.members[memberId];
  var joinedAt=mem?(mem.createdAt||0):0;
  var count=0;
  Object.keys(pays).forEach(function(key){
    if(key>=curPeriodKey) return;
    var pm=pays[key]||{};
    if(pm[memberId]) return;
    var anyPaid=false;
    Object.keys(pm).forEach(function(id){ if(pm[id]) anyPaid=true; });
    if(!anyPaid) return;
    if(joinedAt){
      var pd=periodKeyToDate(key);
      if(pd&&joinedAt>pd.getTime()) return;
    }
    count++;
  });
  return count;
}

/* Comparte con el menú del teléfono (WhatsApp, Telegram, etc.); si no se puede, copia. */
function shareText(txt, title, copyMsg){
  if (navigator.share){
    navigator.share({title:title||'La Cuota', text:txt}).catch(function(){});
  } else copyText(txt, copyMsg);
}
function shareLink(url, title, copyMsg){
  if (navigator.share){
    navigator.share({title:title||'La Cuota', url:url}).catch(function(){});
  } else copyText(url, copyMsg);
}
function copyText(txt, okMsg){
  function done(){ toast(okMsg || 'Copiado.'); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done, function(){ fallback(); });
  } else fallback();
  function fallback(){
    var ta=document.createElement('textarea');
    ta.value=txt; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); done(); }
    catch(e){ showTextSheet(txt); }
    document.body.removeChild(ta);
  }
}

/* ---------- identidad con Google: PKCE directo contra Google ----------
   v63: sin Firebase Auth. "Continuar con Google" navega esta misma ventana
   a Google (accounts.google.com) con un reto PKCE; Google devuelve un
   código de un solo uso en la dirección de la app (?code=...&state=...).
   La app se lo pasa al servidor, que lo canjea con Google, verifica el
   permiso y registra la prueba gratis de la cuenta (una cuenta = una
   prueba, para siempre). Como el permiso viaja en la dirección, en
   Android la app instalada lo recibe directo: sin pestañas en el medio,
   sin boletos, sin "vuelve a la app". El ID de cliente OAuth es público
   por diseño (viaja en la URL). Para que Google acepte el regreso, en la
   consola de Google (proyecto la-cuota → APIs y servicios →
   Credenciales → cliente web) tienen que estar registrados como URIs de
   redireccionamiento autorizados:
     https://lacuota.org/
     https://shadown9.github.io/la-cuota/ */
var GOOGLE_OAUTH_CLIENT_ID = '741417625058-oug08d9kbgtu1ma6ft6dninmdg7nk1ug.apps.googleusercontent.com';
function googleCodeUrl(){ return PAY_VERIFY_URL + '/google/code'; }
/* La dirección de regreso tiene que coincidir EXACTA con la registrada
   en la consola de Google (ellos exigen coincidencia exacta). */
function googleRedirectUri(){
  try{
    if(/shadown9\.github\.io$/i.test(location.hostname || ''))
      return 'https://shadown9.github.io/la-cuota/';
  }catch(e){}
  return 'https://lacuota.org/';
}
/* PKCE (RFC 7636): el secreto viaja como reto SHA-256 en la ida y como
   texto solo en el canje con el servidor; si alguien copia la URL de
   regreso, el código no le sirve sin el secreto. */
function b64urlBytes(bytes){
  var s = '';
  for(var i=0;i<bytes.length;i++) s += String.fromCharCode(bytes[i]);
  var b64 = '';
  try{
    if(typeof btoa !== 'undefined') b64 = btoa(s);
    else if(typeof Buffer !== 'undefined') b64 = Buffer.from(s, 'binary').toString('base64');
  }catch(e){}
  return b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function pkceRandom(nBytes){
  var b = new Uint8Array(nBytes);
  if(window.crypto && window.crypto.getRandomValues){
    window.crypto.getRandomValues(b);
  } else {
    throw new Error('crypto no disponible');
  }
  return b64urlBytes(b);
}
function pkceChallenge(verifier){
  try{
    var data = new TextEncoder().encode(verifier);
    return window.crypto.subtle.digest('SHA-256', data).then(function(h){
      return b64urlBytes(new Uint8Array(h));
    });
  }catch(e){ return Promise.reject(new Error('crypto')); }
}
/* Un toque: se guarda el secreto PKCE y se navega a Google en esta misma
   ventana. Al elegir la cuenta, Google regresa a la dirección de la app. */
function googleLogin(){
  var b = document.getElementById('verGoogle'); if(b) b.disabled = true;
  verStep('Abriendo Google\u2026');
  /* El usuario inicia sesi\u00f3n a prop\u00f3sito: borrar la marca de "no quiero
     sesi\u00f3n" que dej\u00f3 el cierre anterior, para que el c\u00f3digo se canjee al volver. */
  S.expectNoSession = false; save();
  var verifier = pkceRandom(64);
  var state = pkceRandom(32);
  try{
    localStorage.setItem('lacuota_pkce', JSON.stringify({v: verifier, s: state, ts: Date.now()}));
  }catch(e){}
  pkceChallenge(verifier).then(function(ch){
    var u = 'https://accounts.google.com/o/oauth2/v2/auth' +
      '?client_id=' + encodeURIComponent(GOOGLE_OAUTH_CLIENT_ID) +
      '&redirect_uri=' + encodeURIComponent(googleRedirectUri()) +
      '&response_type=code' +
      '&scope=' + encodeURIComponent('openid email') +
      '&code_challenge=' + encodeURIComponent(ch) +
      '&code_challenge_method=S256' +
      '&state=' + encodeURIComponent(state) +
      '&prompt=select_account';
    try{ location.href = u; }catch(e){}
    /* Si por alguna razón la navegación no se dio, la puerta queda lista
       de nuevo en vez de quedarse muerta. */
    setTimeout(function(){
      try{ if(b && document.getElementById('verGoogle')){ b.disabled = false; verStep(null); } }catch(e2){}
    }, 3000);
  }, function(){
    /* Sin criptografía no se puede armar el reto: la puerta queda lista,
       en silencio, para intentarlo de nuevo. */
    verStep(null);
    if(b) b.disabled = false;
  });
}

/* ---------- prueba gratis ---------- */
var TRIAL_DAYS = 30;
function trialDaysLeft(){
  if (!S.trialStart) return TRIAL_DAYS;
  /* Comparar por días de calendario, no por bloques de 24 h: así el día
     siguiente al inicio ya muestra 29 aunque hayan pasado solo unas horas. */
  var s = new Date(S.trialStart), t = new Date();
  var startMid = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  var todayMid = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  var used = Math.round((todayMid - startMid) / 86400000);
  return Math.max(0, TRIAL_DAYS - used);
}
function locked(){ return S.trialStart>0 && trialDaysLeft()<=0 && !S.payActive; }
/* Si el usuario ya tiene grupos pero no hay trialStart (recuperó sus datos
   con el enlace de tesorero o viene de una versión vieja), la prueba
   arranca desde su primer pago registrado — o desde hoy si no hay pagos.
   Sin esto, jamás vería el aviso de la prueba ni se le pediría pagar.
   La puerta de Google (needsVerify) se revisa antes: sin cuenta verificada
   no se arranca ninguna prueba nueva. */
function bootstrapTrial(){
  if(S.trialStart || !Object.keys(S.groups).length) return;
  if(!S.googleOk) return;
  var first = 0;
  Object.keys(S.payments || {}).forEach(function(gid){
    var per = S.payments[gid] || {};
    Object.keys(per).forEach(function(mes){
      var pm = per[mes] || {};
      Object.keys(pm).forEach(function(mid){
        var ts = pm[mid];
        if(ts && (!first || ts < first)) first = ts;
      });
    });
  });
  S.trialStart = S.googleTrialStart || first || Date.now();
  save();
}
/* La prueba solo corre si ya arrancó o si la cuenta está verificada.
   Devuelve false cuando hay que mostrar la pantalla de verificación. */
function ensureTrial(){
  if(S.trialStart) return true;
  if(S.googleOk){ S.trialStart = S.googleTrialStart || Date.now(); save(); return true; }
  return false;
}

/* ---------- verificación con Google ----------
   A dónde volver después de verificar (se fija antes de mostrarla). */
var verNext = null;
function showVerify(){
  verNext = verNext || null;
  /* Si la puerta se abrió desde un grupo (p. ej. al anotar un pago) y no hay
     un destino fijado, al terminar se vuelve a ese grupo en vez de a la
     página inicial. Se guarda en sessionStorage porque el redirect de Google
     navega fuera de la página y la memoria (verNext) se pierde al volver. */
  if(!verNext){
    try{
      var enGrupo = false;
      ['v-group','v-members','v-hist','v-pdetail'].forEach(function(v){
        var el = document.getElementById(v); if(el && !el.hidden) enGrupo = true;
      });
      if(enGrupo && typeof curGid!=='undefined' && curGid && S.groups && S.groups[curGid])
        sessionStorage.setItem('lacuota_verGid', curGid);
    }catch(e){}
  }
  var m = document.getElementById('verMsg');
  if(m){ m.hidden = true; m.textContent=''; }
  var b = document.getElementById('verGoogle');
  if(b) b.disabled = false;
  /* Versión visible en letra pequeña: si algo falla en un teléfono,
     con este número sabemos qué versión tiene instalada. */
  try{
    var vv = document.getElementById('verVer');
    if(vv) vv.textContent = 'v' + APP_V;
  }catch(e){}
  show('v-verify');
}
/* Línea pequeña bajo el botón que narra en qué paso va el regreso de
   Google. Solo se muestra mientras trabaja; si todo sale bien el usuario
   entra y no la ve. */
function verStep(t){
  var s = document.getElementById('verStep');
  if(!s) return;
  s.hidden = !t; s.textContent = t || '';
}
/* Envía el token de Google al servidor, que verifica la firma y dice si
   esta cuenta ya usó su prueba (una cuenta = una prueba, para siempre). */
/* ---------- v63: canje del código de Google ----------
   Google devolvió ?code=...&state=... en la dirección de la app. Se valida
   que el código sea de ESTA ventana (state + secreto PKCE guardados al
   tocar el botón) y se canjea con el servidor: el servidor lo cambia con
   Google por el permiso, verifica la firma y devuelve el estado de la
   prueba. Al terminar se cae directo en la página de grupos. */
var _codigosEnCurso = {};
function mostrarEntrando(){
  var b = document.getElementById('verGoogle'); if(b) b.hidden = true;
  var m = document.getElementById('verMsg'); if(m) m.hidden = true;
  var g = document.getElementById('verHecho'); if(g) g.hidden = true;
  show('v-verify');
  verStep('Entrando\u2026');
}
function sesionVerificadaEnDisco(){
  try{
    var s = JSON.parse(localStorage.getItem('lacuota_v1') || '{}');
    return !!(s && s.googleOk);
  }catch(e){ return false; }
}
function canjearCodigo(code, state){
  if(!code || _codigosEnCurso[code]) return;
  _codigosEnCurso[code] = true;
  function aLaPuerta(){
    delete _codigosEnCurso[code];
    verStep(null);
    showVerify();
  }
  /* Sin la marca de "yo pedí entrar con Google" (state + PKCE guardados
     al tocar el botón), este código no es de esta ventana: pudo canjearlo
     otra ventana del teléfono. Si la sesión ya quedó verificada en el
     disco, adentro. */
  var pkce = null;
  try{ pkce = JSON.parse(localStorage.getItem('lacuota_pkce') || 'null'); }catch(e){}
  var esMio = !!(pkce && pkce.v && pkce.s && pkce.s === state &&
                 (Date.now() - (pkce.ts || 0)) < 10*60*1000);
  /* Tras un "Cerrar sesión" explícito, jamás reutilizar un código viejo:
     el usuario pidió salir. */
  if(S.expectNoSession) esMio = false;
  if(!esMio){
    if(sesionVerificadaEnDisco()){
      delete _codigosEnCurso[code];
      try{ sessionStorage.removeItem('lacuota_code'); }catch(e2){}
      renderHome();
      return;
    }
    aLaPuerta(); return;
  }
  /* Candado: una sola ventana canjea el código (Google lo acepta una
     vez). Si otra ventana lo está canjeando ahora, se espera a que la
     sesión quede verificada, sin tocar el código. */
  var lock = null;
  try{ lock = JSON.parse(localStorage.getItem('lacuota_code_lock') || 'null'); }catch(e){}
  if(lock && lock.c === code && (Date.now() - (lock.ts || 0)) < 120000){
    delete _codigosEnCurso[code];
    esperarSesionVerificada();
    return;
  }
  try{ localStorage.setItem('lacuota_code_lock', JSON.stringify({c: code, ts: Date.now()})); }catch(e){}
  mostrarEntrando();
  fetch(googleCodeUrl(), {method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({code: code, verifier: pkce.v, redirectUri: googleRedirectUri()})})
    .then(function(r){ return r.json().then(function(d){ return {ok: r.ok, d: d}; }); })
    .then(function(x){
      delete _codigosEnCurso[code];
      if(x.ok && x.d && x.d.ok){
        try{
          localStorage.removeItem('lacuota_pkce');
          localStorage.removeItem('lacuota_code_lock');
          sessionStorage.removeItem('lacuota_code');
        }catch(e){}
        aplicarSesionGoogle(x.d);
        return;
      }
      if(x.d && x.d.reason === 'codigo_usado'){
        /* Google dice que el código ya se usó: lo más probable es que
           otra ventana de este teléfono lo haya canjeado. Se espera la
           sesión verificada en vez de mostrar un error. */
        esperarSesionVerificada();
        return;
      }
      aLaPuerta();
    })
    .catch(function(){ aLaPuerta(); });
}
/* La otra ventana canjeó el código: cuando la sesión quede verificada
   en el disco, se recarga y se entra directo. No hay espera eterna: a los
   ~10 segundos la puerta queda lista y silenciosa. */
function esperarSesionVerificada(){
  mostrarEntrando();
  var n = 0;
  var iv = setInterval(function(){
    n++;
    if(sesionVerificadaEnDisco()){
      clearInterval(iv);
      try{ location.reload(); }catch(e){}
      return;
    }
    if(n >= 10){ clearInterval(iv); verStep(null); showVerify(); }
  }, 1000);
}
function aplicarSesionGoogle(res){
  S.googleOk = true;
  S.googleSub = res.sub || '';
  /* Token de sesión opaco: los grupos siguen a la cuenta. Sirve para
     reclamar los grupos al subir y para traerlos solos al entrar. */
  S.googleSess = res.sess || '';
  S.expectNoSession = false;
  /* Almacenar la sesión nueva: si hay grupos locales sin reclamar,
     reclamarlos ahora (migración única). */
  try{
    if(S.googleSess && !localStorage.getItem('lacuota_claimedGroups') &&
       Object.keys(S.groups || {}).length){
      Object.keys(S.groups).forEach(function(gid){ reclamarGrupo(gid); });
      localStorage.setItem('lacuota_claimedGroups', '1');
    }
  }catch(e){}
  S.googleTrialStart = res.trialStart || Date.now();
  /* El servidor es la autoridad de la prueba: alinear la fecha local con
     la del servidor (nunca extiende la prueba en el reingreso). */
  S.trialStart = S.googleTrialStart;
  save();
  var sabeEstado = (res.trialActive === true) || (res.trialExpired === true);
  var pruebaActiva = sabeEstado ? res.trialActive : !res.trialUsed;
  verStep(null);
  if(pruebaActiva){
    toast(res.trialUsed ? 'Sesión verificada. Tu prueba sigue activa.'
                        : 'Prueba activada: 30 días gratis.');
    /* Al entrar con Google se cae directo en la página de grupos, nunca
       en la puerta de entrada. Si la puerta se abrió desde un grupo o
       desde un enlace, se vuelve ahí. */
    var gid = null, vh = null;
    try{
      gid = sessionStorage.getItem('lacuota_verGid'); sessionStorage.removeItem('lacuota_verGid');
      vh = sessionStorage.getItem('lacuota_verHash'); sessionStorage.removeItem('lacuota_verHash');
    }catch(e){}
    if(gid && S.groups && S.groups[gid]) openGroup(gid);
    else if(vh){ try{ if((location.hash||'')!==vh) location.hash = vh; }catch(e2){} route(); }
    else if(!Object.keys(S.groups || {}).length && S.googleSess){
      /* Entrada fresca sin grupos locales: los grupos siguen a la cuenta.
         Pedir la lista al servidor y traerlos de la nube solos. */
      traerGruposDeLaCuenta(function(){ renderHome(); });
    }
    else renderHome();
  }else{
    toast('Tu prueba gratis terminó. Activa tu suscripción para seguir.');
    renderPay();
  }
}

/* Cierra la sesión de Google y vuelve a mostrar la puerta: sirve para
   cambiar de cuenta. No toca los grupos, miembros ni pagos; al volver a
   entrar, el servidor realinea la prueba con la fecha original (nunca la
   extiende en el reingreso), así no se pierde ni se regala nada. */
function cerrarSesion(){
  /* v63: el permiso vive en Google, no en el teléfono; aquí no hay
     sesión que cerrar contra un servidor. Salir es limpiar la marca
     local: la próxima vez Google vuelve a mostrar el selector de
     cuenta, así que no hay auto-entrada silenciosa que apagar. */
  S.googleOk = false; S.googleSub = ''; S.googleSess = ''; S.expectNoSession = true; save();
  /* Cancelar la sincronización diferida con la nube: si llega mientras la
     pantalla de verificación está visible podría llamar renderGroup() y
     volver a meter al usuario dentro. */
  clearTimeout(nubeT); nubeT = null;
  nubeUnwatch();
  verNext = function(){ renderHome(); };
  showVerify();
}

/* ---------- navegación ---------- */
var VIEWS=['v-home','v-group','v-ob','v-members','v-hist','v-pdetail','v-settings','v-faq','v-pay','v-pagook','v-readonly','v-legal','v-verify'];
function show(id){
  /* Ocultar todas las vistas y revelar la pedida de inmediato.
     Sin splash web: el contenido aparece en cuanto está renderizado y el
     splash nativo de Android lo cubre con su animación de salida. */
  var visible=null;
  VIEWS.forEach(function(v){ var el=$(v); if(el && !el.hidden) visible=v; });
  VIEWS.forEach(function(v){ var el=$(v); if(el) el.hidden = true; });
  try{ var u=$('updating'); if(u) u.hidden=true; }catch(e){}
  /* Volver arriba solo al CAMBIAR de pantalla. Si la nube re-renderiza la
     vista actual (p. ej. el eco de un pago recién marcado llega 2-3 s
     después), se conserva la posición de scroll del usuario. */
  if(visible!==id) window.scrollTo(0,0);
  var cur=$(id); if(cur) cur.hidden=false;
}
/* Red de seguridad: si tras 4 segundos ninguna vista está visible
   (el arranque se atascó), forzar la pantalla inicial. */
setTimeout(function(){
  try{
    if(window.__lacuotaBooted) return;
    var anyVisible=false;
    VIEWS.forEach(function(v){ var el=document.getElementById(v); if(el && !el.hidden) anyVisible=true; });
    if(!anyVisible){
      var home=document.getElementById('v-home'); if(home) home.hidden=false;
    }
  }catch(e){}
}, 4000);
/* Pantalla neutra mientras se trae una versión nueva: no se usa la puerta
   (v-verify) para que al refrescar nunca parpadee el inicio de sesión. */
function mostrarActualizando(){
  try{ var u=$('updating'); if(u) u.hidden=false; }catch(e){}
  /* El guardián no debe interferir: la app está actualizando a propósito. */
  window.__lacuotaBooted = true;
}

/* ---------- hoja inferior ---------- */
function openSheet(html){
  $('sheet').innerHTML=html; $('sheetWrap').hidden=false;
}
function closeSheet(){ $('sheetWrap').hidden=true; $('sheet').innerHTML=''; }
on('sheetBack', 'click', closeSheet);

function showTextSheet(txt){
  openSheet('<h3>Cópialo aquí</h3>'+
    '<textarea id="sheetText" rows="8" style="width:100%;font-size:15px;padding:12px;border:1px solid #e9e9ec;border-radius:12px" readonly></textarea>'+
    '<button class="btn-primary btn-block" id="sheetCopy">Copiar</button>');
  $('sheetText').value=txt;
  on('sheetCopy', 'click', function(){
    $('sheetText').select();
    try{ document.execCommand('copy'); toast('Copiado.'); }catch(e){ toast('Selecciónalo y cópialo.'); }
    closeSheet();
  });
}

/* ---------- INICIO ---------- */
function renderHome(){
  nubeUnwatch();
  /* Construir TODO el contenido primero y revelar la vista al final:
     si show() va antes, las tarjetas aparecen una por una ante los ojos
     del usuario (parpadeo/golpe). Así la primera pantalla sale completa. */
  mostrarInstalar();
  var ids=Object.keys(S.groups);
  var list=$('groupList'); list.innerHTML='';
  $('homeEmpty').hidden = ids.length>0;

  var tb=$('trialBanner');
  if (S.trialStart && !S.payActive){
    var d=trialDaysLeft();
    tb.hidden=false;
    tb.innerHTML = d>0
      ? 'Te quedan <b>'+d+' días</b> de prueba gratis.'
      : '<b>Tu prueba terminó.</b> Activa tu suscripción para seguir anotando.';
    tb.style.cursor='pointer';
    tb.onclick=function(){ renderPay(); };
  } else tb.hidden=true;

  /* El botón dice lo que corresponde: suscribirse o administrar */
  var bm=$('btnManageSub');
  if(bm) bm.textContent = S.payActive ? 'Administrar suscripción' : 'Suscribirme';

  ids.forEach(function(gid){
    var g=S.groups[gid];
    var mk=L.periodKey(new Date(), g);
    var sum=sumFor(gid, mk);
    var b=document.createElement('button');
    b.className='gitem';
    var bg=L.barGrow(sum.countPaid, sum.countTotal);
    b.innerHTML='<span class="gdot">'+esc(initials(g.name))+'</span>'+
      '<span class="ginfo"><span class="gname">'+esc(g.name)+'</span>'+
      '<span class="gstat">'+sum.countPaid+' de '+sum.countTotal+' pagaron · '+
        (sum.missing>0 ? 'Faltan '+L.fmtMoney(sum.missing,g.currency) : 'Todos pagaron')+'</span>'+
      '<span class="gbar"><span class="gfill" style="flex-grow:'+bg.fill+'"></span><span class="grest" style="flex-grow:'+bg.rest+'"></span></span></span>'+
      '<span class="gchev">›</span>';
    b.addEventListener('click', function(){ openGroup(gid); });
    list.appendChild(b);
  });
  show('v-home');
}

function membersOf(gid){
  return Object.keys(S.members).map(function(k){ return S.members[k]; })
    .filter(function(m){ return m.gid===gid; })
    .sort(function(a,b){ return a.createdAt-b.createdAt; });
}
function paidMap(gid, month){ return (S.payments[gid]||{})[month]||{}; }
function sumFor(gid, month){
  var g=S.groups[gid];
  return L.monthSummary(g, membersOf(gid), paidMap(gid, month));
}

/* ---------- GRUPO ---------- */
var curGid=null, curMonth=null;

function openGroup(gid){
  var g=S.groups[gid]; if(!g){ renderHome(); return; }
  /* Registra la navegación al grupo en el historial del navegador para que
     el botón de retroceso del teléfono vuelva al inicio en vez de salir de la app. */
  if((location.hash||'') !== '#/g/'+gid) setHash('#/g/'+gid);
  curGid=gid;
  curMonth=S.ui['m_'+gid] || L.periodKey(new Date(), g);
  renderGroup();
  nubePull(gid, function(changed){ if(changed && curGid===gid) renderGroup(); });
  nubeWatch(gid);
}

function renderGroup(){
  var g=S.groups[curGid]; if(!g){ renderHome(); return; }
  show('v-group');
  $('gName').textContent=g.name;
  $('gMeta').textContent=L.fmtMoney(g.amount,g.currency)+' por miembro · '+L.freqLabel(g);
  renderMonth();
}

function renderMonth(){
  var g=S.groups[curGid];
  var mems=membersOf(curGid);
  var pays=S.payments[curGid]||{};
  $('mLabel').textContent=L.periodLabel(curMonth, g);
  var pm=paidMap(curGid, curMonth);
  var sum=L.monthSummary(g, mems, pm);
  $('tTotal').textContent=L.fmtMoney(sum.total,g.currency);
  $('tCollected').textContent=L.fmtMoney(sum.collected,g.currency);
  $('tMissing').textContent=L.fmtMoney(sum.missing,g.currency);
  $('tCount').textContent=sum.countPaid+'/'+sum.countTotal;

  var list=$('memberList'); list.innerHTML='';
  function rowEl(m, isPaid){
    var row=document.createElement('div');
    row.className='mrow'+(isPaid?' paid':'');
    var wa = (!isPaid && m.phone) ?
      '<button class="wabtn" data-wa="'+m.id+'" aria-label="Recordar por WhatsApp">💬</button>' : '';
    var statTxt;
    if(isPaid){
      statTxt='Pagó ✓';
    }else{
      var past=pastUnpaidCount(curGid, m.id, curMonth);
      if(past>0){
        var n=past+1;
        var freq=L.freqOf(g);
        var freqLabel=freq==='semana'?(n+' semanas'):freq==='dia'?(n+' días'):(n+' meses');
        statTxt='Debe '+L.fmtMoney(g.amount*n,g.currency)+' · '+freqLabel;
      }else{
        statTxt='Debe '+L.fmtMoney(g.amount,g.currency);
      }
    }
    row.innerHTML=
      '<button class="mmain" data-tg="'+m.id+'">'+
        '<span class="avatar">'+esc(initials(m.name))+'</span>'+
        '<span class="minfo"><span class="mname">'+esc(m.name)+'</span>'+
        '<span class="mstat'+(isPaid?' paid':'')+'">'+statTxt+'</span></span>'+
        '<span class="toggle">'+(isPaid?'✓':'')+'</span>'+
      '</button>'+wa;
    return row;
  }
  function sec(label){
    var d=document.createElement('div'); d.className='msec'; d.textContent=label; return d;
  }
  var owed=mems.filter(function(m){ return !pm[m.id]; });
  var paidM=mems.filter(function(m){ return !!pm[m.id]; });
  if(owed.length){
    list.appendChild(sec('Deben ('+owed.length+')'));
    owed.forEach(function(m){ list.appendChild(rowEl(m, false)); });
  }
  if(paidM.length){
    list.appendChild(sec('Pagaron ('+paidM.length+')'));
    paidM.forEach(function(m){ list.appendChild(rowEl(m, true)); });
  }

  list.querySelectorAll('[data-tg]').forEach(function(b){
    b.addEventListener('click', function(){ confirmPay(b.getAttribute('data-tg')); });
  });
  list.querySelectorAll('[data-wa]').forEach(function(b){
    b.addEventListener('click', function(e){ e.stopPropagation(); remindOne(b.getAttribute('data-wa')); });
  });
}

/* Confirmación antes de marcar/desmarcar un pago: un toque accidental no
   debe cambiar el estado sin que el tesorero lo note. */
function confirmPay(mid){
  if (locked()){ renderPay(); return; }
  var g=S.groups[curGid]; if(!g) return;
  var m=S.members[mid]; if(!m) return;
  var pm=((S.payments[curGid]||{})[curMonth])||{};
  var pagado=!!pm[mid];
  var monto=L.fmtMoney(g.amount,g.currency);
  openSheet('<h3>'+(pagado?'¿Quitar el pago?':'¿Confirmar pago?')+'</h3>'+
    '<p style="text-align:center;font-size:15px;color:#555;margin:4px 0 6px">'+(pagado
      ? 'Se quitará el pago de <b>'+esc(m.name)+'</b> en este período.'
      : 'Se marcará a <b>'+esc(m.name)+'</b> como que pagó <b>'+monto+'</b> en este período.')+'</p>'+
    '<button class="btn-primary btn-block" id="cfPayOk">'+(pagado?'Sí, quitar el pago':'Sí, pagó')+'</button>'+
    '<button class="btn-ghost btn-block" id="cfPayNo">Cancelar</button>');
  on('cfPayOk','click',function(){ closeSheet(); togglePay(mid); });
  on('cfPayNo','click',closeSheet);
}

function togglePay(mid){
  if (locked()){ renderPay(); return; }
  var g=S.groups[curGid];
  S.payments[curGid]=S.payments[curGid]||{};
  S.payments[curGid][curMonth]=S.payments[curGid][curMonth]||{};
  var p=S.payments[curGid][curMonth];
  S.unpays[curGid]=S.unpays[curGid]||{};
  S.unpays[curGid][curMonth]=S.unpays[curGid][curMonth]||{};
  if (p[mid]){ delete p[mid]; S.unpays[curGid][curMonth][mid]=Date.now(); }
  else{
    /* La prueba corre desde el primer pago, pero solo con cuenta verificada:
       sin eso, se muestra la pantalla de verificación y el pago no se anota. */
    if (!S.trialStart && !ensureTrial()){ verNext=null; showVerify(); return; }
    p[mid]=Date.now();
    delete S.unpays[curGid][curMonth][mid];
  }
  S.payTs[curGid]=S.payTs[curGid]||{};
  S.payTs[curGid][curMonth]=Date.now();
  save(); renderMonth();
}

function remindOne(mid){
  var g=S.groups[curGid], m=S.members[mid];
  if (!m || !m.phone){ toast('Agrega el teléfono de '+(m?m.name:'este miembro')+' en Miembros.'); return; }
  window.open(L.waLink(m.phone, L.reminderText(m, g, L.periodLabel(curMonth, g))), '_blank');
}

/* ---------- ONBOARDING ---------- */
var obDraft={name:'',amount:'',currency:'RD$',freq:'mes',cut:'5',cutWeekday:'0'};
var obSteps=[];
var WD_CORTOS=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
function startOnboarding(){
  obDraft={name:'',amount:'',currency:'RD$',freq:'mes',cut:'5',cutWeekday:'0'};
  obSteps=['nombre','monto','frecuencia'];
  obStep(0);
}
function paintSegF(id, val, attr){
  $(id).querySelectorAll('button').forEach(function(b){
    b.classList.toggle('on', b.getAttribute(attr)===String(val));
  });
}
function obStep(n){
  show('v-ob');
  /* Si ya tiene grupos (vino del inicio por error), puede volver atrás */
  var bk=$('obBack');
  if(bk) bk.hidden = !(S.groups && Object.keys(S.groups).length>0);
  var dots=$('obDots'); dots.innerHTML='';
  for(var i=0;i<obSteps.length;i++){ var s=document.createElement('span'); if(i===n)s.className='on'; dots.appendChild(s); }
  var step=obSteps[n], q=$('obQ'), f=$('obField'), nx=$('obNext');
  var last=(n===obSteps.length-1);
  $('obSkip').style.display = last ? 'none' : 'block';
  nx.textContent = (last && (step!=='frecuencia' || obDraft.freq==='dia')) ? 'Crear grupo' : 'Continuar';

  if(step==='nombre'){
    q.textContent='¿Cómo se llama tu grupo?';
    f.innerHTML='<input id="obIn" type="text" placeholder="Ej: Mi grupo de ahorro" maxlength="60" autocomplete="off">';
    $('obIn').value=obDraft.name;
    setTimeout(function(){ $('obIn').focus(); },50);
  }else if(step==='monto'){
    q.textContent='¿De cuánto es la cuota?';
    f.innerHTML='<div class="seg" id="obCur"><button data-cur="RD$">RD$</button><button data-cur="USD">US$</button></div>'+
      '<input id="obIn" type="number" min="1" inputmode="numeric" placeholder="500" style="margin-top:14px">';
    $('obIn').value=obDraft.amount;
    paintSeg('obCur', obDraft.currency);
    $('obCur').querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){ obDraft.currency=b.getAttribute('data-cur'); paintSeg('obCur', obDraft.currency); });
    });
    setTimeout(function(){ $('obIn').focus(); },50);
  }else if(step==='frecuencia'){
    q.textContent='¿Cada cuánto pagan la cuota?';
    f.innerHTML='<div class="seg" id="obFreq"><button data-f="dia">Diaria</button>'+
      '<button data-f="semana">Semanal</button><button data-f="mes">Mensual</button></div>';
    paintSegF('obFreq', obDraft.freq, 'data-f');
    $('obFreq').querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){
        obDraft.freq=b.getAttribute('data-f'); paintSegF('obFreq', obDraft.freq, 'data-f');
        nx.textContent = (obDraft.freq==='dia') ? 'Crear grupo' : 'Continuar';
      });
    });
  }else if(step==='diaSemana'){
    q.textContent='¿Qué día cierran la semana?';
    var h='<div class="seg7" id="obWd">';
    for(var i=0;i<7;i++) h+='<button data-w="'+i+'">'+WD_CORTOS[i]+'</button>';
    h+='</div><p class="fine">La semana se cuenta hasta ese día.</p>';
    f.innerHTML=h;
    paintSegF('obWd', obDraft.cutWeekday, 'data-w');
    $('obWd').querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){
        obDraft.cutWeekday=b.getAttribute('data-w'); paintSegF('obWd', obDraft.cutWeekday, 'data-w');
      });
    });
  }else{
    q.textContent='¿Qué día del mes cierran?';
    var dh='<div class="segDays" id="obDays">';
    for(var d=1;d<=28;d++) dh+='<button data-d="'+d+'">'+d+'</button>';
    dh+='</div><p class="fine">Toca el día. La cuota de cada mes se cuenta desde ese día.</p>';
    f.innerHTML=dh;
    paintSegF('obDays', obDraft.cut, 'data-d');
    $('obDays').querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){
        obDraft.cut=b.getAttribute('data-d'); paintSegF('obDays', obDraft.cut, 'data-d');
      });
    });
  }

  nx.onclick=function(){
    if(step==='nombre'){
      var v=$('obIn').value.trim();
      if(!v){ toast('Escribe el nombre del grupo.'); return; }
      obDraft.name=v; obStep(n+1);
    }else if(step==='monto'){
      var a=parseInt($('obIn').value,10);
      if(!a||a<=0){ toast('Escribe el monto de la cuota.'); return; }
      obDraft.amount=a; obStep(n+1);
    }else if(step==='frecuencia'){
      if(obDraft.freq==='dia'){ finishOnboarding(); return; }
      obSteps=['nombre','monto','frecuencia'].concat(
        obDraft.freq==='semana' ? ['diaSemana'] : ['diaMes']);
      obStep(n+1);
    }else{
      /* diaSemana y diaMes se eligen tocando: obDraft.cut/cutWeekday ya
         quedaron guardados al tocar. El día mensual siempre es válido
         (1-28, con 5 por defecto), no hay nada que validar. */
      finishOnboarding();
    }
  };
  var inp=$('obIn');
  if(inp) inp.addEventListener('keydown', function(e){ if(e.key==='Enter') nx.onclick(); });
  $('obSkip').onclick=function(){
    if(step==='frecuencia'){
      obSteps=['nombre','monto','frecuencia'].concat(
        obDraft.freq==='semana' ? ['diaSemana'] : obDraft.freq==='mes' ? ['diaMes'] : []);
    }
    if(n<obSteps.length-1) obStep(n+1);
  };
}
function paintSeg(id, cur){
  $(id).querySelectorAll('button').forEach(function(b){
    b.classList.toggle('on', b.getAttribute('data-cur')===cur);
  });
}
function finishOnboarding(){
  var g={ id:L.gidNuevo(), name:obDraft.name, amount:obDraft.amount,
          currency:obDraft.currency, freq:obDraft.freq,
          cutDay:parseInt(obDraft.cut,10)||5,
          cutWeekday:parseInt(obDraft.cutWeekday,10)||0,
          createdAt:Date.now(), updatedAt:Date.now() };
  S.groups[g.id]=g; S.onboarded=true; save();
  /* La prueba exige cuenta verificada: se pide aquí, con el grupo ya
     creado, antes de dejar anotar. Al terminar vuelve a este grupo. */
  if(L.needsVerify(S)){
    try{ sessionStorage.setItem('lacuota_verGid', g.id); }catch(e){}
    verNext=function(){ openGroup(g.id); setTimeout(openMembers, 600); };
    showVerify();
    return;
  }
  toast('Grupo creado. Agrega a los miembros y toca Terminar.');
  openGroup(g.id);
  setTimeout(openMembers, 600);
}

/* ---------- MIEMBROS ---------- */
function openMembers(){
  var g=S.groups[curGid]; if(!g) return;
  if((location.hash||'') !== '#/g/'+curGid+'/mem') setHash('#/g/'+curGid+'/mem');
  show('v-members'); renderMemList();
  $('memName').value=''; $('memPhone').value='';
  setTimeout(function(){ $('memName').focus(); },100);
}
function renderMemList(){
  var list=$('memList'); list.innerHTML='';
  membersOf(curGid).forEach(function(m){
    var row=document.createElement('div');
    row.className='mrow';
    row.innerHTML='<div class="mmain" style="cursor:default">'+
      '<span class="avatar">'+esc(initials(m.name))+'</span>'+
      '<span class="minfo"><span class="mname">'+esc(m.name)+'</span>'+
      '<span class="mstat">'+esc(m.phone||'Sin teléfono')+'</span></span></div>'+
      '<button class="wabtn" data-edit="'+m.id+'" aria-label="Editar">✏️</button>'+
      '<button class="wabtn" data-del="'+m.id+'" aria-label="Quitar">✕</button>';
    list.appendChild(row);
  });
  list.querySelectorAll('[data-edit]').forEach(function(b){
    b.addEventListener('click', function(){ editMember(b.getAttribute('data-edit')); });
  });
  list.querySelectorAll('[data-del]').forEach(function(b){
    b.addEventListener('click', function(){
      var m=S.members[b.getAttribute('data-del')];
      if(b.dataset.confirm==='1'){
        S.delMembers=S.delMembers||{}; S.delMembers[curGid]=S.delMembers[curGid]||{};
        S.delMembers[curGid][m.id]=Date.now();
        delete S.members[m.id]; save(); renderMemList(); toast(m.name+' eliminado.');
      }
      else{ b.dataset.confirm='1'; b.textContent='¿Sí?'; setTimeout(function(){ b.dataset.confirm=''; b.textContent='✕'; },2500); }
    });
  });
}
function addMember(){
  var name=$('memName').value.trim(), phone=$('memPhone').value.trim();
  if(!name){ toast('Escribe el nombre.'); return; }
  var m={id:L.uid(), gid:curGid, name:name, phone:L.normPhone(phone), createdAt:Date.now(), updatedAt:Date.now()};
  S.members[m.id]=m; save();
  $('memName').value=''; $('memPhone').value=''; $('memName').focus();
  renderMemList();
}
function editMember(id){
  var m=S.members[id]; if(!m) return;
  openSheet('<h3>Editar miembro</h3>'+
    '<input id="edName" type="text" maxlength="40" placeholder="Nombre" value="'+esc(m.name)+'">'+
    '<input id="edPhone" type="tel" maxlength="20" placeholder="Teléfono (con código país)" inputmode="tel" value="'+esc(m.phone||'')+'">'+
    '<button class="btn-primary btn-block" id="edSave">Guardar cambios</button>');
  on('edSave', 'click', function(){
    var n=$('edName').value.trim();
    if(!n){ toast('El nombre no puede quedar vacío.'); return; }
    m.name=n; m.phone=L.normPhone($('edPhone').value.trim()); m.updatedAt=Date.now();
    save(); closeSheet(); renderMemList(); toast('Cambios guardados.');
  });
}

/* ---------- HISTORIAL ---------- */
function openHistory(){
  if((location.hash||'') !== '#/g/'+curGid+'/hist') setHash('#/g/'+curGid+'/hist');
  show('v-hist');
  var g=S.groups[curGid]; if(!g) return;
  var pays=S.payments[curGid]||{};
  var mems=membersOf(curGid);
  var keys=Object.keys(pays).sort().reverse();
  var list=$('histList'); list.innerHTML='';
  if(!keys.length){ list.innerHTML='<div class="empty"><p>Todavía no hay períodos registrados.</p></div>'; return; }
  keys.forEach(function(k){
    var sum=L.monthSummary(g, mems, pays[k]||{});
    var b=document.createElement('button');
    b.className='hitem';
    b.innerHTML='<span class="hinfo"><span class="hlabel">'+esc(L.periodLabel(k, g))+'</span>'+
      '<span class="hstat">'+sum.countPaid+' de '+sum.countTotal+' pagaron · '+L.fmtMoney(sum.collected,g.currency)+'</span></span>'+
      '<span class="gchev">›</span>';
    b.addEventListener('click', function(){ openPeriodDetail(k); });
    list.appendChild(b);
  });
}

/* ---------- DETALLE DE PERÍODO ---------- */
function openPeriodDetail(k){
  var g=S.groups[curGid]; if(!g) return;
  if((location.hash||'') !== '#/g/'+curGid+'/pd/'+k) setHash('#/g/'+curGid+'/pd/'+k);
  var mems=membersOf(curGid);
  var pm=(S.payments[curGid]||{})[k]||{};
  var sum=L.monthSummary(g, mems, pm);
  show('v-pdetail');
  $('pdName').textContent=L.periodLabel(k, g);
  $('pdSub').textContent=g.name;
  $('pdTotal').textContent=L.fmtMoney(sum.total,g.currency);
  $('pdCollected').textContent=L.fmtMoney(sum.collected,g.currency);
  $('pdMissing').textContent=L.fmtMoney(sum.missing,g.currency);
  $('pdCount').textContent=sum.countPaid+'/'+sum.countTotal;
  function row(m, st){
    return '<div class="mrow"><div class="mmain" style="cursor:default">'+
      '<span class="avatar">'+esc(initials(m.name))+'</span>'+
      '<span class="minfo"><span class="mname">'+esc(m.name)+'</span>'+
      '<span class="mstat'+(st==='p'?' paid':'')+'">'+(st==='p'?'Pagó ✓':'Debe '+L.fmtMoney(g.amount,g.currency))+'</span></span></div></div>';
  }
  $('pdPaid').innerHTML=sum.paid.length?sum.paid.map(function(m){return row(m,'p');}).join(''):'<div class="empty"><p>Nadie pagó en este período.</p></div>';
  $('pdOwed').innerHTML=sum.owed.length?sum.owed.map(function(m){return row(m,'o');}).join(''):'<div class="empty"><p>Todos pagaron. 🎉</p></div>';
}

/* ---------- AJUSTES ---------- */
function openSettings(){
  var g=S.groups[curGid]; if(!g) return;
  if((location.hash||'') !== '#/g/'+curGid+'/set') setHash('#/g/'+curGid+'/set');
  show('v-settings');
  $('setName').value=g.name; $('setAmount').value=g.amount;
  paintSeg('setCurrency', g.currency);
  $('setCurrency').querySelectorAll('button').forEach(function(b){
    b.addEventListener('click', function(){ paintSeg('setCurrency', b.getAttribute('data-cur')); });
  });
  $('setFreqInfo').textContent='Frecuencia: '+L.freqLabel(g)+'. Se elige al crear el grupo.';
  renderAnchorSetting(g);
  var del=$('setDelete'); del.textContent='Eliminar grupo'; del.dataset.confirm='';
}
function renderAnchorSetting(g){
  var w=$('setAnchorWrap'), f=L.freqOf(g);
  if(f==='dia'){ w.innerHTML='<p class="fine">La cuota se cobra todos los días.</p>'; return; }
  if(f==='semana'){
    var wd=Math.min(Math.max(parseInt(g.cutWeekday,10)||0,0),6);
    var h='<label class="flabel">Día de cierre de la semana</label><div class="seg7" id="setWd">';
    for(var i=0;i<7;i++) h+='<button data-w="'+i+'" class="'+(i===wd?'on':'')+'">'+WD_CORTOS[i]+'</button>';
    w.innerHTML=h+'</div>';
    $('setWd').querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){
        $('setWd').querySelectorAll('button').forEach(function(x){ x.classList.remove('on'); });
        b.classList.add('on');
      });
    });
    return;
  }
  var cd=Math.min(Math.max(parseInt(g.cutDay,10)||5,1),28);
  var sh='<label class="flabel">Día de corte del mes</label><div class="segDays" id="setDays">';
  for(var sd=1;sd<=28;sd++) sh+='<button data-d="'+sd+'" class="'+(sd===cd?'on':'')+'">'+sd+'</button>';
  w.innerHTML=sh+'</div><p class="fine">Toca el día de corte.</p>';
  $('setDays').querySelectorAll('button').forEach(function(b){
    b.addEventListener('click', function(){
      $('setDays').querySelectorAll('button').forEach(function(x){ x.classList.remove('on'); });
      b.classList.add('on');
    });
  });
}
function saveSettings(){
  var g=S.groups[curGid]; if(!g) return;
  var f=L.freqOf(g);
  var name=$('setName').value.trim(), amount=parseInt($('setAmount').value,10);
  var curBtn=$('setCurrency').querySelector('button.on');
  if(!curBtn){ toast('Selecciona una moneda.'); return; }
  var cur=curBtn.getAttribute('data-cur');
  if(!name){ toast('El grupo necesita un nombre.'); return; }
  if(!amount||amount<=0){ toast('Revisa el monto.'); return; }
  if(f==='mes'){
    var onD=$('setDays') && $('setDays').querySelector('button.on');
    g.cutDay=onD?parseInt(onD.getAttribute('data-d'),10):(g.cutDay||5);
  }else if(f==='semana'){
    var on=$('setWd').querySelector('button.on');
    g.cutWeekday=on?parseInt(on.getAttribute('data-w'),10):0;
  }
  g.name=name; g.amount=amount; g.currency=cur; g.updatedAt=Date.now();
  S.ui['m_'+curGid]=L.periodKey(new Date(), g); curMonth=S.ui['m_'+curGid];
  save(); renderGroup(); toast('Guardado.');
}

/* ---------- FAQ ---------- */
var FAQS=[
  ['¿La Cuota guarda mi dinero?',
   'No. La Cuota solo anota quién pagó y quién debe. El dinero lo manejas tú como siempre.'],
  ['¿Funciona sin internet?',
   'Sí. Todo se guarda en tu teléfono y la aplicación abre aunque no tengas conexión.'],
  ['¿Cómo les recuerdo a los que deben?',
   'Con un toque, por WhatsApp. No necesitas otra aplicación ni pagar nada extra.'],
  ['¿Qué significan los dos enlaces para compartir?',
   'El enlace de miembros es para que vean quién va al día, sin poder cambiar nada. El de tesorero abre tu grupo en tu teléfono para seguir anotando.'],
  ['¿Qué pasa si cambio de teléfono?',
   'Usa el enlace de tesorero para abrir tu grupo en otro teléfono: los datos se sincronizan automáticamente a través de la nube.'],
  ['¿Se puede cobrar diario o semanal?',
   'Sí. Al crear el grupo eliges la frecuencia: diaria, semanal o mensual.'],
  ['¿Cuánto cuesta?',
   '30 días gratis por cuenta. Después US$4 al mes o US$40 al año, con grupos ilimitados. Tus datos nunca se borran.']
];
function renderFaq(from){
  if(from==='group' && (location.hash||'') !== '#/g/'+curGid+'/faq') setHash('#/g/'+curGid+'/faq');
  show('v-faq');
  var list=$('faqList'); list.innerHTML='';
  FAQS.forEach(function(f){
    var d=document.createElement('div'); d.className='fitem';
    d.innerHTML='<button class="fq"><span>'+esc(f[0])+'</span><span class="chev">›</span></button>'+
      '<div class="fa">'+esc(f[1])+'</div>';
    d.querySelector('.fq').addEventListener('click', function(){ d.classList.toggle('open'); });
    list.appendChild(d);
  });
  $('faqBack').onclick=function(){ history.back(); };
}

/* ---------- PAYWALL ---------- */
var STRIPE_LINKS = {
  monthly: 'https://buy.stripe.com/8x200c047gdA35q6nEbV602',
  yearly:  'https://buy.stripe.com/8x26oAg35bXkdK45jAbV603'
};
function renderPay(){
  var pt=$('payTitle');
  if(pt) pt.textContent = (S.trialStart && trialDaysLeft()>0 && !S.payActive) ? 'Suscríbete a La Cuota' : 'Tu prueba terminó';
  show('v-pay');
}
/* Antes de ir a Stripe: explicación clara del plan, sin sorpresas.
   El botón "Continuar al pago" sí va en el toque (gesto real). */
function planExplain(which){
  if(esAndroidTWA()){ planExplainPlay(which); return; }
  var anual = which === 'yearly';
  openSheet('<h3>Plan '+(anual?'Anual':'Mensual')+'</h3>'+
    '<p class="sub"><b>'+(anual?'$40 al año':'$4 al mes')+'</b> por tu cuenta · grupos ilimitados.</p>'+
    '<p class="sub">'+(anual
      ? 'Un solo pago de $40 que cubre 12 meses (el precio de 10). Se renueva cada año.'
      : 'Se cobran $4 cada mes. Se renueva automáticamente.')+'</p>'+
    '<p class="sub">Al continuar se abre <b>Stripe</b>, la plataforma de pagos segura. Arriba verás su dirección (buy.stripe.com): así confirmas que tu tarjeta está en buenas manos.</p>'+
    '<p class="sub">Cancela cuando quieras. Tus datos nunca se borran.</p>'+
    '<button class="btn-primary btn-block" id="planGoPay">Continuar al pago</button>'+
    '<button class="linkbtn" id="planBack">Atrás</button>');
  on('planBack', 'click', closeSheet);
  on('planGoPay', 'click', function(){ closeSheet(); payGo(which); });
}
/* En Android el pago es por Google Play: explicación sin mencionar ni
   enlazar ningún pago web (política de la tienda). */
function planExplainPlay(which){
  var anual = which === 'yearly';
  openSheet('<h3>Plan '+(anual?'Anual':'Mensual')+'</h3>'+
    '<p class="sub"><b>'+(anual?'$40 al año':'$4 al mes')+'</b> por tu cuenta · grupos ilimitados.</p>'+
    '<p class="sub">'+(anual
      ? 'Un solo pago de $40 que cubre 12 meses (el precio de 10). Se renueva cada año.'
      : 'Se cobran $4 cada mes. Se renueva automáticamente.')+'</p>'+
    '<p class="sub">El pago se hace con <b>Google Play</b>, seguro y sin salir de la aplicación.</p>'+
    '<p class="sub">Cancela cuando quieras desde tus suscripciones de Google Play. Tus datos nunca se borran.</p>'+
    '<button class="btn-primary btn-block" id="planGoPay">Continuar al pago</button>'+
    '<button class="linkbtn" id="planBack">Atrás</button>');
  on('planBack', 'click', closeSheet);
  on('planGoPay', 'click', function(){ closeSheet(); comprarPlay(which); });
}
/* Abre el enlace de pago real de Stripe (modo live) */
function payGo(which){
  if(esAndroidTWA()){ comprarPlay(which); return; }
  S.pendingPlan = which; save();
  window.open(STRIPE_LINKS[which], '_blank');
}
/* Suscripción: si ya paga, abre el portal; si no, lleva a la página para
   suscribirse (pedirle el correo a quien nunca pagó no tiene sentido). */
function manageSub(){
  if(esAndroidTWA()){ manageSubPlay(); return; }
  if(!S.payActive){ renderPay(); return; }
  var email = (S.payEmail || '').trim();
  if(email){ openPortal(email); return; } /* un toque: ya conocemos el correo */
  subEmailAsk(); /* pagó en otro teléfono: el correo se pide una sola vez */
}
/* Pide el correo UNA sola vez en una pantalla de La Cuota (nada de globo
   negro del sistema) y lo guarda: la próxima vez entra directo. */
function subEmailAsk(){
  openSheet('<h3>Administrar suscripción</h3>'+
    '<p class="sub">Escribe el correo con el que pagaste. Lo guardamos para que la próxima vez entres directo, sin escribirlo.</p>'+
    '<input type="email" id="subEmail" placeholder="tu@correo.com" inputmode="email" autocomplete="email">'+
    '<button class="btn-primary btn-block" id="subEmailGo">Continuar</button>');
  var inp = $('subEmail');
  if(inp) inp.focus();
  on('subEmailGo', 'click', subEmailGo);
}
function subEmailGo(){
  var em = (($('subEmail')||{}).value || '').trim();
  if(!em || em.indexOf('@') < 0){ toast('Escribe un correo válido.'); return; }
  S.payEmail = em; save();
  closeSheet();
  openPortal(em);
}
/* Abre el portal de Stripe para el correo dado.
   Primero se pide la URL al servidor y SOLO si llega una válida se abre
   la pestaña: jamás queda una página negra vacía (about:blank) abierta. */
function openPortal(email){
  toast('Abriendo tu suscripción…');
  fetch(PAY_VERIFY_URL + '/portal?email=' + encodeURIComponent(email), {cache:'no-store'})
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(res && res.url){
        abrirUrlSegura(res.url, 'Administrar suscripción', 'Tu portal de Stripe está listo. Toca para abrirlo.');
      }
      else if(res && res.error === 'not_found'){
        toast('No encontramos una suscripción con ese correo.');
      }else{
        toast('No se pudo abrir. Inténtalo de nuevo.');
      }
    })
    .catch(function(){ toast('Sin conexión. Conéctate a internet e inténtalo de nuevo.'); });
}
/* Abre una URL en pestaña nueva. Si el bloqueador del teléfono la cancela
   (ya no hay gesto directo), se muestra un botón de La Cuota: al tocarlo
   sí hay gesto y abre sin problema. Nunca se abre una pestaña vacía. */
function abrirUrlSegura(url, titulo, texto){
  var w = null;
  try{ w = window.open(url, '_blank'); }catch(e){ w = null; }
  if(w) return;
  openSheet('<h3>'+esc(titulo)+'</h3>'+
    '<p class="sub">'+esc(texto)+'</p>'+
    '<button class="btn-primary btn-block" id="urlGo">Abrir ahora</button>');
  on('urlGo', 'click', function(){ reintentarAbrir(url); });
}
function reintentarAbrir(url){
  closeSheet();
  try{ window.open(url, '_blank'); }catch(e){}
}
/* Gancho para pruebas: solo disponible en entorno local */
if(location.hostname === 'localhost' || location.hostname === '127.0.0.1'){
window.__lacuotaSub = {
  manage: function(){ manageSub(); },
  go: function(){ subEmailGo(); },
  getEmail: function(){ return S.payEmail; },
  setEmail: function(e){ S.payEmail = e; },
  pago: function(a){ S.payActive = !!a; },
  plan: function(w){ planExplain(w); },
  trial: function(){ return S.trialStart; },
  recover: function(gid, cb){ fetchGroupToLocal(gid, cb); },
  /* Pruebas: simula abrir un enlace interno (#/g/...) como lo haría el usuario */
  enlace: function(h){ try{ location.hash = h; }catch(e){} route(); },
  abrir: function(u){ abrirUrlSegura(u, 'Prueba', 'Toca para abrir.'); },
  reintentar: function(u){ reintentarAbrir(u); },
  /* Verificación con Google (una prueba por cuenta) */
  verificar: function(){ verNext=null; showVerify(); },
  necesitaVerificar: function(){ return L.needsVerify(S); },
  cuenta: function(){ return {googleOk:!!S.googleOk, trialStart:S.trialStart||0, expectNoSession:!!S.expectNoSession}; },
  /* v63 (pruebas): entrada con Google por PKCE directo */
  entrar: function(){ googleLogin(); },
  reto: function(v){ return pkceChallenge(v); },
  canjearCodigo: function(c, s){ canjearCodigo(c, s); },
  urlRegreso: function(){ return googleRedirectUri(); },
};
}
/* ---------- PAGOS VERIFICADOS (Worker + Stripe) ---------- */
var PAY_VERIFY_URL = 'https://lacuota-pagos.deivyespinosa07.workers.dev';
function payCheck(email){
  return fetch(PAY_VERIFY_URL + '/sub?email=' + encodeURIComponent(email), {cache:'no-store'})
    .then(function(r){ return r.json(); })
    .catch(function(){ return {active:false, offline:true}; });
}
/* ---------- PAGOS GOOGLE PLAY (solo la app instalada de Android) ----------
   La Digital Goods API solo existe dentro de la TWA instalada (el AAB se
   compiló con Play Billing activado). En la web se usa Stripe; dentro de
   Android ni se menciona ni se enlaza Stripe (política de la tienda). */
var PLAY_SKUS = ['lacuota_mensual', 'lacuota_anual'];
var PLAY_PKG = 'org.lacuota.app';
function esAndroidTWA(){ return (typeof window !== 'undefined' && typeof window.getDigitalGoodsService === 'function'); }
/* TWA de verdad (abierta desde la app instalada por la tienda) vs acceso
   directo de la página (PWA): solo la primera puede usar el pago de la tienda. */
function esTWAReal(){
  try{ return (document.referrer || '').indexOf('android-app://org.lacuota.app') === 0; }
  catch(e){ return false; }
}
var _dgSvc = null;
/* Serializa el error completo (nombre, mensaje, código, pila) para el
   diagnóstico en pantalla: la tienda a veces falla sin mensaje. */
function errDetalle(e){
  try{
    var d = (e && e.name ? e.name : '?') + '|' +
            (e && e.message ? e.message : '(sin mensaje)');
    d += '|' + (e && typeof e.code !== 'undefined' ? 'code='+e.code : 'nocode');
    var js = '';
    try{ js = JSON.stringify(e); }catch(x){}
    if(js && js !== '{}') d += '|' + js.slice(0,120);
    if(e && e.stack) d += '|' + String(e.stack).split('\n').slice(0,2).join(' ~ ').slice(0,160);
    return d;
  }catch(x){ try{ return String(e).slice(0,160); }catch(y){ return '?'; } }
}
function dgService(){
  if(_dgSvc) return Promise.resolve({svc:_dgSvc});
  if(!esAndroidTWA()) return Promise.resolve({err:'sin-api'});
  return window.getDigitalGoodsService('https://play.google.com/billing')
    .then(function(s){
      if(!s) return {err:'tienda-nula'};
      _dgSvc = s; return {svc:s};
    })
    .catch(function(e){ return {err:'rechazo:'+errDetalle(e)}; });
}
/* Texto claro del porqué no se pudo abrir el pago de la tienda. */
function dgErrorTexto(err){
  if(err==='sin-api') return 'Este dispositivo no trae el servicio de pagos de la tienda.';
  if(err==='tienda-nula') return 'La tienda no entregó el servicio de pagos. Abre la tienda una vez y vuelve a intentar.';
  return 'La tienda no respondió ('+err+'). Vuelve a intentar.';
}
/* Reabre la explicación del plan con el error visible y botón de reintento. */
function planExplainPlayError(which, msg){
  var anual = which === 'yearly';
  openSheet('<h3>Plan '+(anual?'Anual':'Mensual')+'</h3>'+
    '<p class="sub"><b>'+(anual?'$40 al año':'$4 al mes')+'</b> por tu cuenta · grupos ilimitados.</p>'+
    '<p class="sub"><b>No se pudo abrir el pago:</b> '+esc(msg)+'</p>'+
    '<button class="btn-primary btn-block" id="planGoPay">Reintentar el pago</button>'+
    '<button class="linkbtn" id="planBack">Atrás</button>');
  on('planBack', 'click', closeSheet);
  on('planGoPay', 'click', function(){ closeSheet(); comprarPlay(which); });
}
function playVerificar(purchaseToken, productId){
  return fetch(PAY_VERIFY_URL + '/play-verify', {method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({purchaseToken:purchaseToken, productId:productId,
        googleSub:S.googleSub||''})})
    .then(function(r){ return r.json(); })
    .catch(function(){ return null; });
}
function playEstado(){
  if(!S.googleSub) return Promise.resolve(null);
  return fetch(PAY_VERIFY_URL + '/play-sub', {method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({googleSub:S.googleSub})})
    .then(function(r){ return r.json(); })
    .catch(function(){ return null; });
}
/* Compra un plan por Google Play. Solo se marca éxito cuando el servidor
   confirma la compra de verdad; si el usuario cierra la ventana, no pasa nada. */
function comprarPlay(which){
  if(!S.googleSub){ toast('Entra con tu cuenta primero.'); return; }
  toast('Abriendo el pago…');
  dgService().then(function(r){
    var svc = r && r.svc;
    if(!svc){
      /* Siempre se muestra el motivo crudo de la tienda: es el dato que
         distingue un acceso directo (unsupported context) de un problema
         real de la tienda en la TWA. El referrer no es 100% fiable en un
         arranque en frío, así que el aviso del acceso directo es solo
         una pista, nunca reemplaza el error real. */
      var msg = dgErrorTexto(r && r.err);
      if(!esTWAReal()){
        msg += ' Si abriste un acceso directo de la página en vez de la aplicación instalada desde la tienda, abre la de la tienda.';
      }
      planExplainPlayError(which, msg);
      return;
    }
    var sku = (which==='yearly') ? 'lacuota_anual' : 'lacuota_mensual';
    var precio = (which==='yearly') ? '40.00' : '4.00';
    var pr;
    try{
      pr = new PaymentRequest(
        [{supportedMethods:'https://play.google.com/billing', data:{sku:sku}}],
        {total:{label:'La Cuota', amount:{currency:'USD', value:precio}}});
    }catch(e){ planExplainPlayError(which, dgErrorTexto('pagoreq:'+errDetalle(e))); return; }
    pr.show().then(function(resp){
      var pt = resp.details && resp.details.purchaseToken;
      var comprado = (resp.details && resp.details.itemId) || sku;
      if(!pt){ resp.complete('fail'); toast('No se completó el pago.'); return; }
      playVerificar(pt, comprado).then(function(ver){
        if(ver && ver.ok && ver.active){
          S.payActive = true; S.payVia = 'play';
          S.payPlan = (ver.plan==='anual') ? 'yearly' : 'monthly';
          S.payAt = Date.now(); save();
          toast('Suscripción activada.');
          resp.complete('success').then(function(){ route(); });
        }else{
          resp.complete('fail');
          toast('No se pudo confirmar el pago. Si te cobraron, se reembolsa solo.');
        }
      });
    }).catch(function(){ /* el usuario cerró la ventana de pago: no es error */ });
  });
}
/* Al arrancar en Android: re-verifica las compras de Google Play en este
   teléfono (restaura y refresca renovaciones), el registro del servidor
   (compra hecha en otro teléfono) y Stripe (pagó en la web). Cualquiera
   activo desbloquea: es una sola cuenta con un único derecho de acceso.
   Sin conexión no se toca nada (nadie pierde acceso por estar offline). */
function playSyncAlArrancar(){
  var p1 = dgService().then(function(r){
    var svc = r && r.svc;
    if(!svc) return false;
    return svc.listPurchases().then(function(compras){
      var ps = (compras||[]).map(function(c){
        return playVerificar(c.purchaseToken, c.itemId)
          .then(function(v){ return !!(v && v.ok && v.active); })
          .catch(function(){ return false; });
      });
      return Promise.all(ps).then(function(rs){
        return rs.some(function(x){ return x; });
      });
    }).catch(function(){ return false; });
  }).catch(function(){ return false; });
  var p2 = playEstado().then(function(st){ return !!(st && st.active); })
    .catch(function(){ return false; });
  var p3 = S.payEmail
    ? payCheck(S.payEmail).then(function(r){
        return (r && !r.offline) ? !!r.active : 'offline';
      }).catch(function(){ return 'offline'; })
    : Promise.resolve(false);
  Promise.all([p1, p2, p3]).then(function(rs){
    var okPlay = rs[0] || rs[1], stStripe = rs[2];
    var antes = S.payActive;
    if(okPlay || stStripe === true){
      S.payActive = true; S.payVia = okPlay ? 'play' : 'stripe'; save();
      if(!antes) route();
    }else if(antes && (S.payVia === 'play' || stStripe === false)){
      /* Se cayó el acceso de Play, o Stripe dice que ya no está activa
         (con correo conocido): se desactiva sola. Sin conexión no se toca. */
      if(stStripe !== 'offline'){ S.payActive = false; S.payVia = ''; save(); route(); }
    }
  });
}
/* Las suscripciones de Google Play solo se administran en la tienda. */
/* "Tu plan": antes de mandar a la tienda, la app dice a qué plan está
   suscrito (lo pidió Deivy: si ya paga, debe verlo, no invitarlo a pagar
   de nuevo). */
function planEstadoSheet(){
  openSheet('<h3>Tu plan</h3>'+
    '<p class="sub" id="planEstadoTxt">Verificando tu suscripción…</p>'+
    '<div id="planEstadoBtns" hidden>'+
    '<button class="btn-primary btn-block" id="planAdmin">Administrar en Google Play</button>'+
    '<button class="btn-primary btn-block" id="planVerPlanes" hidden>Ver planes</button>'+
    '</div>'+
    '<button class="linkbtn" id="planCerrar">Cerrar</button>');
  on('planAdmin', 'click', function(){ closeSheet(); abrirSubsPlay(); });
  on('planVerPlanes', 'click', function(){ closeSheet(); renderPay(); });
  on('planCerrar', 'click', closeSheet);
  var mostrar = function(html, modo){
    var t = $('planEstadoTxt'); if(t) t.innerHTML = html;
    var b = $('planEstadoBtns'); if(b) b.hidden = false;
    var vp = $('planVerPlanes'); if(vp) vp.hidden = (modo !== 'sinplan');
    var pa = $('planAdmin'); if(pa) pa.hidden = (modo === 'sinplan');
  };
  playEstado().then(function(st){
    if(st && st.active){
      var anual = st.plan === 'anual';
      var hasta = '';
      if(st.until){
        var f = new Date(st.until);
        if(!isNaN(f)) hasta = ' Se renueva el ' +
          f.toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'}) + '.';
      }
      S.payPlan = anual ? 'yearly' : 'monthly'; save();
      mostrar('Estás suscrito al plan <b>'+(anual?'Anual':'Mensual')+'</b> ('+
        (anual?'$40 al año':'$4 al mes')+').'+hasta, 'conplan');
    }else if(st){
      mostrar('No tienes una suscripción activa de Google Play en esta cuenta.', 'sinplan');
    }else{
      mostrar('No se pudo verificar. Revisa tu conexión e inténtalo de nuevo.', 'error');
    }
  }).catch(function(){
    mostrar('No se pudo verificar. Revisa tu conexión e inténtalo de nuevo.', 'error');
  });
}
function abrirSubsPlay(){
  toast('Abriendo tus suscripciones…');
  try{ window.open('https://play.google.com/store/account/subscriptions?package=' + PLAY_PKG, '_blank'); }
  catch(e){ toast('Administra tu plan en la Play Store, en Suscripciones.'); }
}
function manageSubPlay(){
  if(S.payActive || S.googleSub){ planEstadoSheet(); return; }
  renderPay();
}
/* Stripe redirige aquí después del pago: #/pago-ok.
   Solo se activa si el verificador confirma un pago real. */
function pagoOk(){
  var plan = (S.pendingPlan==='yearly') ? 'yearly' : 'monthly';
  S.pendingPlan = null; save();
  setHash('');
  $('pagoOkForm').hidden = false;
  $('pagoOkDone').hidden = true;
  $('pagoOkErr').hidden = true;
  $('pagoOkEmail').value = S.payEmail || '';
  var btn = $('pagoOkVerify');
  btn.onclick = function(){
    var email = $('pagoOkEmail').value.trim();
    if(!email || email.indexOf('@')<0){
      $('pagoOkErr').hidden = false;
      $('pagoOkErr').textContent = 'Escribe un correo válido.';
      return;
    }
    btn.disabled = true; btn.textContent = 'Verificando…';
    payCheck(email).then(function(res){
      btn.disabled = false; btn.textContent = 'Verificar pago';
      if(res && res.active){
        S.payActive = true;
        S.payPlan = (res.plan==='anual') ? 'yearly' : (res.plan==='mensual' ? 'monthly' : plan);
        S.payEmail = email; S.payAt = Date.now(); save();
        $('pagoOkForm').hidden = true;
        $('pagoOkDone').hidden = false;
        $('pagoOkPlan').textContent = S.payPlan==='yearly'
          ? 'Plan anual activo — $40/año · grupos ilimitados.'
          : 'Plan mensual activo — $4/mes · grupos ilimitados.';
      }else{
        $('pagoOkErr').hidden = false;
        $('pagoOkErr').textContent = (res && res.offline)
          ? 'Sin conexión. Conéctate a internet e inténtalo de nuevo.'
          : 'No encontramos un pago activo con ese correo. Revisa que sea el mismo con el que pagaste en Stripe.';
      }
    });
  };
  show('v-pagook');
}
on('pagoOkGo', 'click', renderHome);

/* ---------- LEGAL (discreto: solo enlaces en el pie) ---------- */
var LEGAL = {
priv: {
  t: 'Política de privacidad',
  h: '<p class="date">Vigente desde el 20 de septiembre de 2026.</p>'+
  '<h3>Qué datos guardamos</h3>'+
  '<p>Los datos de tu grupo (nombre, miembros, montos y pagos) se guardan en tu teléfono. Son tuyos.</p>'+
  '<p>Si usas el enlace de tesorero para sincronizar entre teléfonos, esos datos se copian a nuestra base de datos en la nube, protegidos por una llave secreta que solo tú tienes. Sin esa llave, nadie puede leerlos.</p>'+
  '<p>Para verificar tu suscripción guardamos tu correo electrónico y el estado de tu pago. Los pagos los procesan Stripe (en la web) y Google Play (en la aplicación de Android) de forma segura: nosotros nunca vemos ni guardamos tu tarjeta.</p>'+
  '<h3>Lo que no hacemos</h3>'+
  '<p>No vendemos tus datos. No mostramos anuncios. No usamos rastreadores de terceros.</p>'+
  '<h3>Tus derechos</h3>'+
  '<p>Puedes borrar los datos de un grupo desde la app cuando quieras. Si quieres que borremos tu correo de nuestros registros, escríbenos a soporte@lacuota.org.</p>'+
  '<h3>Seguridad</h3>'+
  '<p>Tu enlace de tesorero es tu llave: quien lo tenga puede ver y editar tu grupo. Guárdalo como una contraseña y no lo compartas con quien no deba verlo.</p>'+
  '<h3>Cambios</h3>'+
  '<p>Si cambiamos esta política, lo avisaremos dentro de la app.</p>'
},
term: {
  t: 'Términos del servicio',
  h: '<p class="date">Vigente desde el 20 de septiembre de 2026.</p>'+
  '<h3>El servicio</h3>'+
  '<p>La Cuota es una aplicación para llevar las cuotas de dinero de tu grupo —familia, amigos, equipo— sin libreta.</p>'+
  '<h3>Precio</h3>'+
  '<p>30 días gratis por cuenta. Después: $4 USD al mes o $40 USD al año, con grupos ilimitados. Precios en dólares americanos.</p>'+
  '<h3>Pagos</h3>'+
  '<p>En la web los pagos los procesa Stripe; en la aplicación de Android los procesa Google Play. Al pagar también aceptas los términos del procesador del pago.</p>'+
  '<h3>Cancelación</h3>'+
  '<p>Puedes cancelar cuando quieras: en la web desde el enlace de tu recibo de Stripe, y en la aplicación de Android desde tus suscripciones de Google Play; o escribiéndonos a soporte@lacuota.org. Mantienes el acceso hasta que termine el período que ya pagaste. No hay reembolsos por períodos parciales.</p>'+
  '<h3>Tu responsabilidad</h3>'+
  '<p>El enlace de tesorero es tu llave de acceso y tu respaldo: guárdalo bien. Eres responsable de lo que se haga con tus enlaces.</p>'+
  '<h3>Disponibilidad</h3>'+
  '<p>Hacemos todo lo posible por mantener el servicio funcionando, pero no podemos garantizar que nunca falle. Tus datos principales viven en tu teléfono.</p>'+
  '<h3>Cambios</h3>'+
  '<p>Podemos actualizar estos términos; los cambios importantes se avisarán dentro de la app.</p>'+
  '<h3>Contacto y ley aplicable</h3>'+
  '<p>Escríbenos a soporte@lacuota.org. Estos términos se rigen por las leyes del estado de Nueva Jersey, EE.&nbsp;UU.</p>'
}};
function showLegal(which){
  var L = LEGAL[which] || LEGAL.priv;
  $('legalTitle').textContent = L.t;
  $('legalBody').innerHTML = L.h;
  show('v-legal');
}
on('legalBack', 'click', function(){
  if(history.length>1){ history.back(); } else { setHash(''); renderHome(); }
});

/* ---------- COMPARTIR ---------- */
function baseUrl(){
  return location.origin + location.pathname;
}
function shareSheet(){
  var g=S.groups[curGid];
  var mems=membersOf(curGid);
  var allPays=S.payments[curGid]||{};
  var snapPays={}; snapPays[curMonth]=allPays[curMonth]||{};
  var snap=L.encodeSnapshot({
    g:{id:g.id, name:g.name, amount:g.amount, currency:g.currency,
       freq:g.freq, cutDay:g.cutDay, cutWeekday:g.cutWeekday},
    members:mems.map(function(m){ return {id:m.id, name:m.name}; }),
    payments:snapPays, month:curMonth
  });
  var roLink=baseUrl()+'#/ver/'+snap;
  var edLink=baseUrl()+'#/g/'+g.id;
  openSheet('<h3>Compartir</h3>'+
    '<button class="sopt" id="shRo">👥&nbsp; Copiar enlace de miembros <span style="color:var(--muted);font-size:14px">(solo ven)</span></button>'+
    '<button class="sopt" id="shEd">🔑&nbsp; Copiar enlace de tesorero <span style="color:var(--muted);font-size:14px">(tu respaldo · guárdalo)</span></button>');
  on('shRo', 'click', function(){
    shareLink(roLink, 'La Cuota — enlace de miembros', 'Enlace copiado. Mándalo a tus miembros.');
    closeSheet();
  });
  on('shEd', 'click', function(){
    shareLink(edLink, 'La Cuota — enlace de tesorero', 'Enlace copiado. Guárdalo: con él recuperas tu grupo si cambias de teléfono o borras datos.');
    closeSheet();
  });
}

/* ---------- VISTA SOLO LECTURA ---------- */
function showReadonly(payload){
  var snap=L.decodeSnapshot(payload);
  show('v-readonly');
  if(!snap){
    $('roName').textContent='Enlace no válido';
    $('roMonth').textContent='Pide al tesorero que te comparta el enlace de nuevo.';
    $('roCollected').textContent='—'; $('roMissing').textContent='—'; $('roTotal').textContent='—';
    $('roPaid').innerHTML=''; $('roOwed').innerHTML='';
    return;
  }
  var g=snap.g, mk=snap.month;
  $('roName').textContent=g.name;
  $('roMonth').textContent=L.periodLabel(mk, g);
  var pm=(snap.payments||{})[mk]||{};
  var sum=L.monthSummary(g, snap.members||[], pm);
  $('roTotal').textContent=L.fmtMoney(sum.total,g.currency);
  $('roCollected').textContent=L.fmtMoney(sum.collected,g.currency);
  $('roMissing').textContent=L.fmtMoney(sum.missing,g.currency);
  function row(m, st){
    return '<div class="mrow"><div class="mmain" style="cursor:default">'+
      '<span class="avatar">'+esc(initials(m.name))+'</span>'+
      '<span class="minfo"><span class="mname">'+esc(m.name)+'</span>'+
      '<span class="mstat'+(st==='p'?' paid':'')+'">'+(st==='p'?'Pagó ✓':'Debe '+L.fmtMoney(g.amount,g.currency))+'</span></span></div></div>';
  }
  var paid=sum.paid, owed=sum.owed;
  $('roPaid').innerHTML = paid.length ? paid.map(function(m){return row(m,'p');}).join('') : '<div class="empty"><p>Nadie ha pagado todavía.</p></div>';
  $('roOwed').innerHTML = owed.length ? owed.map(function(m){return row(m,'o');}).join('') : '<div class="empty"><p>Todos están al día. 🎉</p></div>';
}

/* ---------- reporte PDF (vía impresión) ---------- */
function downloadPDF(){
  pedirPermisoNotif(); /* la app pide el permiso en el toque, si hace falta */
  var g=S.groups[curGid]; if(!g) return;
  if(!window.jspdf){ toast('No se pudo generar el PDF.'); return; }
  var mems=membersOf(curGid);
  var pm=paidMap(curGid, curMonth);
  var sum=sumFor(curGid, curMonth);
  var doc=new window.jspdf.jsPDF({unit:'mm',format:'a4'});
  var M=14;
  var COLS=[{t:'Miembro',w:80},{t:'Estado',w:28},{t:'Monto',w:32},{t:'Fecha de pago',w:42}];
  var y=0;
  function header(){
    y=18;
    doc.setTextColor(0,0,0);
    doc.setFont('helvetica','bold'); doc.setFontSize(18);
    doc.text(String(g.name).slice(0,60), M, y); y+=8;
    doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(110,110,110);
    doc.text(L.periodLabel(curMonth,g)+' · '+L.freqLabel(g)+' · '+L.fmtMoney(g.amount,g.currency)+' por miembro', M, y);
    doc.setTextColor(0,0,0); y+=10;
    doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setFillColor(235,235,235);
    // Primero todos los fondos: en el PDF el texto y el relleno comparten
    // el mismo color, así que los textos van después para no teñir los
    // rectángulos de negro.
    var x=M;
    COLS.forEach(function(c){ doc.rect(x, y-4.5, c.w, 7.5, 'FD'); x+=c.w; });
    x=M; doc.setTextColor(0,0,0);
    COLS.forEach(function(c){ doc.text(c.t, x+2, y); x+=c.w; });
    y+=6;
    doc.setFont('helvetica','normal');
  }
  header();
  doc.setFontSize(10);
  if(!mems.length){ doc.text('Sin miembros.', M, y+4); y+=8; }
  mems.forEach(function(m){
    if(y>272){ doc.addPage(); header(); doc.setFontSize(10); }
    var ts=pm[m.id];
    var cells=[m.name, ts?'Pagó':'Debe',
      ts?L.fmtMoney(g.amount,g.currency):'—',
      ts?new Date(ts).toLocaleDateString('es-DO'):'—'];
    var x=M;
    cells.forEach(function(txt,i){
      var w=COLS[i].w;
      doc.rect(x, y-4.5, w, 7.5);
      var t=doc.splitTextToSize(String(txt), w-4)[0]||'—';
      doc.text(t, x+2, y); x+=w;
    });
    y+=7.5;
  });
  y+=8;
  if(y>262){ doc.addPage(); y=18; }
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(0,0,0);
  doc.text('Recaudado: '+L.fmtMoney(sum.collected,g.currency)+' de '+L.fmtMoney(sum.total,g.currency), M, y); y+=7;
  doc.text('Faltan: '+L.fmtMoney(sum.missing,g.currency)+'  ·  '+sum.countPaid+' de '+sum.countTotal+' pagaron', M, y); y+=10;
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(130,130,130);
  doc.text('Organizado con La Cuota · '+new Date().toLocaleDateString('es-DO'), M, y);
  var fname=('LaCuota-'+g.name+'-'+curMonth).replace(/[^\w áéíóúñü-]+/gi,'').slice(0,60)+'.pdf';
  doc.save(fname);
  toast('PDF descargado.');
  avisarConLogo('La Cuota', 'Reporte en PDF listo: '+g.name+'.');
}

/* ---------- CSV ---------- */
function exportCSV(){
  pedirPermisoNotif(); /* la app pide el permiso en el toque, si hace falta */
  var g=S.groups[curGid]; if(!g) return;
  var csv=L.buildCSV(g, membersOf(curGid), S.payments[curGid]||{});
  var blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='lacuota_'+g.name.replace(/[^\wáéíóúñü-]+/gi,'_')+'.csv';
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },500);
  toast('Historial descargado.');
  avisarConLogo('La Cuota', 'Historial descargado: '+g.name+'.');
}

/* ---------- menú ••• ---------- */
function moreSheet(){
  openSheet('<h3>'+esc(S.groups[curGid].name)+'</h3>'+
    '<button class="sopt" id="moMem">👥&nbsp; Miembros</button>'+
    '<button class="sopt" id="moShare">🔗&nbsp; Compartir</button>'+
    '<button class="sopt" id="moHist">🕘&nbsp; Historial</button>'+
    '<button class="sopt" id="moPdf">📄&nbsp; Reporte en PDF</button>'+
    '<button class="sopt" id="moCsv">⬇&nbsp; Descargar historial (CSV)</button>'+
    '<button class="sopt" id="moSet">⚙️&nbsp; Ajustes del grupo</button>'+
    '<button class="sopt" id="moSub">💳&nbsp; Administrar suscripción</button>'+
    '<button class="sopt" id="moNotif">'+(S.notifyPay?'🔕&nbsp; Desactivar recordatorios':'🔔&nbsp; Recordatorios automáticos')+'</button>');
  on('moMem', 'click', function(){ closeSheet(); openMembers(); });
  on('moShare', 'click', function(){ closeSheet(); shareSheet(); });
  on('moHist', 'click', function(){ closeSheet(); openHistory(); });
  on('moPdf', 'click', function(){ closeSheet(); downloadPDF(); });
  on('moCsv', 'click', function(){ closeSheet(); exportCSV(); });
  on('moSet', 'click', function(){ closeSheet(); openSettings(); });
  on('moSub', 'click', function(){ closeSheet(); manageSub(); });
  on('moNotif', 'click', function(){
    if(S.notifyPay){
      S.notifyPay=false; save(); closeSheet();
      toast('Recordatorios desactivados.');
    }else if(!notifLista()){
      closeSheet();
      toast('Tu dispositivo no soporta notificaciones.');
    }else{
      pedirPermisoNotif(function(ok){
        closeSheet();
        if(ok){ S.notifyPay=true; save(); toast('Recordatorios activados.'); }
        else{ toast('Activa las notificaciones en los ajustes del teléfono.'); }
      });
    }
  });
}

/* ---------- eventos ---------- */
on('btnNewGroup', 'click', function(){ locked()?renderPay():startOnboarding(); });
on('btnFaqHome', 'click', function(){ renderFaq('home'); });
on('btnBack', 'click', renderHome);
on('btnMore', 'click', moreSheet);
on('mPrev', 'click', function(){ var g=S.groups[curGid]; curMonth=L.prevPeriod(curMonth, g); S.ui['m_'+curGid]=curMonth; save(); renderMonth(); });
on('mNext', 'click', function(){ var g=S.groups[curGid]; curMonth=L.nextPeriod(curMonth, g); S.ui['m_'+curGid]=curMonth; save(); renderMonth(); });

on('btnRemindAll', 'click', function(){
  var g=S.groups[curGid];
  var sum=sumFor(curGid, curMonth);
  if(!sum.owed.length){ toast('Todos están al día. 🎉'); return; }
  shareText(L.debtorsText(g, sum, L.periodLabel(curMonth, g)), g.name,
    'Texto copiado. Pégalo en tu grupo de WhatsApp.');
});
on('btnSummary', 'click', function(){
  var g=S.groups[curGid];
  var sum=sumFor(curGid, curMonth);
  shareText(L.summaryText(g, sum, L.periodLabel(curMonth, g)), g.name,
    'Resumen copiado. Compártelo donde quieras.');
});

on('memBack', 'click', function(){ history.back(); });
on('memAdd', 'click', addMember);
on('memDone', 'click', function(){ history.back(); });
on('histBack', 'click', function(){ history.back(); });
on('pdBack', 'click', function(){ history.back(); });
on('setBack', 'click', function(){ history.back(); });
on('setSave', 'click', saveSettings);
on('setManageSub', 'click', manageSub);
on('homeSignOut', 'click', cerrarSesion);
on('setDelete', 'click', function(){
  var b=$('setDelete'), g=S.groups[curGid];
  if(b.dataset.confirm==='1'){
    Object.keys(S.members).forEach(function(k){ if(S.members[k].gid===curGid) delete S.members[k]; });
    var delGid=curGid;
    delete S.payments[curGid]; delete S.payTs[curGid]; delete S.delMembers[curGid]; delete S.unpays[curGid]; delete S.groups[curGid]; save();
    if(nubeLista()) CuotaNube.borrar(delGid);
    renderHome(); toast('Grupo eliminado.');
  }else{ b.dataset.confirm='1'; b.textContent='Toca de nuevo para eliminar'; }
});
on('payMonthly', 'click', function(){ planExplain('monthly'); });
on('payYearly', 'click', function(){ planExplain('yearly'); });
on('payViewData', 'click', renderHome);
on('payManageSub', 'click', manageSub);
on('pagoOkManage', 'click', manageSub);
on('btnManageSub', 'click', manageSub);
on('roCta', 'click', function(){ setHash(''); locked()?renderPay():startOnboarding(); });
on('verGoogle', 'click', function(){
  googleLogin();
});
on('verRecover', 'click', recoverSheet);

/* Trae un grupo de la nube al teléfono (también sirve para recuperar
   un grupo después de borrar los datos del navegador) */
function fetchGroupToLocal(gid, cb){
  if(S.groups[gid]){ cb(true); return; }
  if(!nubeLista()){ cb(false); return; }
  CuotaNube.obtener(gid).then(function(remote){
    if(remote && remote.migratedTo){
      /* Enlace viejo: la nube dice dónde vive el grupo ahora */
      fetchGroupToLocal(remote.migratedTo, cb); return;
    }
    if(remote && remote.meta){
      L.applySnapshot(S, gid, remote); S.onboarded=true; save(); cb(true);
    }else cb(false);
  });
}

function recoverSheet(){
  openSheet('<h3>Recuperar grupo</h3>'+
    '<p class="fine">Pega el enlace de tesorero que guardaste y traemos tu grupo de vuelta de la nube.</p>'+
    '<input type="text" id="rcLink" placeholder="Pega aquí tu enlace" autocomplete="off" autocapitalize="off">'+
    '<button class="btn-primary btn-block" id="rcGo" style="margin-top:12px">Recuperar</button>');
  on('rcGo', 'click', function(){
    var raw=( $('rcLink').value||'').trim();
    var m=raw.match(/#\/g\/([A-Za-z0-9_-]+)/);
    var gid=m?m[1]:null;
    if(!gid && /^[A-Za-z0-9_-]{5,}$/.test(raw)) gid=raw;
    if(!gid){ toast('Ese enlace no parece válido.'); return; }
    if(!nubeLista()){ toast('Sin conexión. Revisa tu internet.'); return; }
    closeSheet(); toast('Buscando el grupo…');
    fetchGroupToLocal(gid, function(ok){
      if(ok){
        toast('Grupo recuperado. 🎉'); setHash('');
        /* Puerta de Google: recuperar en un teléfono/buscador nuevo no
           salta la verificación. La puerta del arranque ya pasó (aún no
           había grupos); se revisa aquí tras importar. */
        if(L.needsVerify(S)){
          verNext = function(){ openGroup(gid); };
          try{ sessionStorage.setItem('lacuota_verHash', '#/g/'+gid); }catch(e){}
          showVerify(); return;
        }
        renderHome();
      }
      else toast('No encontramos ese grupo. Revisa el enlace.');
    });
  });
}
on('obRecover', 'click', recoverSheet);
on('obBack', 'click', function(){ setHash(''); renderHome(); });
on('btnRecoverHome', 'click', recoverSheet);

/* ---------- arranque ---------- */
/* Los enlaces internos (#/terminos, #/privacidad) cambian el hash sin recargar.
   Este oyente hace que la app reaccione a esos cambios. setHash() se usa para
   los cambios programáticos donde la vista ya se maneja a mano, para que el
   oyente no la pise (ej. el formulario de confirmación de pago). */
var ignoreHash = false;
function setHash(h){ ignoreHash = true; location.hash = h; }
window.addEventListener('hashchange', function(){
  if(ignoreHash){ ignoreHash = false; return; }
  route();
});
/* Si Android restaura la página desde su caché (bfcache) y la pantalla de
   login quedó visible pero el usuario ya está autenticado, re-enrutar. */
window.addEventListener('pageshow', function(e){
  if(!e.persisted) return;
  try{
    if(!L.needsVerify(S) && !S.expectNoSession){
      var ver=$('v-verify'); if(ver && !ver.hidden){ verStep(null); route(); }
    }
  }catch(ex){}
});
/* Centinela: impide que el botón de atrás salga de la app desde el inicio.
   Cuando el usuario navega atrás hasta el hash vacío (#), se empuja una
   entrada nueva para que el siguiente atrás no cierre la sesión ni salga.
   hashchange no dispara entre dos entradas con el mismo hash, así que este
   listener es el único punto donde se puede interceptar ese caso. */
window.addEventListener('popstate', function(){
  var h=location.hash||'';
  if(!h || h==='#'){
    if(!L.needsVerify(S) && !S.expectNoSession){
      history.pushState(null,'','#');
      /* Si llegamos aquí sin que cambiara el hash (ambas entradas eran #),
         hashchange no disparará; renderHome() ya está visible pero se
         llama por si acaso para asegurar el estado correcto. */
      try{ var vv=$('v-home'); if(vv && vv.hidden) renderHome(); }catch(ex){}
    }
  }
});
function route(){
  var h=location.hash||'';
  if(h.indexOf('#/pago-ok')===0){ pagoOk(); return; }
  if(h==='#/privacidad'){ showLegal('priv'); return; }
  if(h==='#/terminos'){ showLegal('term'); return; }
  if(h.indexOf('#/ver/')===0){ showReadonly(h.slice(6)); return; }
  if(h.indexOf('#/g/')===0){
    var gpath=h.slice(4), gparts=gpath.split('/');
    var gid=gparts[0], subview=gparts[1], subkey=gparts[2];
    if(S.groups[gid]){
      if(subview){
        /* Sub-vista de un grupo: asegurar curGid y curMonth antes de renderizar. */
        if(curGid !== gid){
          curGid=gid;
          curMonth=S.ui['m_'+gid] || L.periodKey(new Date(), S.groups[gid]);
          nubeWatch(gid);
        }
        if(subview==='mem'){ openMembers(); return; }
        if(subview==='hist'){ openHistory(); return; }
        if(subview==='set'){ openSettings(); return; }
        if(subview==='faq'){ renderFaq('group'); return; }
        if(subview==='pd' && subkey){ openPeriodDetail(subkey); return; }
      }
      openGroup(gid); return;
    }
    if(nubeLista()){
      toast('Buscando el grupo…');
      CuotaNube.obtener(gid).then(function(remote){
        if(remote && remote.migratedTo){
          setHash('#/g/'+remote.migratedTo); route(); return;
        }
        if(remote && remote.meta){
          L.applySnapshot(S, gid, remote); S.onboarded=true;
          limpiarLegados(gid); save();
          /* Puerta de Google: abrir el enlace de tesorero en un
             teléfono/buscador nuevo no salta la verificación. Al arrancar
             aún no había grupos y la puerta pasó de largo; se revisa aquí
             tras importar, antes de entrar al grupo. */
          if(L.needsVerify(S)){
            verNext = function(){ openGroup(gid); };
            try{ sessionStorage.setItem('lacuota_verHash', '#/g/'+gid); }catch(e){}
            showVerify(); return;
          }
          openGroup(gid);
        }else{ toast('No se encontró ese grupo.'); renderHome(); }
      });
      return;
    }
  }
  if(!S.onboarded && Object.keys(S.groups).length===0){ startOnboarding(); return; }
  renderHome();
}
/* ---------- INSTALAR LA APP ----------
   Chrome ya no muestra su aviso automático de instalación como antes: ahora
   el "Instalar app" vive escondido en el menú del navegador y casi nadie lo
   ve. Por eso la app trae su propio banner: captura beforeinstallprompt y
   ofrece el botón Instalar. En iPhone no existe ese evento, así que se
   explica cómo hacerlo a mano desde Safari. */
var __instalarEvt=null;
function appInstalada(){
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
         window.navigator.standalone===true;
}
function esIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent||''); }
function instalarDismissed(){
  try{ return localStorage.getItem('lacuota_noinstalar')==='1'; }catch(e){ return false; }
}
function mostrarInstalar(){
  var b=$('installBanner'); if(!b) return;
  b.hidden = appInstalada() || (!__instalarEvt && !esIOS()) || instalarDismissed();
}
function instalarApp(){
  if(__instalarEvt){
    __instalarEvt.prompt();
    __instalarEvt.userChoice.then(function(){ __instalarEvt=null; mostrarInstalar(); }).catch(function(){});
    return;
  }
  if(esIOS()){
    openSheet('<h3>Instalar La Cuota</h3>'+
      '<p class="fine" style="text-align:left">En iPhone: toca <b>Compartir</b> en Safari y elige <b>"Añadir a pantalla de inicio"</b>. Así la abres como una app, sin el navegador.</p>'+
      '<button class="btn-primary btn-block" id="instOk">Entendido</button>');
    on('instOk','click',closeSheet);
  }
}
window.addEventListener('beforeinstallprompt', function(e){
  e.preventDefault(); __instalarEvt=e; mostrarInstalar();
});
window.addEventListener('appinstalled', function(){ __instalarEvt=null; mostrarInstalar(); });
on('installGo','click',instalarApp);
on('installNo','click',function(){
  try{ localStorage.setItem('lacuota_noinstalar','1'); }catch(e){}
  var b=$('installBanner'); if(b) b.hidden=true;
});
if('serviceWorker' in navigator){
  window.addEventListener('load', function(){
    /* updateViaCache:'none': el chequeo de actualización IGNORA la caché HTTP.
       Sin esto, GitHub Pages sirve sw.js con max-age=4h y el teléfono puede
       tardar horas en descubrir una versión nueva aunque la pida. */
    navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).catch(function(){});
  });
}
/* ---------- RECORDATORIOS AUTOMÁTICOS ---------- */
function daysUntilPeriodClose(key, g){
  try{
    var today=new Date(); today=new Date(today.getFullYear(),today.getMonth(),today.getDate());
    var k=String(key);
    var closeDate;
    if(k.charAt(0)==='s'||k.charAt(0)==='d'){
      var ds=k.slice(1).split('-');
      closeDate=new Date(parseInt(ds[0]),parseInt(ds[1])-1,parseInt(ds[2]));
    }else{
      var p=k.split('-');
      var y=parseInt(p[0]),mo=parseInt(p[1])-1;
      var cut=Math.min(Math.max(parseInt(g.cutDay,10)||1,1),28);
      mo+=1; if(mo>11){mo=0;y+=1;}
      closeDate=new Date(y,mo,cut);
    }
    return Math.round((closeDate.getTime()-today.getTime())/86400000);
  }catch(e){ return 99; }
}
function checkReminders(){
  if(!S.notifyPay) return;
  if(!notifLista()||Notification.permission!=='granted') return;
  Object.keys(S.groups).forEach(function(gid){
    var g=S.groups[gid]; if(!g) return;
    if(L.freqOf(g)==='dia') return;
    var key=L.periodKey(new Date(),g);
    var days=daysUntilPeriodClose(key,g);
    if(days<0||days>3) return;
    var storageKey='lacuota_r_'+gid+'_'+key;
    try{ if(localStorage.getItem(storageKey)) return; }catch(e){}
    var mems=membersOf(gid);
    var pm=paidMap(gid,key);
    var sum=L.monthSummary(g,mems,pm);
    if(!sum.owed.length) return;
    try{ localStorage.setItem(storageKey,'1'); }catch(e){}
    var daysTxt=days===0?'hoy':(days===1?'1 día':days+' días');
    avisarConLogo(g.name,
      sum.owed.length+(sum.owed.length===1?' miembro debe':' miembros deben')+
      ' la cuota. Cierra en '+daysTxt+'.');
  });
}

/* ---------- ACTUALIZACIONES AUTOMÁTICAS ----------
   La app se actualiza sola, el usuario no tiene que hacer nada: al arrancar
   (y cada 5 minutos, y al volver del fondo) compara su versión con
   version.json del servidor. Si hay una más nueva, le pide al service
   worker que se actualice y recarga cuando el nuevo toma el control. */
var APP_V = 112;
function paintVer(){ var el=$('appVer'); if(el) el.textContent='v'+APP_V; }
function checkAppUpdate(){
  if(!('serviceWorker' in navigator)) return;
  fetch('version.json?ts='+Date.now(), {cache:'no-store'})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d && d.v && d.v > APP_V){
        navigator.serviceWorker.getRegistration().then(function(reg){
          if(reg) reg.update().catch(function(){});
        }).catch(function(){});
      }
    }).catch(function(){});
}
if('serviceWorker' in navigator){
  /* Limpia la marca de recarga al arrancar: si quedó de una sesión anterior
     en segundo plano, impediría detectar futuras actualizaciones. */
  try{ sessionStorage.removeItem('lacuota_upd'); }catch(e){}
  var bootHora = Date.now();
  /* v101: si al arrancar la página NO tenía controlador, el primer
     controllerchange es el reclamo inicial del SW recién instalado
     (clients.claim), no una actualización de versión: recargar ahí
     provocaba un parpadeo blanco justo al mostrar los grupos tras
     instalar. Solo se recarga cuando ya había un controlador activo. */
  var teniaControlador = false;
  try{ teniaControlador = !!navigator.serviceWorker.controller; }catch(e){}
  navigator.serviceWorker.addEventListener('controllerchange', function(){
    if(!teniaControlador){
      try{ teniaControlador = !!navigator.serviceWorker.controller; }catch(e){}
      return;
    }
    if(sessionStorage.getItem('lacuota_upd')) return;
    sessionStorage.setItem('lacuota_upd','1');
    /* Nunca recargar durante el arranque. Android, la actividad lanzadora y
       Chrome ya están haciendo el relevo de ventanas; una recarga aquí era
       la tercera transición y causaba los parpadeos. La nueva versión queda
       activa y se usa completa en la próxima apertura. */
    if(Date.now() - bootHora >= 12000){
      toast('Actualización lista; se aplicará cuando reabras la aplicación.');
    }
  });
  /* Revisa actualizaciones del SW al arrancar, sin esperar checkAppUpdate. */
  navigator.serviceWorker.getRegistration().then(function(reg){
    if(reg) reg.update().catch(function(){});
  }).catch(function(){});
}
document.addEventListener('visibilitychange', function(){
  if(!document.hidden){ checkAppUpdate(); reanudarSiVerificado(); checkReminders(); }
});
/* Si la verificación se completó en otra ventana (misma instalación, mismo
   perfil), al volver al frente la puerta ya no tiene nada que pedir:
   se entra directo. */
function reanudarSiVerificado(){
  try{
    var v = $('v-verify'); if(!v || v.hidden) return;
    /* Si el usuario cerró sesión a propósito, no volver a entrar aunque
       payActive sea true (needsVerify devolvería false en ese caso). */
    if(S.expectNoSession) return;
    if(L.needsVerify(S)) return;
    verStep(null);
    route();
  }catch(e){}
}
setInterval(checkAppUpdate, 5*60*1000);
/* Si el arranque falla por cualquier motivo, jamás pantalla en blanco:
   se muestra la reparación (los datos siguen guardados) y se pide la
   versión nueva al service worker. */
function bootFail(){
  try{
    if(window.__lacuotaBooted) return;
    var ov=$('bootFail'); if(ov) ov.hidden=false;
    if('serviceWorker' in navigator){
      navigator.serviceWorker.getRegistration().then(function(reg){
        if(reg) reg.update().catch(function(){});
      }).catch(function(){});
    }
  }catch(e){}
}
/* v62: verifica la versión ANTES de dejar operar. Si hay una más nueva,
   bloquea con "Actualizando…" y recarga con el código nuevo; si no,
   sigue con seguirArranque. Sin internet o si tarda, sigue igual con lo
   que hay (nunca pantalla clavada). */
/* v86: verifica la versión ANTES de dejar operar, pero JAMÁS se queda
   clavada. Si hay una más nueva, la intenta traer unos segundos y recarga
   cuando el SW nuevo toma el control; si el intento se atasca por lo que
   sea, se entra con el código actual y el chequeo periódico trae la
   versión nueva solo. Plazo máximo absoluto: a los 10 s se entra, pase lo
   que pase. Un "Actualizando…" eterno es peor que operar unos minutos con
   el código anterior. */
function actualizarAntesDeEntrar(codigo){
  /* El chequeo y la descarga de actualizaciones se hacen en segundo plano.
     Bloquear aquí, mostrar "Actualizando" y recargar mientras Chrome abre
     la TWA creaba varias pantallas consecutivas. Se entra una sola vez con
     la versión coherente que ya está instalada. */
  seguirArranque(codigo);
}
function seguirArranque(codigo){
  bootstrapTrial(); /* arranca la prueba si se perdió (recuperación/cambio de teléfono) */
  /* v63: con código de Google se canjea y se entra directo a los grupos;
     sin código, la puerta normal. */
  if(codigo && codigo.c){
    canjearCodigo(codigo.c, codigo.s);
    paintVer();
    checkAppUpdate();
    window.__lacuotaBooted = true;
    return;
  }
  /* La prueba exige cuenta de Google verificada en el servidor (una por
     cuenta): quien tenga grupos sin verificar ve la pantalla de
     verificación al arrancar, antes de entrar. El enlace con el que venía
     (si traía uno) se guarda para retomarlo tras verificar. */
  var _rg = null;
  try{ _rg = sessionStorage.getItem('lacuota_verGid'); }catch(e){}
  if(L.needsVerify(S) || S.expectNoSession){
    /* Solo se guarda, nunca se borra aquí: al volver de Google el hash viene
       vacío y borrarlo perdería el enlace pendiente. Lo consume
       aplicarSesionGoogle() tras verificar. */
    var _vh = location.hash || '';
    try{ if(_vh && _vh !== '#') sessionStorage.setItem('lacuota_verHash', _vh); }catch(e){}
    showVerify();
  }else if(_rg && S.groups && S.groups[_rg]){
    try{ sessionStorage.removeItem('lacuota_verGid'); }catch(e){}
    openGroup(_rg);
  }else{
    route();
  }
  paintVer();
  checkAppUpdate();
  checkReminders();
  window.__lacuotaBooted = true;
}
try{
  /* Si se llegó desde la app instalada ("abrir en el navegador"), se marca
     para avisar que ya puede volver a la app tras verificar, y se limpia
     el hash antes de que la puerta lo guarde como enlace pendiente. */
  try{
    if(String(location.hash||'')==='#entrar-app'){
      try{ sessionStorage.setItem('lacuota_desdeApp','1'); }catch(e){}
      try{
        if(typeof history!=='undefined' && history && history.replaceState){
          history.replaceState(null,'',String(location).split('#')[0]);
        }else{ location.hash = '#'; }
      }catch(e2){ try{ location.hash='#'; }catch(e3){} }
    }
  }catch(e4){}
  /* HTML más viejo que el JS: pedir la versión nueva una sola vez por
     sesión en vez de arrancar degradado en silencio. */
  if(!$('appVer') || !$('setManageSub')){
    if(!sessionStorage.getItem('lacuota_stale')){
      sessionStorage.setItem('lacuota_stale','1');
      if('serviceWorker' in navigator){
        var staleDone=false;
        navigator.serviceWorker.getRegistration().then(function(reg){
          if(reg) reg.update().catch(function(){});
        }).catch(function(){});
        /* Si el SW nuevo toma el control, el controllerchange ya recarga
           solo con los archivos nuevos; esto es solo el plan B. */
        navigator.serviceWorker.addEventListener('controllerchange', function(){ staleDone=true; });
        setTimeout(function(){ if(!staleDone) location.reload(); }, 8000);
      }else{
        setTimeout(function(){ location.reload(); }, 2000);
      }
    }
  }
  /* v62: la puerta JAMÁS opera con código viejo. Antes la actualización
     corría en segundo plano y se podía tocar "Continuar con Google" con la
     versión anterior todavía activa. Si hay versión nueva: se guarda el
     boleto (si se traía uno), se bloquea la pantalla con "Actualizando…" y
     se recarga con el código nuevo antes de dejar tocar nada. */
  /* v63: Google devuelve el código en la dirección de la app
     (?code=...&state=...). Se limpia de la barra (un solo uso) y se guarda
     en la sesión por si una actualización recarga la página antes del
     canje. Si Google devolvió un error (el usuario cerró su ventana),
     se limpia igual y la puerta queda lista, en silencio. */
  var _code0 = null, _state0 = null;
  try{
    var _qs = String(location.search || '');
    var _qm = _qs.match(/[?&]code=([A-Za-z0-9\-_~.%]{10,})/);
    var _sm = _qs.match(/[?&]state=([A-Za-z0-9\-_~.%]{10,})/);
    if(_qm){
      _code0 = decodeURIComponent(_qm[1]);
      _state0 = _sm ? decodeURIComponent(_sm[1]) : null;
    }
    /* v65: retorno del flujo NATIVO. La app instalada abre el Custom Tab de
       Google con redirect_uri=https://lacuota.org/ (el mismo que usa en el
       canje) y Google devuelve el código a ESTA página. El state nativo trae
       el prefijo 'lcn1_'. El secreto PKCE vive en la WebView de la app, así
       que aquí NO se canjea ni se guarda nada: se reenvía al deep link
       lacuota://oauth para que la app instalada lo canjee con su PKCE. */
    var _esRetornoNativo = false;
    try{ _esRetornoNativo = !!(_code0 && _state0 && _state0.indexOf('lcn1_') === 0); }catch(e2){}
    if(_esRetornoNativo){
      try{
        location.replace('lacuota://oauth?code=' + encodeURIComponent(_code0) +
                         '&state=' + encodeURIComponent(_state0));
      }catch(e3){}
      try{ document.title = 'Abriendo La Cuota…'; }catch(e4){}
    }else if(_qm){
      try{ sessionStorage.setItem('lacuota_code', JSON.stringify({c: _code0, s: _state0, ts: Date.now()})); }catch(e5){}
    }
  }catch(e){}
  if(!_esRetornoNativo && (_code0 || /[?&]error=/.test(String(location.search || '')))){
    try{
      if(history && history.replaceState) history.replaceState(null, '', String(location).split('?')[0]);
    }catch(e){}
  }
  if(!_code0){
    /* La página se recargó (actualización automática) entre el regreso
       de Google y el canje: el código sigue en la sesión de la pestaña. */
    try{
      var _cs = JSON.parse(sessionStorage.getItem('lacuota_code') || 'null');
      if(_cs && _cs.c && (Date.now() - (_cs.ts || 0)) < 5*60*1000){ _code0 = _cs.c; _state0 = _cs.s; }
      else sessionStorage.removeItem('lacuota_code');
    }catch(e){ _code0 = null; }
  }
  actualizarAntesDeEntrar((_esRetornoNativo || !_code0) ? null : {c:_code0, s:_state0});
}catch(err){ bootFail(); }
/* Re-verificar la suscripción en silencio al arrancar: si Stripe dice que
   ya no está activa, se desactiva sola (nadie la mantiene a mano).
   En Android se verifican las compras de Google Play además de Stripe. */
if(esAndroidTWA()){
  playSyncAlArrancar();
}else if(S.payActive && S.payEmail){
  payCheck(S.payEmail).then(function(res){
    if(res && !res.offline && !res.active){
      S.payActive = false; S.payVia=''; save(); route();
    }
  });
}
/* Grupos de antes de la llave: seguir el puntero migratedTo de la nube
   y mover los datos locales a la dirección nueva (una sola vez). */
function migrarLegados(){
  Object.keys(S.groups).forEach(function(gid){
    if(!L.esLegado(gid)) return;
    CuotaNube.obtener(gid).then(function(remote){
      var nuevo = remote && remote.migratedTo;
      if(!nuevo || S.groups[nuevo]) return;
      S.groups[nuevo] = S.groups[gid];
      S.groups[nuevo].id = nuevo;
      if(S.ui['m_'+gid]){ S.ui['m_'+nuevo]=S.ui['m_'+gid]; delete S.ui['m_'+gid]; }
      delete S.groups[gid];
      if(curGid===gid) curGid=nuevo;
      save();
      nubePull(nuevo, function(changed){ if(changed && curGid===nuevo) renderGroup(); });
    });
  });
}
/* Al abrir un grupo con llave, los grupos viejos locales ya no sirven */
function limpiarLegados(excepto){
  Object.keys(S.groups).forEach(function(gid){
    if(gid!==excepto && L.esLegado(gid)) delete S.groups[gid];
  });
}
/* Al arrancar: si hay nube, traer lo último de cada grupo en silencio
   y subir lo local (migración inicial de datos existentes) */
if(nubeLista()){
  migrarLegados();
  Object.keys(S.groups).forEach(function(gid){
    nubePull(gid, function(changed){
      if(changed && gid===curGid) renderGroup();
      nubePushSoon();
    });
  });
  /* v106: sincronización final forzada en cada arranque (migración a la
     envoltura nativa). Sube fusionando de inmediato, sin esperar cambios. */
  nubePushAll();
  /* v108: migración única — los grupos locales pasan a seguir a la cuenta:
     se reclaman una sola vez para que el próximo inicio los traiga solos. */
  try{
    if(S.googleSess && !localStorage.getItem('lacuota_claimedGroups')){
      Object.keys(S.groups || {}).forEach(function(gid){ reclamarGrupo(gid); });
      localStorage.setItem('lacuota_claimedGroups', '1');
    }
  }catch(e){}
}
})();

/* La Cuota — pruebas de arranque (v34).
   Regresión del incidente 2026-09-20: HTML viejo en caché + JS nuevo
   tumbaba la app al arrancar (pantalla en blanco). Estas pruebas
   garantizan que eso no vuelva a pasar, ni con miles de usuarios. */
var fs = require('fs'), vm = require('vm'), path = require('path');
var DIR = __dirname;
var appJs = fs.readFileSync(path.join(DIR,'app.js'),'utf8');
var indexHtml = fs.readFileSync(path.join(DIR,'index.html'),'utf8');
var swJs = fs.readFileSync(path.join(DIR,'sw.js'),'utf8');
var cssTxt = fs.readFileSync(path.join(DIR,'styles.css'),'utf8');
/* Muestra del HTML v28 (antes en /tmp/repro): fixture dentro del repo para
   que las pruebas no dependan de archivos temporales. */
var v28Html = fs.readFileSync(path.join(DIR,'test','fixtures','index-v28.html'),'utf8');
var failures = 0;
function t(name, cond, extra){
  if(cond){ console.log('ok   '+name); }
  else{ failures++; console.log('FALLO '+name+(extra?' — '+extra:'')); }
}

/* 1. Estático: ningún enlace directo sin protección */
t('sin $().addEventListener desprotegido',
  !/\$\('[A-Za-z0-9]+'\)\.addEventListener\(/.test(appJs));
t('existe el ayudante on()',
  /function on\(id, ev, fn\)/.test(appJs));

/* 2. Estático: todo id enlazado con on() existe en index.html */
var htmlIds = {};
(indexHtml.match(/id="[A-Za-z0-9-]+"/g)||[]).forEach(function(m){
  htmlIds[m.slice(4,-1)] = true;
});
var boundIds = {};
var m, re = /on\('([A-Za-z0-9]+)',/g;
while((m = re.exec(appJs))) boundIds[m[1]] = true;
var missing = Object.keys(boundIds).filter(function(id){ return !htmlIds[id]; });
/* Los que faltan deben crearse dinámicamente (innerHTML) antes de enlazarse */
var notDynamic = missing.filter(function(id){
  return appJs.indexOf('id="'+id+'"') === -1;
});
t('todos los ids de on() existen en index.html o se crean dinámicamente ('+Object.keys(boundIds).length+' revisados)',
  notDynamic.length === 0, notDynamic.join(','));

/* 3. Estático: guardián de arranque en index.html */
t('index.html tiene el overlay #bootFail', /id="bootFail"/.test(indexHtml));
t('index.html tiene el botón #bootRepair', /id="bootRepair"/.test(indexHtml));
t('guardián: muestra reparación si no hay __lacuotaBooted',
  /__lacuotaBooted/.test(indexHtml));
/* La reparación solo borra caché y service worker: jamás escribe/borra datos */
var guardianSrc = (indexHtml.match(/Guardián de arranque[\s\S]*?<\/script>/)||[''])[0];
t('reparación no toca los datos (sin setItem/removeItem/clear)',
  !/localStorage\s*\.\s*(setItem|removeItem|clear)/.test(guardianSrc));

/* 4. Estático: service worker atómico + notificaciones */
t('sw.js precarga con cache:reload (sin mezcla de versiones)',
  /new Request\(u, \{cache:'reload'\}\)/.test(swJs));
t('sw.js maneja notificationclick (tocar abre la app)',
  /notificationclick/.test(swJs));

/* ---------- sandbox para pruebas de ejecución ---------- */
function makeSandbox(opts){
  opts = opts || {};
  var avail = opts.ids; // Set de ids "presentes en el HTML"
  var dyn = {};
  function fakeEl(id){
    var el = {
      __id:id,
      addEventListener:function(ev,fn){ (this._ev=this._ev||{})[ev]=fn; }, removeEventListener:function(){},
      textContent:'', value:'', disabled:false, hidden:false,
      style:{}, dataset:{},
      classList:{add:function(){},remove:function(){},toggle:function(){}},
      appendChild:function(){}, remove:function(){}, click:function(){},
      focus:function(){}, select:function(){}, closest:function(){return null;},
      querySelector:function(){return fakeEl('q');},
      querySelectorAll:function(){return [];},
      scrollIntoView:function(){}
    };
    Object.defineProperty(el, 'innerHTML', {
      get:function(){ return this._h||''; },
      set:function(h){ this._h=h;
        var mm, rx=/id="([A-Za-z0-9-]+)"/g;
        while((mm=rx.exec(String(h)))) dyn[mm[1]]=true;
      }
    });
    return el;
  }
  var store = {}, sstore = {};
  if(opts.seed){ Object.keys(opts.seed).forEach(function(k){ store[k] = opts.seed[k]; }); }
  var notifCalls = [];
  var sb = {
    console:console,
    addEventListener:function(){}, removeEventListener:function(){},
    scrollTo:function(){}, scroll:function(){},
    setTimeout:function(){ return 0; }, clearTimeout:function(){},
    setInterval:function(){ return 0; },
    document:{
      getElementById:function(id){ return (avail.has(id)||dyn[id])?fakeEl(id):null; },
      addEventListener:function(){}, hidden:false,
      documentElement:fakeEl('html'), body:fakeEl('body'),
      createElement:function(){return fakeEl('c');},
      querySelector:function(){return fakeEl('q');},
      execCommand:function(){ return true; }
    },
    location:{hash:opts.hash||'', href:'https://lacuota.org/', reload:function(){ sb.__reloaded=true; }},
    navigator:{},
    localStorage:{getItem:function(k){return store[k]!==undefined?store[k]:null;},
      setItem:function(k,v){store[k]=String(v);}, removeItem:function(k){delete store[k];}},
    sessionStorage:{getItem:function(k){return sstore[k]!==undefined?sstore[k]:null;},
      setItem:function(k,v){sstore[k]=String(v);}, removeItem:function(k){delete sstore[k];}},
    fetch:function(){ return Promise.reject(new Error('offline')); },
    history:{length:1, back:function(){}},
    URL:{createObjectURL:function(){return 'blob:x';}, revokeObjectURL:function(){}},
    Blob:function(){},
    __notifCalls:notifCalls, __reloaded:false
  };
  if(opts.notif){
    sb.Notification = {
      permission: opts.notifPermission || 'granted',
      requestPermission:function(){ return Promise.resolve(opts.notifPermission||'granted'); }
    };
    sb.navigator.serviceWorker = {
      ready: Promise.resolve({ showNotification:function(t,o){ notifCalls.push({t:t,o:o}); } }),
      getRegistration:function(){ return Promise.resolve(null); },
      addEventListener:function(){}, removeEventListener:function(){}
    };
  }
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  return sb;
}
function loadApp(sb){
  ['logica.js','nube.js','app.js'].forEach(function(f){
    vm.runInContext(fs.readFileSync(path.join(DIR,f),'utf8'), sb, {filename:f});
  });
}
function idsFromHtml(html){
  var s = new Set(), mm, rx=/id="([A-Za-z0-9-]+)"/g;
  while((mm=rx.exec(html))) s.add(mm[1]);
  return s;
}

/* 5. Ejecución: HTML VIEJO (v28, sin appVer/setManageSub) + JS nuevo → NO debe tumbarse */
(function(){
  var sb = makeSandbox({ids: idsFromHtml(v28Html)});
  var threw = null;
  try{ loadApp(sb); }catch(e){ threw = e; }
  t('HTML viejo + JS nuevo: arranca sin excepción', !threw, threw && threw.message);
  t('HTML viejo + JS nuevo: __lacuotaBooted=true', sb.__lacuotaBooted===true);
})();

/* 6. Ejecución: HTML actual + JS nuevo → arranca */
(function(){
  var sb = makeSandbox({ids: idsFromHtml(indexHtml)});
  var threw = null;
  try{ loadApp(sb); }catch(e){ threw = e; }
  t('HTML actual + JS nuevo: arranca sin excepción', !threw, threw && threw.message);
  t('HTML actual + JS nuevo: __lacuotaBooted=true', sb.__lacuotaBooted===true);
})();

/* 7. Ejecución: hash #/terminos con HTML viejo → no tumba, no blanco */
(function(){
  var sb = makeSandbox({ids: idsFromHtml(v28Html), hash:'#/terminos'});
  var threw = null;
  try{ loadApp(sb); }catch(e){ threw = e; }
  t('HTML viejo + #/terminos: sin excepción', !threw, threw && threw.message);
})();

/* 8. Notificaciones: sin API → no tumba; con permiso → logo de la app */
(function(){
  var sb = makeSandbox({ids: idsFromHtml(indexHtml)});
  loadApp(sb);
  var threw = null, r1, r2;
  try{
    r1 = sb.__lacuotaNotif.avisar('La Cuota','hola'); // sin Notification en sandbox
    sb.__lacuotaNotif.pedir(function(ok){ r2 = ok; });
  }catch(e){ threw = e; }
  t('sin Notification API: no tumba y no avisa', !threw && r1===undefined && r2===false);
})();
var asyncTests = [];
asyncTests.push((function(){
  var sb = makeSandbox({ids: idsFromHtml(indexHtml), notif:true, notifPermission:'granted'});
  loadApp(sb);
  sb.__lacuotaNotif.avisar('La Cuota','Reporte listo');
  return Promise.resolve().then(function(){ return Promise.resolve(); }).then(function(){
    t('con permiso: showNotification usa el icono de la app',
      sb.__notifCalls.length===1 && /icon-192/.test(sb.__notifCalls[0].o.icon),
      JSON.stringify(sb.__notifCalls));
    t('con permiso: la notificación es de La Cuota',
      sb.__notifCalls.length===1 && sb.__notifCalls[0].t==='La Cuota');
  });
})());

/* 9. Administrar suscripción: sin globo negro; un toque si ya hay correo */
t('adiós al prompt nativo: app.js no usa window.prompt',
  !/window\.prompt\s*\(/.test(appJs));
t('manageSub entra directo si hay correo guardado',
  /if\(email\)\{\s*openPortal\(email\); return;/.test(appJs));
t('el diálogo de correo guarda el correo para la próxima vez',
  /function subEmailGo\(\)[\s\S]{0,300}S\.payEmail = em;/.test(appJs));
(function(){
  var sb = makeSandbox({ids: idsFromHtml(indexHtml)});
  loadApp(sb);
  var promptCalls = 0;
  sb.prompt = function(){ promptCalls++; return ''; };
  var fetchUrls = [];
  sb.fetch = function(u){ fetchUrls.push(String(u)); return Promise.reject(new Error('offline')); };
  /* elementos persistentes para leer lo que el diálogo escribe */
  var persist = {};
  var origGet = sb.document.getElementById;
  sb.document.getElementById = function(id){
    if(id==='sheet'||id==='subEmail'){ if(!persist[id]) persist[id]=origGet.call(sb.document,id); return persist[id]; }
    return origGet.call(sb.document, id);
  };
  var threw = null;
  try{
    var SUB = sb.__lacuotaSub;
    /* caso 1: pagando y con correo guardado → directo al portal, sin preguntar */
    SUB.pago(true);
    SUB.setEmail('deivy@correo.com');
    SUB.manage();
    t('con correo guardado: no pide el correo (cero prompts)', promptCalls===0);
    t('con correo guardado: llama al portal con ese correo',
      fetchUrls.length===1 && fetchUrls[0].indexOf('/portal?email=deivy%40correo.com')!==-1, fetchUrls.join('|'));
    /* caso 2: pagando pero sin correo (otro teléfono) → diálogo propio, sin prompt */
    SUB.setEmail('');
    fetchUrls = [];
    promptCalls = 0;
    SUB.manage();
    var sheetHtml = (persist.sheet && persist.sheet.innerHTML) || '';
    t('pagando sin correo: no usa el globo negro del sistema', promptCalls===0);
    t('pagando sin correo: abre diálogo de La Cuota con campo de correo',
      /id="subEmail"/.test(sheetHtml) && /Continuar/.test(sheetHtml) && /Administrar suscripción/.test(sheetHtml));
    t('pagando sin correo: todavía no llama al portal', fetchUrls.length===0);
    /* caso 3: escribe el correo y continúa → lo guarda y abre el portal */
    persist.subEmail.value = 'deivy@correo.com';
    SUB.go();
    t('al continuar: guarda el correo', SUB.getEmail()==='deivy@correo.com');
    t('al continuar: abre el portal con ese correo',
      fetchUrls.length===1 && fetchUrls[0].indexOf('/portal?email=deivy%40correo.com')!==-1);
    /* caso 4: la próxima vez ya es un toque */
    fetchUrls = []; promptCalls = 0;
    SUB.manage();
    t('próxima vez: un toque, sin diálogo ni prompt',
      promptCalls===0 && fetchUrls.length===1);
    /* caso 5: correo inválido → no avanza */
    SUB.setEmail('');
    fetchUrls = [];
    persist.subEmail.value = 'no-es-correo';
    SUB.go();
    t('correo inválido: no llama al portal', fetchUrls.length===0);
    /* caso 6: sin pagar → página de suscripción, ni diálogo ni portal */
    SUB.pago(false); SUB.setEmail('');
    fetchUrls = []; promptCalls = 0;
    SUB.manage();
    t('sin pagar: no pide correo ni llama al portal', promptCalls===0 && fetchUrls.length===0);
  }catch(e){ threw = e; }
  t('flujo de suscripción: sin excepción', !threw, threw && threw.message);
})();

t('nunca se abre una pestaña vacía en el código', !/window\.open\(\s*['"]about:blank['"]/.test(appJs));
t('openPortal pide la URL antes de abrir (fetch primero)',
  /function openPortal\(email\)[\s\S]{0,200}fetch\(PAY_VERIFY_URL/.test(appJs));

/* 10. Portal: nunca una pestaña vacía; si el bloqueador actúa, botón de La Cuota */
asyncTests.push((function(){
  var sb = makeSandbox({ids: idsFromHtml(indexHtml)});
  loadApp(sb);
  var fetchDefers = [], fetchUrls = [], openCalls = [], openRet = null;
  sb.fetch = function(u){
    fetchUrls.push(String(u));
    var d = {};
    d.promise = new Promise(function(res, rej){ d.res = res; d.rej = rej; });
    fetchDefers.push(d);
    return d.promise;
  };
  sb.open = function(url, target){ openCalls.push([url, target]); return openRet; };
  var persist = {};
  var origGet = sb.document.getElementById;
  sb.document.getElementById = function(id){
    if(id==='sheet'){ if(!persist[id]) persist[id]=origGet.call(sb.document,id); return persist[id]; }
    return origGet.call(sb.document, id);
  };
  function tick(n){ var p = Promise.resolve(); for(var i=0;i<(n||8);i++) p = p.then(function(){}); return p; }
  function okUrl(u){ return { json:function(){ return Promise.resolve({url:u}); } }; }
  var SUB = sb.__lacuotaSub;
  SUB.pago(true); /* el portal solo aplica a quien paga */
  SUB.setEmail('deivy@correo.com');
  SUB.manage();
  return tick().then(function(){
    t('portal: no se abre pestaña antes de tener la URL', openCalls.length===0);
    openRet = { closed:false }; /* el navegador permite abrir */
    fetchDefers[0].res(okUrl('https://billing.stripe.com/p/sesion123'));
    return tick();
  }).then(function(){
    t('portal: abre la URL real de Stripe',
      openCalls.length===1 && openCalls[0][0]==='https://billing.stripe.com/p/sesion123',
      JSON.stringify(openCalls));
    /* bloqueador activo: window.open devuelve null */
    fetchDefers = []; openCalls = []; openRet = null;
    SUB.manage();
    return tick();
  }).then(function(){
    fetchDefers[0].res(okUrl('https://billing.stripe.com/p/sesion456'));
    return tick();
  }).then(function(){
    var sheetHtml = (persist.sheet && persist.sheet.innerHTML) || '';
    t('portal bloqueado: ofrece botón "Abrir ahora" de La Cuota',
      /id="urlGo"/.test(sheetHtml) && /Abrir ahora/.test(sheetHtml));
    t('portal bloqueado: ninguna pestaña vacía',
      !openCalls.some(function(c){ return c[0]==='about:blank'; }));
    openRet = { closed:false };
    SUB.reintentar('https://billing.stripe.com/p/sesion456'); /* gesto real: tocar el botón */
    t('al tocar Abrir ahora: abre la URL de Stripe',
      openCalls.length===2 && openCalls[1][0]==='https://billing.stripe.com/p/sesion456');
    /* correo sin suscripción → aviso, cero pestañas */
    fetchDefers = []; openCalls = [];
    SUB.manage();
    return tick();
  }).then(function(){
    fetchDefers[0].res({ json:function(){ return Promise.resolve({error:'not_found'}); } });
    return tick();
  }).then(function(){
    t('sin suscripción: no se abre ninguna pestaña', openCalls.length===0);
  });
})());

/* 11. Prueba gratis: si se perdió el inicio (recuperación/cambio de teléfono),
   arranca desde el primer pago registrado y el aviso vuelve a verse */
t('bootstrapTrial existe y se llama al arrancar',
  /function bootstrapTrial\(\)/.test(appJs) && /bootstrapTrial\(\);/.test(appJs));
t('manageSub sin suscripción activa lleva a la página de suscribirse',
  /if\(!S\.payActive\)\{\s*renderPay\(\); return;\s*\}/.test(appJs));
t('renderPay titula según la prueba', /id="payTitle"/.test(indexHtml) && /payTitle/.test(appJs));
(function(){
  function psb(opts){
    var sb = makeSandbox(opts);
    var els = {};
    var origGet = sb.document.getElementById;
    sb.document.getElementById = function(id){
      if(!els[id]) els[id] = origGet.call(sb.document, id);
      return els[id];
    };
    sb.__els = els;
    return sb;
  }
  function seed(o){
    o = o || {};
    return { lacuota_v1: JSON.stringify({
      groups:o.groups||{}, members:{}, payments:o.payments||{}, payTs:{}, delMembers:{}, unpays:{},
      onboarded:true, trialStart:o.trialStart||0, payActive:!!o.payActive, payEmail:o.payEmail||'',
      notifyPay:false, ui:{}, googleOk:!!o.googleOk, googleSub:o.googleSub||'', googleTrialStart:o.googleTrialStart||0
    })};
  }
  var DAY = 86400000, now = Date.now(), threw = null;
  try{
    /* 11a: con pagos viejos y sin trialStart → la prueba arranca del primer pago
       (cuenta verificada que perdió sus datos y los recuperó) */
    var OLD = now - 7*DAY;
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({
      groups:{g1:{id:'g1',name:'T'}}, payments:{g1:{'2026-09':{m1:OLD}}}, trialStart:0, googleOk:true })});
    loadApp(sb);
    t('trial perdido: arranca desde el primer pago registrado', sb.__lacuotaSub.trial()===OLD);
    t('trial perdido: el aviso vuelve a verse',
      sb.__els.trialBanner.hidden===false && /Te quedan/.test(sb.__els.trialBanner.innerHTML) && /días/.test(sb.__els.trialBanner.innerHTML));
    /* 11a2: SIN cuenta verificada no se arranca ninguna prueba nueva */
    var sbv = psb({ids: idsFromHtml(indexHtml), seed: seed({
      groups:{g1:{id:'g1',name:'T'}}, payments:{g1:{'2026-09':{m1:OLD}}}, trialStart:0 })});
    loadApp(sbv);
    t('sin verificar: no se regala prueba al arrancar', sbv.__lacuotaSub.trial()===0);
    /* 11b: con grupos pero sin pagos → arranca hoy */
    var sb2 = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'T'}}, trialStart:0, googleOk:true})});
    var before = Date.now(); loadApp(sb2);
    var tr = sb2.__lacuotaSub.trial();
    t('sin pagos previos: la prueba arranca hoy', tr>=before && tr<=Date.now());
    /* 11c: sin grupos → no arranca nada */
    var sb3 = psb({ids: idsFromHtml(indexHtml), seed: seed({trialStart:0})});
    loadApp(sb3);
    t('sin grupos: no se inventa prueba', sb3.__lacuotaSub.trial()===0);
    /* 12a: sin suscripción activa → el botón lleva a suscribirse */
    var sb4 = psb({ids: idsFromHtml(indexHtml), seed: seed({
      groups:{g1:{id:'g1',name:'T'}}, trialStart: now-5*DAY, payActive:false, googleOk:true })});
    loadApp(sb4);
    t('etiqueta del botón sin pagar: "Suscribirme"',
      sb4.__els.btnManageSub.textContent==='Suscribirme', sb4.__els.btnManageSub.textContent);
    sb4.__lacuotaSub.manage();
    t('sin pagar: abre la página de suscripción',
      sb4.__els['v-pay'].hidden===false && sb4.__els['v-home'].hidden===true);
    t('en prueba: el título invita a suscribirse',
      sb4.__els.payTitle.textContent==='Suscríbete a La Cuota', sb4.__els.payTitle.textContent);
    /* 12b: pagando → va al portal, no a la página de planes */
    var sb5 = psb({ids: idsFromHtml(indexHtml), seed: seed({
      groups:{g1:{id:'g1',name:'T'}}, trialStart: now-5*DAY, payActive:true, payEmail:'d@x.com' })});
    var urls = [];
    sb5.fetch = function(u){ urls.push(String(u)); return Promise.reject(new Error('offline')); };
    loadApp(sb5);
    urls = []; /* el arranque re-verifica la suscripción; lo que importa es este toque */
    t('etiqueta del botón pagando: "Administrar suscripción"',
      sb5.__els.btnManageSub.textContent==='Administrar suscripción');
    sb5.__lacuotaSub.manage();
    t('pagando: pide el portal con su correo (no la página de planes)',
      urls.length===1 && /\/portal\?email=/.test(urls[0]) && sb5.__els['v-pay'].hidden===true);
    /* 12c: prueba vencida → título de prueba terminada */
    var sb6 = psb({ids: idsFromHtml(indexHtml), seed: seed({
      groups:{g1:{id:'g1',name:'T'}}, trialStart: now-31*DAY, payActive:false, googleOk:true })});
    loadApp(sb6);
    sb6.__lacuotaSub.manage();
    t('prueba vencida: el título dice que terminó',
      sb6.__els.payTitle.textContent==='Tu prueba terminó', sb6.__els.payTitle.textContent);
  }catch(e){ threw = e; }
  t('prueba y suscripción: sin excepción', !threw, threw && threw.message);
})();

t('plan anual: sin frase que prometa meses extra', !/meses gratis/.test(indexHtml));
t('plan anual: explica que son 12 meses por $20',
  /12 meses por el precio de 10/.test(indexHtml) && /El plan anual cubre 12 meses por \$20/.test(indexHtml));
/* 13. Los planes se explican antes de ir a Stripe (nada de salto directo) */
t('existe la explicación del plan y los botones la usan',
  /function planExplain\(which\)/.test(appJs) && /planExplain\('monthly'\)/.test(appJs) && /planExplain\('yearly'\)/.test(appJs));
t('ningún plan salta directo a Stripe', !/payGo\('(monthly|yearly)'\)/.test(appJs));
t('preconexión a Stripe para que abra más rápido', /rel="preconnect"[^>]*buy\.stripe\.com/.test(indexHtml));
t('la explicación presenta la dirección de Stripe como confianza', /buy\.stripe\.com/.test(appJs));
(function(){
  function psb(opts){
    var sb = makeSandbox(opts);
    var els = {};
    var origGet = sb.document.getElementById;
    sb.document.getElementById = function(id){
      if(!els[id]) els[id] = origGet.call(sb.document, id);
      return els[id];
    };
    return sb;
  }
  var threw = null;
  try{
    var sb = psb({ids: idsFromHtml(indexHtml)});
    loadApp(sb);
    var openCalls = [];
    sb.open = function(url){ openCalls.push(String(url)); return {closed:false, close:function(){}}; };
    sb.__lacuotaSub.plan('monthly');
    var html = sb.document.getElementById('sheet').innerHTML;
    t('plan mensual: explica precio y renovación antes de Stripe',
      /Plan Mensual/.test(html) && /\$2 al mes/.test(html) && /Continuar al pago/.test(html));
    t('plan mensual: no abre Stripe todavía', openCalls.length===0);
    sb.document.getElementById('planGoPay')._ev.click();
    t('al continuar: abre el enlace mensual de Stripe',
      openCalls.length===1 && /buy\.stripe\.com\/28E8wI8AD1iGdK413kbV600/.test(openCalls[0]), openCalls.join('|'));
    sb.__lacuotaSub.plan('yearly');
    var html2 = sb.document.getElementById('sheet').innerHTML;
    t('plan anual: explica los 12 meses antes de Stripe',
      /Plan Anual/.test(html2) && /12 meses/.test(html2) && /\$20/.test(html2) && /Continuar al pago/.test(html2));
    sb.document.getElementById('planBack')._ev.click();
    t('atrás: cierra sin abrir Stripe', openCalls.length===1);
  }catch(e){ threw = e; }
  t('explicación de planes: sin excepción', !threw, threw && threw.message);
})();

/* 14. Borrar todo y recuperar NO reinicia la prueba (la nube manda) */
asyncTests.push(new Promise(function(resolve){
  var sb = makeSandbox({ids: idsFromHtml(indexHtml)});
  var NUBE_TRIAL = 1000; // la prueba original empezó aquí
  loadApp(sb);
  sb.CuotaNube = { /* nube.js la define real; aquí la simulamos */
    lista: function(){ return true; },
    obtener: function(){
      return Promise.resolve({
        meta:{ id:'g9', name:'Junta', amount:10, currency:'RD$', freq:'mensual',
               cutDay:1, cutWeekday:0, createdAt:5, updatedAt:5, trialStart: NUBE_TRIAL },
        members:{}, payments:{}, payTs:{}, delMembers:{}, unpays:{}
      });
    }
  };
  t('arranque limpio: sin prueba local', sb.__lacuotaSub.trial()===0, String(sb.__lacuotaSub.trial()));
  sb.__lacuotaSub.recover('g9', function(ok){
    t('recuperar: el grupo vuelve de la nube', ok===true);
    t('la prueba NO se reinicia: vale la fecha de la nube',
      sb.__lacuotaSub.trial()===NUBE_TRIAL, String(sb.__lacuotaSub.trial()));
    resolve();
  });
}));

/* 15. Verificación con Google: una prueba por cuenta (la puerta de la prueba) */
t('existe la pantalla de verificación en el HTML',
  /id="v-verify"/.test(indexHtml) && /id="verGoogle"/.test(indexHtml) && /id="verMsg"/.test(indexHtml));
t('v-verify está en la lista de vistas', /'v-verify'/.test(appJs));
t('v-verify vende la app antes de pedir Google (qué es + beneficios)',
  /verify-perks/.test(indexHtml) && /organiza el dinero de tu grupo/.test(indexHtml));
t('banner de instalación existe en el inicio', /id="installBanner"/.test(indexHtml));
t('app.js captura beforeinstallprompt para el botón Instalar', /beforeinstallprompt/.test(appJs));
t('iPhone tiene instrucciones manuales de instalación', /Añadir a pantalla de inicio/.test(appJs));
t('Firebase Auth se carga (compat, sin bloquear si no hay red)',
  /firebase-app-compat\.js/.test(indexHtml) && /firebase-auth-compat\.js/.test(indexHtml));
t('la verificación habla con el worker (/trial)', /\/trial/.test(appJs) && /TRIAL_URL/.test(appJs));
t('si la clave no está puesta, lo dice claro en vez de fallar raro',
  /indexOf\('CLAVE_'\)===0/.test(appJs));
t('existe la puerta L.needsVerify', /L\.needsVerify = function/.test(
  fs.readFileSync(path.join(DIR,'logica.js'),'utf8')));
t('el primer pago no arranca prueba sin verificar', /ensureTrial\(\)/.test(appJs));
t('crear grupo pide verificar antes de anotar', /L\.needsVerify\(S\)/.test(appJs));
(function(){
  function psb(opts){
    var sb = makeSandbox(opts);
    var els = {};
    var origGet = sb.document.getElementById;
    sb.document.getElementById = function(id){
      if(!els[id]) els[id] = origGet.call(sb.document, id);
      return els[id];
    };
    sb.__els = els;
    return sb;
  }
  function seed(o){
    o = o || {};
    return { lacuota_v1: JSON.stringify({
      groups:o.groups||{}, members:{}, payments:o.payments||{}, payTs:{}, delMembers:{}, unpays:{},
      onboarded:true, trialStart:o.trialStart||0, payActive:!!o.payActive, payEmail:o.payEmail||'',
      notifyPay:false, ui:{}, googleOk:!!o.googleOk, expectNoSession:!!o.expectNoSession,
      redirectPending:!!o.redirectPending
    })};
  }
  var threw = null;
  try{
    /* 15a: quién ve la verificación */
    var a = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1'}}})});
    loadApp(a);
    t('con grupos y sin nada: necesita verificar', a.__lacuotaSub.necesitaVerificar()===true);
    var b = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1'}}, trialStart: 123})});
    loadApp(b);
    t('con prueba local pero sin verificar: SÍ pide verificar (v44: la puerta es para todos, no solo nuevos)',
      b.__lacuotaSub.necesitaVerificar()===true);
    var c = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1'}}, payActive:true})});
    loadApp(c);
    t('pagando: no pide verificar', c.__lacuotaSub.necesitaVerificar()===false);
    var d = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1'}}, googleOk:true})});
    loadApp(d);
    t('verificado: no pide verificar', d.__lacuotaSub.necesitaVerificar()===false);
    /* 15b: la pantalla se muestra */
    a.__lacuotaSub.verificar();
    t('verificar(): muestra la pantalla v-verify',
      a.__els['v-verify'].hidden===false && a.__els['v-home'].hidden===true);
    /* 15c: con la clave real puesta, el botón intenta verificar de verdad.
       En el sandbox no hay Firebase ni red: mensaje claro, sin llamadas. */
    var fetchCalls = 0;
    a.fetch = function(){ fetchCalls++; return Promise.reject(new Error('no debe llamarse')); };
    a.__els['verGoogle']._ev.click();
    t('con clave real: intenta verificar (no dice "no activada") y no llama a la red',
      fetchCalls===0 && a.__els['verMsg'].hidden===false &&
      !/aún no está activada/.test(a.__els['verMsg'].textContent) &&
      /conexión/.test(a.__els['verMsg'].textContent),
      a.__els['verMsg'].textContent);
  }catch(e){ threw = e; }
  t('verificación: sin excepción', !threw, threw && threw.message);
  /* 15d: al volver del redirect de Google, completa la verificación con el
     usuario del redirect (currentUser puede no estar listo aún) y NO rebota
     a Google otra vez. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    loadApp(sb);
    var signInCalls = 0, fetchCalls = [];
    sb.__lacuotaSub.setAuth({
      ready: function(){ return true; },
      user: function(){ return null; }, /* el peligro: currentUser aún no listo */
      signIn: function(){ signInCalls++; return Promise.resolve(null); },
      redirectResult: function(){ return Promise.resolve({user:{getIdToken:function(){ return Promise.resolve('TOKEN123'); }}}); },
      token: function(){ return Promise.resolve(null); }
    });
    sb.fetch = function(url, opts){
      fetchCalls.push({url:url, body:String(opts && opts.body || '')});
      return Promise.resolve({ ok:true, json:function(){ return Promise.resolve({ok:true, trialStart:999, trialUsed:false}); } });
    };
    sb.__lacuotaSub.redir();
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('redirect: verifica y guarda la prueba', st.googleOk===true && st.trialStart===999, JSON.stringify(st));
      t('redirect: llamó a /trial con el token del redirect',
        fetchCalls.length===1 && /\/trial$/.test(fetchCalls[0].url) && /TOKEN123/.test(fetchCalls[0].body),
        fetchCalls.length+' llamadas');
      t('redirect: NO rebotó a Google (sin bucle)', signInCalls===0, signInCalls+' signIn');
      resolve();
    }, 60);
  }));
  /* 15e: reingreso con la prueba aún activa (worker nuevo): entra al
     inicio sin ir al pago. Prueba vencida: va al pago. Worker viejo
     (solo trialUsed, sin trialActive): se conserva el trato anterior. */
  [['activa', {ok:true, trialUsed:true, trialStart:111, trialExpiresAt:222, trialActive:true, trialExpired:false}, 'v-home'],
   ['vencida', {ok:true, trialUsed:true, trialStart:111, trialExpiresAt:222, trialActive:false, trialExpired:true}, 'v-pay'],
   ['vieja', {ok:true, trialUsed:true, trialStart:111}, 'v-pay']
  ].forEach(function(caso){
    asyncTests.push(new Promise(function(resolve){
      var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
      loadApp(sb);
      sb.__lacuotaSub.setAuth({
        ready: function(){ return true; },
        user: function(){ return null; },
        signIn: function(){ return Promise.resolve(null); },
        redirectResult: function(){ return Promise.resolve({user:{getIdToken:function(){ return Promise.resolve('T'); }}}); },
        token: function(){ return Promise.resolve(null); }
      });
      sb.fetch = function(){
        return Promise.resolve({ ok:true, json:function(){ return Promise.resolve(caso[1]); } });
      };
      sb.__lacuotaSub.redir();
      setTimeout(function(){
        var st = sb.__lacuotaSub.cuenta();
        t('reingreso '+caso[0]+': verifica y guarda la prueba',
          st.googleOk===true && st.trialStart===111, JSON.stringify(st));
        t('reingreso '+caso[0]+': muestra '+caso[2],
          (sb.__els[caso[2]]||{}).hidden===false,
          'v-home.hidden='+((sb.__els['v-home']||{}).hidden)+' v-pay.hidden='+((sb.__els['v-pay']||{}).hidden));
        resolve();
      }, 60);
    }));
  });
  /* 15f: la puerta sale AL ARRANCAR para usuarios antiguos con prueba
     local pero sin verificar (v44): ven v-verify en vez del inicio. */
  (function(){
    var sb = psb({ids: idsFromHtml(indexHtml),
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}, trialStart: 123})});
    loadApp(sb);
    t('arranque sin verificar: muestra v-verify',
      sb.__els['v-verify'].hidden===false, 'v-verify.hidden='+sb.__els['v-verify'].hidden);
    t('arranque sin verificar: no muestra el inicio',
      sb.__els['v-home'].hidden===true, 'v-home.hidden='+sb.__els['v-home'].hidden);
  })();
  /* 15g: con la cuenta verificada, el arranque entra directo (sin puerta). */
  (function(){
    var sb = psb({ids: idsFromHtml(indexHtml),
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}, trialStart: 123, googleOk:true})});
    loadApp(sb);
    t('arranque verificado: no muestra v-verify',
      sb.__els['v-verify'].hidden===true, 'v-verify.hidden='+sb.__els['v-verify'].hidden);
    t('arranque verificado: muestra el inicio',
      sb.__els['v-home'].hidden===false, 'v-home.hidden='+sb.__els['v-home'].hidden);
  })();
  /* 15h: si venía con un enlace, la puerta lo guarda para retomarlo tras
     verificar (sobrevive al redirect porque va en sessionStorage). */
  (function(){
    var sb = psb({ids: idsFromHtml(indexHtml), hash:'#/g/g1',
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}})});
    loadApp(sb);
    t('puerta al arrancar: guarda el enlace pendiente',
      sb.sessionStorage.getItem('lacuota_verHash')==='#/g/g1',
      String(sb.sessionStorage.getItem('lacuota_verHash')));
    var sb2 = psb({ids: idsFromHtml(indexHtml),
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}})});
    loadApp(sb2);
    t('puerta al arrancar sin enlace: no guarda nada pendiente',
      sb2.sessionStorage.getItem('lacuota_verHash')===null);
  })();
  /* 15k (v49): el redirect de Google se entrega UNA vez. Si la página se
     recargó después (actualización automática, pestaña restaurada), el
     resultado viene vacío aunque la sesión siga viva: la app completa la
     verificación con la sesión guardada en vez de varar al usuario. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}, redirectPending:true})});
    loadApp(sb);
    var fetchCalls = [];
    sb.__lacuotaSub.setAuth({
      ready: function(){ return true; },
      /* redirect ya consumido: no trae usuario... */
      redirectResult: function(){ return Promise.resolve(null); },
      /* ...pero la sesión de Google sigue viva en el teléfono */
      user: function(){ return {getIdToken:function(){ return Promise.resolve('TOKEN_SESION'); }}; },
      onUser: function(cb){ return function(){}; },
      signIn: function(){ return Promise.resolve(null); },
      token: function(){ return Promise.resolve(null); }
    });
    sb.fetch = function(url, opts){
      fetchCalls.push({url:url, body:String(opts && opts.body || '')});
      return Promise.resolve({ ok:true, json:function(){ return Promise.resolve({ok:true, trialStart:777, trialUsed:false}); } });
    };
    sb.__lacuotaSub.redir();
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('redirect consumido + sesión viva: verifica con la sesión guardada',
        st.googleOk===true && st.trialStart===777, JSON.stringify(st));
      t('redirect consumido + sesión viva: llamó a /trial con el token de la sesión',
        fetchCalls.length===1 && /TOKEN_SESION/.test(fetchCalls[0].body),
        fetchCalls.length+' llamadas');
      t('redirect consumido + sesión viva: entra al inicio',
        sb.__els['v-home'].hidden===false, 'v-home.hidden='+sb.__els['v-home'].hidden);
      resolve();
    }, 60);
  }));
  /* 15l (v50/v51/v56): volviendo de Google sin sesión: la puerta lo dice en
     tono amable y SIN códigos en pantalla (los códigos solo quedan en el
     registro interno). El aviso se muestra en gris tranquilo, nunca en rojo. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}, redirectPending:true})});
    loadApp(sb);
    sb.__lacuotaSub.setAuth({
      ready: function(){ return true; },
      redirectResult: function(){ return Promise.resolve(null); },
      user: function(){ return null; },
      onUser: function(cb){ cb(null); return function(){}; },
      signIn: function(){ return Promise.resolve(null); },
      token: function(){ return Promise.resolve(null); }
    });
    var warned = [];
    var origWarn = console.warn;
    console.warn = function(){ warned.push(Array.prototype.slice.call(arguments).join(' ')); };
    sb.__lacuotaSub.redir();
    setTimeout(function(){
      console.warn = origWarn;
      var msgEl = sb.__els['verMsg'];
      var txt = msgEl.textContent;
      t('sin sesión tras Google: muestra mensaje amable',
        msgEl.hidden===false && /no devolvió la sesión/.test(txt), txt);
      t('sin sesión tras Google: NO muestra códigos en pantalla',
        !/código:|sin-sesion/.test(txt), txt);
      t('sin sesión tras Google: el código queda en el registro interno',
        warned.some(function(w){ return /sin-sesion/.test(w); }), warned.join(' | '));
      resolve();
    }, 60);
  }));
  /* 15m (v51): el inicio con Google usa popup (todo queda en la misma
     página, la sesión no se pierde) y verifica con el token del usuario
     que trae el popup. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    loadApp(sb);
    var fetchCalls = [];
    sb.__lacuotaSub.setAuth({
      ready: function(){ return true; },
      redirectResult: function(){ return Promise.resolve(null); },
      user: function(){ return null; },
      onUser: function(cb){ return function(){}; },
      /* el popup devuelve la credencial con el usuario en la misma página */
      signIn: function(){ return Promise.resolve({user:{getIdToken:function(){ return Promise.resolve('TOK_POPUP'); }}}); },
      token: function(){ return Promise.resolve(null); }
    });
    sb.fetch = function(url, opts){
      fetchCalls.push({url:url, body:String(opts && opts.body || '')});
      return Promise.resolve({ ok:true, json:function(){ return Promise.resolve({ok:true, trialStart:555, trialUsed:false}); } });
    };
    sb.__lacuotaSub.verificar();
    sb.__els['verGoogle']._ev.click();
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('popup: verifica con el token del usuario del popup',
        st.googleOk===true && st.trialStart===555, JSON.stringify(st));
      t('popup: llamó a /trial con el token del popup',
        fetchCalls.length===1 && /TOK_POPUP/.test(fetchCalls[0].body), fetchCalls.length+' llamadas');
      t('popup: entra al inicio',
        sb.__els['v-home'].hidden===false, 'v-home.hidden='+sb.__els['v-home'].hidden);
      resolve();
    }, 60);
  }));
  /* 15n (v51): si el navegador bloquea el popup, el inicio REAL cae al
     redirect como respaldo en vez de varar al usuario. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    loadApp(sb);
    /* Aquí NO se reemplaza FB_AUTH: se prueba el real con Firebase simulado */
    var redirectCalls = 0;
    function FakeProvider(){ this.addScope = function(){}; }
    sb.firebase = {
      apps: [],
      initializeApp: function(){},
      auth: function(){
        return {
          currentUser: null,
          signInWithPopup: function(){ return Promise.reject({code:'auth/popup-blocked'}); },
          signInWithRedirect: function(){ redirectCalls++; return Promise.resolve(); }
        };
      }
    };
    sb.firebase.auth.GoogleAuthProvider = FakeProvider;
    sb.__lacuotaSub.verificar();
    sb.__els['verGoogle']._ev.click();
    setTimeout(function(){
      t('popup bloqueado: usa redirect como respaldo', redirectCalls===1, redirectCalls+' llamadas');
      resolve();
    }, 60);
  }));
  /* v52 (estático): la ventanita nativa de Google (FedCM) es la vía principal
     en la app instalada, donde popup y redirect pierden la sesión. */
  t('index.html carga la librería de Google (gsi)', /accounts\.google\.com\/gsi\/client/.test(indexHtml));
  t('GOOGLE_CLIENT_ID del proyecto configurado', /GOOGLE_CLIENT_ID = '741417625058-oug08d9kbgtu1ma6ft6dninmdg7nk1ug\.apps\.googleusercontent\.com'/.test(appJs));
  t('signIn intenta FedCM primero y canjea por sesión de Firebase',
    /fedcmToken\(\)\.then/.test(appJs) && /signInWithCredential/.test(appJs));
  t('en la app instalada no se intenta el popup (se cuelga)',
    /if\(instalada\) return Promise\.reject\(\{code:'auth\/popup-closed-by-user'\}\)/.test(appJs));
  t('v-verify muestra la versión en letra pequeña (verVer)',
    /id="verVer"/.test(indexHtml) && /getElementById\('verVer'\)/.test(appJs));
  t('v54: el inicio tiene "Cerrar sesión" junto a las demás opciones (homeSignOut)',
    /id="homeSignOut"/.test(indexHtml) && /on\('homeSignOut', 'click', cerrarSesion\)/.test(appJs)
    && !/id="setSignOut"/.test(indexHtml));
  t('v54: Ajustes ya no tiene "Cerrar sesión" (no es por grupo)',
    !/setSignOut/.test(appJs));
  t('v55: cerrar sesión marca expectNoSession y verifica que la sesión murió',
    /S\.expectNoSession = true/.test(appJs) && /noSePudo\('signout-zombie'\)/.test(appJs));
  t('v55: tras cerrar sesión, continuar siempre pasa por Google (no reutiliza la vieja)',
    /if\(S\.expectNoSession\) return freshSignIn\(\);/.test(appJs));
  t('v55: el arranque no entra solo con la sesión vieja si se pidió salir',
    /if\(S\.expectNoSession\)\{ verStep\(null\); return; \}/.test(appJs));
  t('v55: al verificar se limpia la marca de cierre',
    /S\.expectNoSession = false;/.test(appJs));
  t('v55: al cerrar sesión se apaga el auto-entrar de Google',
    /disableAutoSelect\(\)/.test(appJs));
  t('v56: el redirect a Google deja marca pendiente para rescatar al volver',
    /S\.redirectPending = true; save\(\);/.test(appJs));
  t('v56: al arrancar normal (sin volver de Google) no se persigue ninguna sesión',
    /if\(!veniaDeGoogle\)\{ verStep\(null\); return; \}/.test(appJs));
  t('v56: si se cierra la ventanita de Google no se muestra ningún aviso',
    !/Se canceló el inicio de sesión/.test(appJs));
  t('v56: la puerta jamás muestra alarmas en rojo',
    !/#verMsg\{color:#b00020/.test(cssTxt));
  /* 15o (v52): en la app instalada la ventanita nativa de Google (FedCM)
     devuelve el token sin salir de la página; se canjea por la sesión de
     Firebase y la prueba se verifica con el token del usuario real. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    loadApp(sb);
    sb.matchMedia = function(){ return {matches:true}; }; /* app instalada */
    var gisCfg = null, credCalls = [], popupCalls = 0, redirectCalls = 0, fetchCalls = [];
    sb.google = { accounts: { id: {
      initialize: function(cfg){ gisCfg = cfg; },
      prompt: function(cb){ gisCfg.callback({credential:'GIS_JWT_DE_PRUEBA'}); },
      cancel: function(){}
    }}};
    function FakeProvider(){ this.addScope = function(){}; }
    FakeProvider.credential = function(idToken){ credCalls.push(idToken); return {idToken:idToken}; };
    sb.firebase = {
      apps: [], initializeApp: function(){},
      auth: function(){
        return {
          currentUser: null,
          signInWithCredential: function(cred){
            return Promise.resolve({user:{getIdToken:function(){ return Promise.resolve('TOK_FEDCM'); }}});
          },
          signInWithPopup: function(){ popupCalls++; return Promise.reject({code:'auth/popup-blocked'}); },
          signInWithRedirect: function(){ redirectCalls++; return Promise.resolve(); }
        };
      }
    };
    sb.firebase.auth.GoogleAuthProvider = FakeProvider;
    sb.fetch = function(url, opts){
      fetchCalls.push({url:url, body:String(opts && opts.body || '')});
      return Promise.resolve({ ok:true, json:function(){ return Promise.resolve({ok:true, trialStart:777, trialUsed:false}); } });
    };
    sb.__lacuotaSub.verificar();
    sb.__els['verGoogle']._ev.click();
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('fedcm: canjea el token de Google por sesión de Firebase',
        credCalls.length===1 && credCalls[0]==='GIS_JWT_DE_PRUEBA', credCalls.join(','));
      t('fedcm: verifica con el token del usuario real',
        st.googleOk===true && st.trialStart===777, JSON.stringify(st));
      t('fedcm: llamó a /trial con el token de Firebase',
        fetchCalls.length===1 && /TOK_FEDCM/.test(fetchCalls[0].body), fetchCalls.length+' llamadas');
      t('fedcm: entra al inicio', sb.__els['v-home'].hidden===false, 'v-home.hidden='+sb.__els['v-home'].hidden);
      t('fedcm: no abrió popup ni redirect', popupCalls===0 && redirectCalls===0, 'popup='+popupCalls+' redirect='+redirectCalls);
      t('fedcm: usó el client_id del proyecto',
        gisCfg && gisCfg.client_id==='741417625058-oug08d9kbgtu1ma6ft6dninmdg7nk1ug.apps.googleusercontent.com',
        String(gisCfg && gisCfg.client_id));
      resolve();
    }, 60);
  }));
  /* 15p (v52): si la librería de Google no cargó, el inicio REAL cae al
     popup clásico en vez de varar al usuario. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    loadApp(sb);
    /* sin sb.google: la librería gsi no cargó */
    var popupCalls = 0, fetchCalls = [];
    function FakeProvider(){ this.addScope = function(){}; }
    FakeProvider.credential = function(idToken){ return {idToken:idToken}; };
    sb.firebase = {
      apps: [], initializeApp: function(){},
      auth: function(){
        return {
          currentUser: null,
          signInWithCredential: function(){ return Promise.reject({code:'x'}); },
          signInWithPopup: function(){ popupCalls++; return Promise.resolve({user:{getIdToken:function(){ return Promise.resolve('TOK_POPUP2'); }}}); },
          signInWithRedirect: function(){ return Promise.resolve(); }
        };
      }
    };
    sb.firebase.auth.GoogleAuthProvider = FakeProvider;
    sb.fetch = function(url, opts){
      fetchCalls.push(1);
      return Promise.resolve({ ok:true, json:function(){ return Promise.resolve({ok:true, trialStart:888, trialUsed:false}); } });
    };
    sb.__lacuotaSub.verificar();
    sb.__els['verGoogle']._ev.click();
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('sin gsi: cae al popup clásico', popupCalls===1, popupCalls+' llamadas');
      t('sin gsi: verifica y entra', st.googleOk===true && sb.__els['v-home'].hidden===false, JSON.stringify(st));
      resolve();
    }, 60);
  }));
  /* 15q (v52/v56): en la app instalada, si se descarta la ventanita de Google,
     NO se intenta el popup (que se quedaría colgado en una pestaña del
     sistema) y NO se muestra ningún mensaje: la puerta queda lista en
     silencio, porque cerrar la ventanita no es un error. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    loadApp(sb);
    sb.matchMedia = function(){ return {matches:true}; }; /* app instalada */
    var popupCalls = 0, redirectCalls = 0;
    sb.google = { accounts: { id: {
      initialize: function(cfg){},
      prompt: function(cb){
        cb({isSkippedMoment:function(){return false;}, isDismissedMoment:function(){return true;}, isDisplayMoment:function(){return false;}});
      },
      cancel: function(){}
    }}};
    function FakeProvider(){ this.addScope = function(){}; }
    FakeProvider.credential = function(idToken){ return {idToken:idToken}; };
    sb.firebase = {
      apps: [], initializeApp: function(){},
      auth: function(){
        return {
          currentUser: null,
          signInWithCredential: function(){ return Promise.reject({code:'x'}); },
          signInWithPopup: function(){ popupCalls++; return new Promise(function(){}); },
          signInWithRedirect: function(){ redirectCalls++; return Promise.resolve(); }
        };
      }
    };
    sb.firebase.auth.GoogleAuthProvider = FakeProvider;
    sb.__lacuotaSub.verificar();
    sb.__els['verGoogle']._ev.click();
    setTimeout(function(){
      var vm = sb.__els['verMsg'];
      t('descarte en instalada: no se muestra ningún mensaje (cerrar la ventanita no es un error)',
        vm.hidden===true, 'verMsg.hidden='+vm.hidden+' texto='+vm.textContent);
      t('descarte en instalada: no intenta popup ni redirect',
        popupCalls===0 && redirectCalls===0, 'popup='+popupCalls+' redirect='+redirectCalls);
      t('descarte en instalada: el botón queda habilitado',
        sb.__els['verGoogle'].disabled===false, String(sb.__els['verGoogle'].disabled));
      resolve();
    }, 60);
  }));
  /* 15s (v54): "Cerrar sesión" está en el inicio (no en Ajustes): cierra la
     sesión de Google y vuelve a mostrar la puerta, sin tocar grupos ni pagos.
     v55: además deja la marca expectNoSession y apaga el auto-entrar de Google. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml),
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}, googleOk:true})});
    loadApp(sb);
    var signOutCalls = 0, dasCalls = 0;
    sb.google = { accounts: { id: {
      cancel: function(){},
      disableAutoSelect: function(){ dasCalls++; }
    }}};
    sb.firebase = { apps:[], initializeApp:function(){}, auth:function(){
      return { signOut:function(){ signOutCalls++; return Promise.resolve(); } };
    }};
    sb.__els['homeSignOut']._ev.click();
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('cerrar sesión: llamó a signOut de Firebase', signOutCalls===1, signOutCalls+' llamadas');
      t('cerrar sesión: apaga el auto-entrar de Google (disableAutoSelect)', dasCalls===1, dasCalls+' llamadas');
      t('cerrar sesión: deja la marca "pedí salir" (expectNoSession)', st.expectNoSession===true, JSON.stringify(st));
      t('cerrar sesión: limpia la verificación', st.googleOk===false, JSON.stringify(st));
      t('cerrar sesión: muestra la puerta de Google', sb.__els['v-verify'].hidden===false, 'v-verify.hidden='+sb.__els['v-verify'].hidden);
      t('cerrar sesión: la puerta vuelve a pedir verificación (grupos intactos)',
        sb.__lacuotaSub.necesitaVerificar()===true, String(sb.__lacuotaSub.necesitaVerificar()));
      t('cerrar sesión: la puerta muestra la versión en letra pequeña',
        /^v\d+$/.test(sb.__els['verVer'].textContent), sb.__els['verVer'].textContent);
      resolve();
    }, 60);
  }));
  /* 15t (v55): si la sesión vieja sigue viva al arrancar tras un cierre
     explícito, la app NO entra sola: se queda en la puerta. Sin la marca,
     el rescate de redirect (v49) sigue funcionando igual. */
  asyncTests.push(new Promise(function(resolve){
    function bootConZombie(flag, pending, cb){
      var sb = psb({ids: idsFromHtml(indexHtml),
        seed: seed({groups:{g1:{id:'g1',name:'G1'}}, googleOk:false, expectNoSession:flag, redirectPending:pending})});
      var zombie = { getIdToken:function(){ return Promise.resolve('tok-zombie'); } };
      sb.firebase = { apps:[], initializeApp:function(){}, auth:function(){
        return {
          currentUser: zombie,
          signOut:function(){ return Promise.resolve(); },
          getRedirectResult:function(){ return Promise.resolve(null); },
          onAuthStateChanged:function(){ return function(){}; }
        };
      }};
      var fetchCalls = 0;
      /* nube.js también habla con la base al arrancar: aquí solo cuenta la
         verificación de la cuenta contra el worker (/trial). */
      sb.fetch = function(url){ if(String(url).indexOf('/trial')>=0) fetchCalls++; return Promise.reject(new Error('offline')); };
      loadApp(sb);
      setTimeout(function(){ cb(sb, fetchCalls); }, 60);
    }
    bootConZombie(true, false, function(sb, fetchCalls){
      var st = sb.__lacuotaSub.cuenta();
      t('con marca de cierre: no intenta verificar la sesión vieja', fetchCalls===0, fetchCalls+' fetch');
      t('con marca de cierre: sigue sin verificar', st.googleOk===false, JSON.stringify(st));
      t('con marca de cierre: se queda en la puerta', sb.__els['v-verify'].hidden===false, 'v-verify.hidden='+sb.__els['v-verify'].hidden);
      bootConZombie(false, true, function(sb2, fetchCalls2){
        t('sin marca, volviendo de Google (rescate v49): sí completa con la sesión guardada', fetchCalls2===1, fetchCalls2+' fetch');
        resolve();
      });
    });
  }));
  /* 15u (v55): si el cierre no logra matar la sesión, no finge que cerró:
     avisa con mensaje amable y te deja adentro con tu sesión intacta. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml),
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}, googleOk:true})});
    loadApp(sb);
    var signOutCalls = 0;
    var zombie = { getIdToken:function(){ return Promise.resolve('tok-zombie'); } };
    sb.firebase = { apps:[], initializeApp:function(){}, auth:function(){
      return { currentUser: zombie,
        signOut:function(){ signOutCalls++; return Promise.resolve(); } };
    }};
    sb.__els['homeSignOut']._ev.click();
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('cierre fallido: reintentó cerrar la sesión', signOutCalls===2, signOutCalls+' llamadas');
      t('cierre fallido: no finge, restaura la sesión', st.googleOk===true && st.expectNoSession===false, JSON.stringify(st));
      t('cierre fallido: se queda en el inicio (no muestra la puerta)',
        sb.__els['v-home'].hidden===false, 'v-home.hidden='+sb.__els['v-home'].hidden);
      t('cierre fallido: avisa amable, sin códigos',
        /No se pudo cerrar la sesión/.test(sb.__els['toast'].textContent) && !/signout/.test(sb.__els['toast'].textContent),
        sb.__els['toast'].textContent);
      resolve();
    }, 60);
  }));
  /* 15v (v56): al arrancar normal no se persigue ninguna sesión: sin un
     redirect pendiente, la app no espera ni muestra avisos aunque quede una
     sesión vieja en el teléfono. Volviendo de Google, el rescate sigue. */
  asyncTests.push(new Promise(function(resolve){
    function bootZombie(pending, cb){
      var sb = psb({ids: idsFromHtml(indexHtml),
        seed: seed({groups:{g1:{id:'g1',name:'G1'}}, googleOk:false, redirectPending:pending})});
      var zombie = { getIdToken:function(){ return Promise.resolve('tok-zombie'); } };
      sb.firebase = { apps:[], initializeApp:function(){}, auth:function(){
        return {
          currentUser: zombie,
          signOut:function(){ return Promise.resolve(); },
          getRedirectResult:function(){ return Promise.resolve(null); },
          onAuthStateChanged:function(){ return function(){}; }
        };
      }};
      var fetchCalls = 0;
      sb.fetch = function(url){ if(String(url).indexOf('/trial')>=0) fetchCalls++; return Promise.reject(new Error('offline')); };
      loadApp(sb);
      setTimeout(function(){ cb(sb, fetchCalls); }, 60);
    }
    bootZombie(false, function(sb, fetchCalls){
      t('arranque normal: no intenta rescatar la sesión vieja', fetchCalls===0, fetchCalls+' fetch');
      t('arranque normal: no muestra ningún aviso', sb.__els['verMsg'].hidden===true, 'verMsg.hidden='+sb.__els['verMsg'].hidden);
      t('arranque normal: se queda en la puerta', sb.__els['v-verify'].hidden===false, 'v-verify.hidden='+sb.__els['v-verify'].hidden);
      bootZombie(true, function(sb2, fetchCalls2){
        t('volviendo de Google: el rescate sigue funcionando', fetchCalls2===1, fetchCalls2+' fetch');
        resolve();
      });
    });
  }));
  /* 15w (v56): si el usuario cierra la ventanita de Google, no se le muestra
     nada: ni errores ni avisos. La puerta queda lista, en silencio. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml),
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}, googleOk:false})});
    loadApp(sb);
    sb.matchMedia = function(){ return {matches:true}; }; /* app instalada */
    sb.google = { accounts: { id: {
      initialize: function(){},
      prompt: function(cb){ cb({isSkippedMoment:function(){return false;}, isDismissedMoment:function(){return true;}}); },
      cancel: function(){}, disableAutoSelect: function(){}
    }}};
    sb.firebase = { apps:[], initializeApp:function(){}, auth:function(){
      return {
        currentUser: null,
        signInWithPopup: function(){ return Promise.reject({code:'auth/popup-blocked'}); },
        signInWithRedirect: function(){ return Promise.resolve(); },
        signInWithCredential: function(){ return Promise.resolve({user:{getIdToken:function(){return Promise.resolve('x');}}}); }
      };
    }};
    function FakeProvider(){ this.addScope = function(){}; }
    FakeProvider.credential = function(idToken){ return {idToken:idToken}; };
    sb.firebase.auth.GoogleAuthProvider = FakeProvider;
    sb.fetch = function(){ return Promise.reject(new Error('offline')); };
    sb.__els['verGoogle']._ev.click();
    setTimeout(function(){
      t('ventanita cerrada: no se muestra ningún mensaje', sb.__els['verMsg'].hidden===true, 'verMsg.hidden='+sb.__els['verMsg'].hidden);
      t('ventanita cerrada: el botón queda listo', sb.__els['verGoogle'].disabled===false, 'disabled='+sb.__els['verGoogle'].disabled);
      t('ventanita cerrada: sigue sin verificar', sb.__lacuotaSub.cuenta().googleOk===false, JSON.stringify(sb.__lacuotaSub.cuenta()));
      resolve();
    }, 60);
  }));
  /* 15i: al verificar, la fecha local se alinea con la del servidor
     (autoridad), sin importar si había prueba local. */
  t('al verificar se adopta la fecha del servidor',
    /S\.trialStart = S\.googleTrialStart;/.test(appJs));
  /* 16: el día de cierre mensual se elige tocando (botones 1-28), sin
     escribir el número a mano: ni al crear el grupo ni en ajustes. */
  t('crear grupo: día del mes con botones para tocar (obDays)',
    /id="obDays"/.test(appJs) && /segDays/.test(appJs));
  t('crear grupo: ya no pide el número a mano (sin input numérico de día)',
    !/¿Qué día del mes cierran\?';\s*\n?\s*f\.innerHTML='<input/.test(appJs));
  t('ajustes: día de corte con botones para tocar (setDays)',
    /id="setDays"/.test(appJs));
  t('ajustes: ya no usa el campo numérico setCut',
    !/\$\('setCut'\)/.test(appJs));
  /* 15j (v46): el enlace de tesorero en un teléfono nuevo NO salta la
     puerta. En incógnito no hay grupos al arrancar y la puerta pasa de
     largo; al importar el grupo por el enlace debe mostrar v-verify
     antes de dejar entrar. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({})});
    loadApp(sb);
    t('incógnito sin grupos: al arrancar no pide verificar (aún no hay nada)',
      sb.__lacuotaSub.necesitaVerificar()===false);
    sb.CuotaNube.obtener = function(){ return Promise.resolve({
      meta:{id:'g1', name:'Grupo de prueba', trialStart:111},
      members:{}, payments:{}, payTs:{}, delMembers:{}, unpays:{}
    }); };
    sb.location.hash = '#/g/g1';
    sb.__lacuotaSub.enlace('#/g/g1');
    setTimeout(function(){
      t('enlace en teléfono nuevo: tras importar muestra v-verify',
        sb.__els['v-verify'].hidden===false,
        'v-verify.hidden='+sb.__els['v-verify'].hidden);
      t('enlace en teléfono nuevo: no entra al grupo sin verificar',
        sb.__els['v-group'].hidden===true,
        'v-group.hidden='+sb.__els['v-group'].hidden);
      t('enlace en teléfono nuevo: guarda el enlace para retomarlo tras verificar',
        sb.sessionStorage.getItem('lacuota_verHash')==='#/g/g1',
        String(sb.sessionStorage.getItem('lacuota_verHash')));
      resolve();
    }, 80);
  }));
})();

Promise.all(asyncTests).then(function(){
  console.log(failures ? ('\n'+failures+' FALLOS') : '\nTODO OK (arranque)');
  process.exit(failures ? 1 : 0);
});

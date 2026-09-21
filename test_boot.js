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
    location:{hash:opts.hash||'', href:'https://lacuota.org/', hostname:'localhost', reload:function(){ sb.__reloaded=true; }},
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
  /lp-feats/.test(indexHtml) && /lp-chips/.test(indexHtml) && /lp-free-badge/.test(indexHtml));
t('banner de instalación existe en el inicio', /id="installBanner"/.test(indexHtml));
t('app.js captura beforeinstallprompt para el botón Instalar', /beforeinstallprompt/.test(appJs));
t('iPhone tiene instrucciones manuales de instalación', /Añadir a pantalla de inicio/.test(appJs));
t('v63: index.html ya no carga Firebase Auth (el login es PKCE directo)',
  !/firebase-app-compat/.test(indexHtml) && !/firebase-auth-compat/.test(indexHtml));
t('v63: la verificación habla con el worker (/google/code)',
  /\/google\/code/.test(appJs) && /function googleCodeUrl\(\)/.test(appJs));
t('v63: el ID de cliente OAuth está fijo en el código',
  /GOOGLE_OAUTH_CLIENT_ID = '741417625058-oug08d9kbgtu1ma6ft6dninmdg7nk1ug/.test(appJs));
t('v63: no queda código del login viejo (Firebase, redirects ni boletos)',
  !/signInWithRedirect/.test(appJs) && !/signInWithPopup/.test(appJs) &&
  !/getRedirectResult/.test(appJs) && !/canjearBoleto/.test(appJs) &&
  !/devolverALaApp/.test(appJs) && !/boletoIntentUrl/.test(appJs) &&
  !/leerTicketCompartido/.test(appJs) && !/cuentaVerificarRedirect/.test(appJs) &&
  !/lacuota_ticket/.test(appJs) && !/redirectPending/.test(appJs));
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
      redirectPending:!!o.redirectPending, redirectFromApp:!!o.redirectFromApp
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
    /* 15c (v63): el botón navega a Google con PKCE; el canje real se prueba
       en 63a-63i. */
    t('v63: el botón "Continuar con Google" existe y llama a googleLogin',
      /on\('verGoogle', 'click', function\(\)\{\s*googleLogin\(\);/.test(appJs));
  }catch(e){ threw = e; }
  t('verificación: sin excepción', !threw, threw && threw.message);
  /* ============ v63: entrada con Google por PKCE directo ============
     Sin Firebase Auth, sin redirects de Firebase, sin boletos. El botón
     navega a Google con un reto PKCE; Google devuelve ?code=...&state=...
     en la dirección de la app; la app lo canjea con el servidor y cae
     directo en los grupos. */

  /* v63 (estático): el flujo PKCE está completo en el código. */
  t('v63: el botón navega a Google con PKCE (reto SHA-256, state, selector de cuenta)',
    /accounts\.google\.com\/o\/oauth2\/v2\/auth/.test(appJs) &&
    /code_challenge/.test(appJs) && /code_challenge_method=S256/.test(appJs) &&
    /prompt=select_account/.test(appJs) && /function pkceChallenge\(verifier\)/.test(appJs));
  t('v63: el arranque lee ?code= de la dirección y lo limpia de la barra',
    /\[?&\]code=/.test(appJs) && /lacuota_code/.test(appJs) &&
    /history\.replaceState/.test(appJs));
  t('v63: el código se canjea con el servidor y la sesión cae en los grupos',
    /function canjearCodigo\(code, state\)/.test(appJs) &&
    /function aplicarSesionGoogle\(res\)/.test(appJs) &&
    /\/google\/code/.test(appJs));
  t('v63: la dirección de regreso coincide exacta con la registrada en Google',
    /https:\/\/lacuota\.org\//.test(appJs) && /https:\/\/shadown9\.github\.io\/la-cuota\//.test(appJs));
  t('v63: "Volviendo de Google" y "Vuelve a la app" no existen en ningún texto',
    !/Volviendo de Google/.test(appJs) && !/Volviendo de Google/.test(indexHtml) &&
    !/Listo\. Vuelve a la app/.test(appJs) && !/Listo\. Vuelve a la app/.test(indexHtml));
  t('v63: la puerta jamás muestra alarmas en rojo',
    !/#verMsg\{color:#b00020/.test(cssTxt));
  /* 63a: el botón lleva a Google con PKCE válido (reto = SHA-256 del
     secreto guardado). */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    sb.crypto = require('crypto').webcrypto; sb.TextEncoder = TextEncoder;
    sb.btoa = function(s){ return Buffer.from(s, 'binary').toString('base64'); };
    loadApp(sb);
    sb.__lacuotaSub.verificar();
    sb.__els['verGoogle']._ev.click();
    setTimeout(function(){
      var href = String(sb.location.href || '');
      var pkce = null;
      try{ pkce = JSON.parse(sb.localStorage.getItem('lacuota_pkce') || 'null'); }catch(e){}
      var m = /code_challenge=([^&]+)/.exec(href);
      var esperado = null;
      if(pkce && pkce.v){
        esperado = require('crypto').createHash('sha256').update(pkce.v)
          .digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      }
      t('63a: el botón navega a Google (no a Firebase)',
        href.indexOf('https://accounts.google.com/o/oauth2/v2/auth')===0, href.slice(0,60));
      t('63a: la URL lleva el cliente OAuth de la-cuota',
        href.indexOf('client_id=741417625058-oug08d9kbgtu1ma6ft6dninmdg7nk1ug')>0, '');
      t('63a: la URL pide el regreso a lacuota.org',
        href.indexOf('redirect_uri='+encodeURIComponent('https://lacuota.org/'))>0, '');
      t('63a: el reto es el SHA-256 del secreto guardado (PKCE real)',
        !!(m && esperado && m[1]===esperado), 'challenge='+String(m&&m[1]).slice(0,20));
      t('63a: el state de la URL es el guardado al tocar el botón',
        !!(pkce && pkce.s && href.indexOf('state='+pkce.s)>0), '');
      t('63a: Google muestra el selector de cuenta',
        href.indexOf('prompt=select_account')>0, '');
      resolve();
    }, 80);
  }));
  /* 63b: canje exitoso -> sesión verificada, directo a los grupos. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    var V = new Array(87).join('v'), ST = new Array(21).join('st');
    sb.localStorage.setItem('lacuota_pkce', JSON.stringify({v:V, s:ST, ts:Date.now()}));
    var bodies = [];
    sb.fetch = function(url, opts){
      var u = String(url);
      if(u.indexOf('/google/code')>=0)
        bodies.push({url:u, body:String(opts && opts.body || '')});
      return Promise.resolve({ ok:true, json:function(){ return Promise.resolve(
        {ok:true, sub:'u1', trialStart:999, trialUsed:false, trialActive:true, trialExpired:false}); } });
    };
    loadApp(sb);
    sb.__lacuotaSub.canjearCodigo('CODIGO1234567890', ST);
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      var b = {};
      try{ b = JSON.parse(bodies[0].body); }catch(e){}
      t('63b: el código se canjea contra /google/code del worker',
        bodies.length===1 && /\/google\/code$/.test(bodies[0].url),
        bodies.map(function(x){return x.url;}).join(','));
      t('63b: se envía el secreto PKCE, el código y la dirección de regreso',
        b.verifier===V && b.code==='CODIGO1234567890' && b.redirectUri==='https://lacuota.org/',
        JSON.stringify(b).slice(0,120));
      t('63b: guarda la sesión verificada con la fecha del servidor',
        st.googleOk===true && st.trialStart===999, JSON.stringify(st));
      t('63b: cae directo en la página de grupos',
        sb.__els['v-home'].hidden===false, 'v-home.hidden='+sb.__els['v-home'].hidden);
      t('63b: el secreto PKCE se borra tras el canje (un solo uso)',
        sb.localStorage.getItem('lacuota_pkce')===null, String(sb.localStorage.getItem('lacuota_pkce')));
      resolve();
    }, 80);
  }));
  /* 63c: código que no es de esta ventana (state distinto) -> puerta, sin red. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    sb.localStorage.setItem('lacuota_pkce', JSON.stringify({v:new Array(87).join('v'), s:'OTRO-STATE-1234567890', ts:Date.now()}));
    var calls = 0;
    sb.fetch = function(url){ if(String(url).indexOf('/google/code')>=0) calls++; return Promise.reject(new Error('no debe llamarse')); };
    loadApp(sb);
    sb.__lacuotaSub.verificar();
    sb.__lacuotaSub.canjearCodigo('CODIGO1234567890', 'STATE-DISTINTO-1234567890');
    setTimeout(function(){
      t('63c: código ajeno no se canjea (cero llamadas de red)',
        calls===0, calls+' llamadas');
      t('63c: la puerta queda lista y silenciosa',
        sb.__els['v-verify'].hidden===false && sb.__els['verMsg'].hidden===true,
        'v-verify.hidden='+sb.__els['v-verify'].hidden);
      resolve();
    }, 60);
  }));
  /* 63d: Google dice "código ya usado" (lo canjeó otra ventana del teléfono)
     -> espera silenciosa, sin errores visibles. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    var V = new Array(87).join('v'), ST = new Array(21).join('st');
    sb.localStorage.setItem('lacuota_pkce', JSON.stringify({v:V, s:ST, ts:Date.now()}));
    var calls = 0;
    sb.fetch = function(url){
      if(String(url).indexOf('/google/code')>=0) calls++;
      return Promise.resolve({ ok:false, json:function(){ return Promise.resolve({ok:false, reason:'codigo_usado'}); } });
    };
    loadApp(sb);
    sb.__lacuotaSub.canjearCodigo('CODIGO1234567890', ST);
    setTimeout(function(){
      t('63d: con código ya usado se intenta canjear una sola vez',
        calls===1, calls+' llamadas');
      t('63d: no se muestra ningún error al usuario',
        sb.__els['verMsg'].hidden===true, 'verMsg='+sb.__els['verMsg'].textContent);
      t('63d: se queda en "Entrando…" esperando la sesión de la otra ventana',
        /Entrando/.test(sb.__els['verStep'].textContent), sb.__els['verStep'].textContent);
      resolve();
    }, 80);
  }));
  /* 63e: arranque con ?code= en la dirección -> canjea y entra a los grupos. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    var V = new Array(87).join('v'), ST = new Array(21).join('st');
    sb.localStorage.setItem('lacuota_pkce', JSON.stringify({v:V, s:ST, ts:Date.now()}));
    sb.location.search = '?code=CODIGO1234567890&state='+ST;
    var m = /var APP_V\s*=\s*(\d+)/.exec(appJs);
    var appV = m ? parseInt(m[1],10) : 0;
    sb.fetch = function(url){
      var u = String(url);
      if(u.indexOf('version.json')>=0)
        return Promise.resolve({ok:true, json:function(){ return Promise.resolve({v:appV}); }});
      if(u.indexOf('/google/code')>=0)
        return Promise.resolve({ ok:true, json:function(){ return Promise.resolve(
          {ok:true, sub:'u1', trialStart:555, trialUsed:false, trialActive:true, trialExpired:false}); } });
      return Promise.reject(new Error('offline'));
    };
    loadApp(sb); /* el arranque lee ?code= */
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('63e: el arranque canjea el código que trae la dirección',
        st.googleOk===true && st.trialStart===555, JSON.stringify(st));
      t('63e: entra directo a los grupos sin mostrar la puerta',
        sb.__els['v-home'].hidden===false, 'v-home.hidden='+sb.__els['v-home'].hidden);
      resolve();
    }, 80);
  }));
  /* 63e2 (REGRESIÓN v63 real): Google devuelve el código con %2F/%2B/%3D
     en la dirección (location.search crudo). El arranque debe leerlo,
     decodificarlo y canjearlo; antes el regex lo rechazaba y la app
     volvía a la puerta en silencio. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    var V = new Array(87).join('v'), ST = 'eW5nReyObt5ycp05hpUgWKLtLXh_XvYgRwCjoGyyOv4';
    sb.localStorage.setItem('lacuota_pkce', JSON.stringify({v:V, s:ST, ts:Date.now()}));
    sb.location.search = '?state='+ST+'&iss=https%3A%2F%2Faccounts.google.com' +
      '&code=4%2F0AXlqoi6u3-XUZCQyWeDvdQJTmfLaYTA2WDzAdvqA8i8JP8UKbeEaxpCKN57RLqlB8l_dVA' +
      '&scope=email+openid&authuser=0&prompt=none';
    var m = /var APP_V\s*=\s*(\d+)/.exec(appJs);
    var appV = m ? parseInt(m[1],10) : 0;
    var codeSent = null;
    sb.fetch = function(url, opts){
      var u = String(url);
      if(u.indexOf('version.json')>=0)
        return Promise.resolve({ok:true, json:function(){ return Promise.resolve({v:appV}); }});
      if(u.indexOf('/google/code')>=0){
        try{ codeSent = JSON.parse(opts.body).code; }catch(e){}
        return Promise.resolve({ ok:true, json:function(){ return Promise.resolve(
          {ok:true, sub:'u1', trialStart:555, trialUsed:false, trialActive:true, trialExpired:false}); } });
      }
      return Promise.reject(new Error('offline'));
    };
    loadApp(sb);
    setTimeout(function(){
      t('63e2: el arranque lee el código con %2F de la dirección real de Google',
        codeSent === '4/0AXlqoi6u3-XUZCQyWeDvdQJTmfLaYTA2WDzAdvqA8i8JP8UKbeEaxpCKN57RLqlB8l_dVA',
        String(codeSent).slice(0,30));
      var st = sb.__lacuotaSub.cuenta();
      t('63e2: canjea y entra a los grupos',
        st.googleOk===true && sb.__els['v-home'].hidden===false, JSON.stringify(st).slice(0,60));
      resolve();
    }, 80);
  }));
  /* 63f: arranque con ?error= (cerró la ventana de Google) -> puerta silenciosa. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    sb.location.search = '?error=access_denied';
    var calls = 0;
    var m = /var APP_V\s*=\s*(\d+)/.exec(appJs);
    var appV = m ? parseInt(m[1],10) : 0;
    sb.fetch = function(url){
      var u = String(url);
      if(u.indexOf('/google/code')>=0) calls++;
      if(u.indexOf('version.json')>=0)
        return Promise.resolve({ok:true, json:function(){ return Promise.resolve({v:appV}); }});
      return Promise.reject(new Error('offline'));
    };
    loadApp(sb);
    setTimeout(function(){
      t('63f: con error de Google no se canjea nada',
        calls===0, calls+' canjes');
      t('63f: la puerta queda lista y silenciosa',
        sb.__els['v-verify'].hidden===false && sb.__els['verMsg'].hidden===true, '');
      resolve();
    }, 60);
  }));
  /* 63g: la puerta abierta desde un grupo vuelve al grupo tras verificar. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'G1',members:{},freq:'M'}}})});
    var V = new Array(87).join('v'), ST = new Array(21).join('st');
    sb.localStorage.setItem('lacuota_pkce', JSON.stringify({v:V, s:ST, ts:Date.now()}));
    sb.fetch = function(){
      return Promise.resolve({ ok:true, json:function(){ return Promise.resolve(
        {ok:true, trialStart:777, trialUsed:false, trialActive:true, trialExpired:false}); } });
    };
    loadApp(sb);
    sb.__lacuotaSub.enlace('#/g/g1'); /* entra al grupo */
    sb.__lacuotaSub.verificar(); /* la puerta recuerda el grupo abierto */
    sb.__lacuotaSub.canjearCodigo('CODIGO1234567890', ST);
    setTimeout(function(){
      t('63g: tras verificar vuelve al grupo, no a la página inicial',
        sb.__els['v-group'].hidden===false && sb.__els['v-home'].hidden===true,
        'v-group.hidden='+sb.__els['v-group'].hidden);
      t('63g: la marca de destino se consume',
        sb.sessionStorage.getItem('lacuota_verGid')===null, String(sb.sessionStorage.getItem('lacuota_verGid')));
      resolve();
    }, 80);
  }));
  /* 63h: vector oficial de PKCE (RFC 7636). */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml)});
    sb.crypto = require('crypto').webcrypto; sb.TextEncoder = TextEncoder;
    sb.btoa = function(s){ return Buffer.from(s, 'binary').toString('base64'); };
    loadApp(sb);
    sb.__lacuotaSub.reto('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').then(function(ch){
      t('63h: el reto PKCE coincide con el vector del RFC 7636',
        ch==='E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', String(ch));
      resolve();
    }, function(e){
      t('63h: el reto PKCE coincide con el vector del RFC 7636', false, String(e&&e.message));
      resolve();
    });
  }));
  /* 63i: la dirección de regreso según el dominio. */
  (function(){
    var sb = psb({ids: idsFromHtml(indexHtml)});
    loadApp(sb);
    t('63i: en lacuota.org el regreso es https://lacuota.org/',
      sb.__lacuotaSub.urlRegreso()==='https://lacuota.org/', sb.__lacuotaSub.urlRegreso());
    sb.location.hostname = 'shadown9.github.io';
    t('63i: en github.io el regreso es la URL de la app',
      sb.__lacuotaSub.urlRegreso()==='https://shadown9.github.io/la-cuota/', sb.__lacuotaSub.urlRegreso());
  })();
/* 15s (v63): "Cerrar sesión" está en el inicio: limpia la marca local y
     muestra la puerta, sin tocar grupos ni pagos y sin depender de red. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml),
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}, googleOk:true})});
    var calls = 0;
    sb.fetch = function(url){ if(String(url).indexOf('/google/')>=0) calls++; return Promise.reject(new Error('offline')); };
    loadApp(sb);
    sb.__els['homeSignOut']._ev.click();
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('cerrar sesión: limpia la verificación', st.googleOk===false, JSON.stringify(st));
      t('cerrar sesión: deja la marca "pedí salir" (expectNoSession)', st.expectNoSession===true, JSON.stringify(st));
      t('cerrar sesión: muestra la puerta de Google', sb.__els['v-verify'].hidden===false, 'v-verify.hidden='+sb.__els['v-verify'].hidden);
      t('cerrar sesión: no necesita red (cero llamadas)', calls===0, calls+' llamadas');
      t('cerrar sesión: los grupos quedan intactos (la puerta vuelve a pedir verificar)',
        sb.__lacuotaSub.necesitaVerificar()===true, String(sb.__lacuotaSub.necesitaVerificar()));
      t('cerrar sesión: la puerta muestra la versión en letra pequeña',
        /^v\d+$/.test(sb.__els['verVer'].textContent), sb.__els['verVer'].textContent);
      resolve();
    }, 60);
  }));
  /* 15t (v63): tras un cierre explícito, un código viejo en la dirección
     no se canjea: el usuario pidió salir. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml),
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}, googleOk:false, expectNoSession:true})});
    var ST = new Array(21).join('st');
    sb.localStorage.setItem('lacuota_pkce', JSON.stringify({v:new Array(87).join('v'), s:ST, ts:Date.now()}));
    sb.location.search = '?code=CODIGO1234567890&state='+ST;
    var codeCalls = 0;
    var m = /var APP_V\s*=\s*(\d+)/.exec(appJs);
    var appV = m ? parseInt(m[1],10) : 0;
    sb.fetch = function(url){
      var u = String(url);
      if(u.indexOf('version.json')>=0)
        return Promise.resolve({ok:true, json:function(){ return Promise.resolve({v:appV}); }});
      if(u.indexOf('/google/code')>=0) codeCalls++;
      return Promise.reject(new Error('offline'));
    };
    loadApp(sb);
    setTimeout(function(){
      var st = sb.__lacuotaSub.cuenta();
      t('con marca de cierre: el código viejo no se canjea', codeCalls===0, codeCalls+' canjes');
      t('con marca de cierre: sigue sin verificar', st.googleOk===false, JSON.stringify(st));
      t('con marca de cierre: se queda en la puerta', sb.__els['v-verify'].hidden===false, 'v-verify.hidden='+sb.__els['v-verify'].hidden);
      resolve();
    }, 60);
  }));
  /* 15v (v63): al arrancar normal no se canjea nada: sin ?code= no hay
     llamadas al worker de Google. */
  asyncTests.push(new Promise(function(resolve){
    var sb = psb({ids: idsFromHtml(indexHtml),
      seed: seed({groups:{g1:{id:'g1',name:'G1'}}, googleOk:false})});
    var codeCalls = 0;
    var m = /var APP_V\s*=\s*(\d+)/.exec(appJs);
    var appV = m ? parseInt(m[1],10) : 0;
    sb.fetch = function(url){
      var u = String(url);
      if(u.indexOf('version.json')>=0)
        return Promise.resolve({ok:true, json:function(){ return Promise.resolve({v:appV}); }});
      if(u.indexOf('/google/code')>=0) codeCalls++;
      return Promise.reject(new Error('offline'));
    };
    loadApp(sb);
    setTimeout(function(){
      t('arranque normal: no canjea nada sin código', codeCalls===0, codeCalls+' canjes');
      t('arranque normal: no muestra ningún aviso', sb.__els['verMsg'].hidden===true, 'verMsg.hidden='+sb.__els['verMsg'].hidden);
      t('arranque normal: se queda en la puerta', sb.__els['v-verify'].hidden===false, 'v-verify.hidden='+sb.__els['v-verify'].hidden);
      resolve();
    }, 60);
  }));
  /* 15y (v57): el marcador #entrar-app se consume al arrancar: marca la
     sesión para avisar que vuelva a la app, sin guardarlo como enlace. */
  (function(){
    var sb = psb({ids: idsFromHtml(indexHtml), hash:'#entrar-app'});
    loadApp(sb);
    t('#entrar-app: marca la sesión para avisar al volver',
      sb.sessionStorage.getItem('lacuota_desdeApp')==='1',
      String(sb.sessionStorage.getItem('lacuota_desdeApp')));
    t('#entrar-app: no se guarda como enlace pendiente',
      sb.sessionStorage.getItem('lacuota_verHash')!=='#entrar-app',
      String(sb.sessionStorage.getItem('lacuota_verHash')));
  })();
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

/* La Cuota — pruebas de arranque (v34).
   Regresión del incidente 2026-09-20: HTML viejo en caché + JS nuevo
   tumbaba la app al arrancar (pantalla en blanco). Estas pruebas
   garantizan que eso no vuelva a pasar, ni con miles de usuarios. */
var fs = require('fs'), vm = require('vm'), path = require('path');
var DIR = __dirname;
var appJs = fs.readFileSync(path.join(DIR,'app.js'),'utf8');
var indexHtml = fs.readFileSync(path.join(DIR,'index.html'),'utf8');
var swJs = fs.readFileSync(path.join(DIR,'sw.js'),'utf8');
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
      addEventListener:function(){}, removeEventListener:function(){},
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
  var sb = makeSandbox({ids: idsFromHtml(
    fs.readFileSync('/tmp/repro/index-v28.html','utf8'))});
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
  var sb = makeSandbox({ids: idsFromHtml(
    fs.readFileSync('/tmp/repro/index-v28.html','utf8')), hash:'#/terminos'});
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
      notifyPay:false, ui:{}
    })};
  }
  var DAY = 86400000, now = Date.now(), threw = null;
  try{
    /* 11a: con pagos viejos y sin trialStart → la prueba arranca del primer pago */
    var OLD = now - 7*DAY;
    var sb = psb({ids: idsFromHtml(indexHtml), seed: seed({
      groups:{g1:{id:'g1',name:'T'}}, payments:{g1:{'2026-09':{m1:OLD}}}, trialStart:0 })});
    loadApp(sb);
    t('trial perdido: arranca desde el primer pago registrado', sb.__lacuotaSub.trial()===OLD);
    t('trial perdido: el aviso vuelve a verse',
      sb.__els.trialBanner.hidden===false && /Te quedan/.test(sb.__els.trialBanner.innerHTML) && /días/.test(sb.__els.trialBanner.innerHTML));
    /* 11b: con grupos pero sin pagos → arranca hoy */
    var sb2 = psb({ids: idsFromHtml(indexHtml), seed: seed({groups:{g1:{id:'g1',name:'T'}}, trialStart:0})});
    var before = Date.now(); loadApp(sb2);
    var tr = sb2.__lacuotaSub.trial();
    t('sin pagos previos: la prueba arranca hoy', tr>=before && tr<=Date.now());
    /* 11c: sin grupos → no arranca nada */
    var sb3 = psb({ids: idsFromHtml(indexHtml), seed: seed({trialStart:0})});
    loadApp(sb3);
    t('sin grupos: no se inventa prueba', sb3.__lacuotaSub.trial()===0);
    /* 12a: sin suscripción activa → el botón lleva a suscribirse */
    var sb4 = psb({ids: idsFromHtml(indexHtml), seed: seed({
      groups:{g1:{id:'g1',name:'T'}}, trialStart: now-5*DAY, payActive:false })});
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
      groups:{g1:{id:'g1',name:'T'}}, trialStart: now-31*DAY, payActive:false })});
    loadApp(sb6);
    sb6.__lacuotaSub.manage();
    t('prueba vencida: el título dice que terminó',
      sb6.__els.payTitle.textContent==='Tu prueba terminó', sb6.__els.payTitle.textContent);
  }catch(e){ threw = e; }
  t('prueba y suscripción: sin excepción', !threw, threw && threw.message);
})();

Promise.all(asyncTests).then(function(){
  console.log(failures ? ('\n'+failures+' FALLOS') : '\nTODO OK (arranque)');
  process.exit(failures ? 1 : 0);
});

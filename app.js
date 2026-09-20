/* La Cuota — interfaz. Lógica pura en logica.js, nube en nube.js. */
(function(){
'use strict';
var L = window.CuotaLogica;

/* ---------- estado ---------- */
var KEY = 'lacuota_v1';
var S = load();

function load(){
  try{
    var raw = localStorage.getItem(KEY);
    if (raw){ var s = JSON.parse(raw); s.groups=s.groups||{}; s.members=s.members||{}; s.payments=s.payments||{};
      s.payTs=s.payTs||{}; s.delMembers=s.delMembers||{}; s.unpays=s.unpays||{}; return s; }
  }catch(e){}
  return {groups:{}, members:{}, payments:{}, payTs:{}, delMembers:{}, unpays:{}, onboarded:false, trialStart:0, payActive:false, payEmail:'', notifyPay:false, ui:{}};
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
        return CuotaNube.publicar(gid, state);
      }).catch(function(){});
    });
  });
  chain.then(function(){ nubePushing=false; }, function(){ nubePushing=false; });
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

/* ---------- utilidades ---------- */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function initials(name){ var p=String(name||'?').trim().split(/\s+/); return (p[0][0]+(p[1]?p[1][0]:'')).toUpperCase(); }

var toastT=null;
function toast(msg){
  var t=$('toast'); t.textContent=msg; t.hidden=false;
  clearTimeout(toastT); toastT=setTimeout(function(){ t.hidden=true; }, 2600);
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

/* ---------- prueba gratis ---------- */
var TRIAL_DAYS = 30;
function trialDaysLeft(){
  if (!S.trialStart) return TRIAL_DAYS;
  var used = Math.floor((Date.now()-S.trialStart)/86400000);
  return Math.max(0, TRIAL_DAYS-used);
}
function locked(){ return S.trialStart>0 && trialDaysLeft()<=0 && !S.payActive; }

/* ---------- navegación ---------- */
var VIEWS=['v-home','v-group','v-ob','v-members','v-hist','v-pdetail','v-settings','v-faq','v-pay','v-pagook','v-readonly'];
function show(id){
  VIEWS.forEach(function(v){ $(v).hidden = (v!==id); });
  window.scrollTo(0,0);
}

/* ---------- hoja inferior ---------- */
function openSheet(html){
  $('sheet').innerHTML=html; $('sheetWrap').hidden=false;
}
function closeSheet(){ $('sheetWrap').hidden=true; $('sheet').innerHTML=''; }
$('sheetBack').addEventListener('click', closeSheet);

function showTextSheet(txt){
  openSheet('<h3>Cópialo aquí</h3>'+
    '<textarea id="sheetText" rows="8" style="width:100%;font-size:15px;padding:12px;border:1px solid #e9e9ec;border-radius:12px" readonly></textarea>'+
    '<button class="btn-primary btn-block" id="sheetCopy">Copiar</button>');
  $('sheetText').value=txt;
  $('sheetCopy').addEventListener('click', function(){
    $('sheetText').select();
    try{ document.execCommand('copy'); toast('Copiado.'); }catch(e){ toast('Selecciónalo y cópialo.'); }
    closeSheet();
  });
}

/* ---------- INICIO ---------- */
function renderHome(){
  nubeUnwatch();
  show('v-home');
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

  ids.forEach(function(gid){
    var g=S.groups[gid];
    var mk=L.periodKey(new Date(), g);
    var sum=sumFor(gid, mk);
    var b=document.createElement('button');
    b.className='gitem';
    b.innerHTML='<span class="gdot">'+esc(initials(g.name))+'</span>'+
      '<span class="ginfo"><span class="gname">'+esc(g.name)+'</span>'+
      '<span class="gstat">'+sum.countPaid+' de '+sum.countTotal+' pagaron · '+
        (sum.missing>0 ? 'Faltan '+L.fmtMoney(sum.missing,g.currency) : 'Todos pagaron')+'</span></span>'+
      '<span class="gchev">›</span>';
    b.addEventListener('click', function(){ openGroup(gid); });
    list.appendChild(b);
  });
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
    row.innerHTML=
      '<button class="mmain" data-tg="'+m.id+'">'+
        '<span class="avatar">'+esc(initials(m.name))+'</span>'+
        '<span class="minfo"><span class="mname">'+esc(m.name)+'</span>'+
        '<span class="mstat'+(isPaid?' paid':'')+'">'+(isPaid?'Pagó ✓':'Debe '+L.fmtMoney(g.amount,g.currency))+'</span></span>'+
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
    b.addEventListener('click', function(){ togglePay(b.getAttribute('data-tg')); });
  });
  list.querySelectorAll('[data-wa]').forEach(function(b){
    b.addEventListener('click', function(e){ e.stopPropagation(); remindOne(b.getAttribute('data-wa')); });
  });
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
    p[mid]=Date.now();
    delete S.unpays[curGid][curMonth][mid];
    if (!S.trialStart){ S.trialStart=Date.now(); } // la prueba corre desde el primer pago
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
    f.innerHTML='<input id="obIn" type="number" min="1" max="28" inputmode="numeric" placeholder="5" style="margin-top:6px">'+
      '<p class="fine">Del día 1 al 28. La cuota de cada mes se cuenta desde ese día.</p>';
    $('obIn').value=obDraft.cut;
    setTimeout(function(){ $('obIn').focus(); },50);
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
      if(step==='diaMes'){
        var c=parseInt($('obIn').value,10);
        if(!c||c<1||c>28){ toast('Usa un día del 1 al 28.'); return; }
        obDraft.cut=c;
      }
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
  toast('Grupo creado. Agrega a los miembros y toca Terminar.');
  openGroup(g.id);
  setTimeout(openMembers, 600);
}

/* ---------- MIEMBROS ---------- */
function openMembers(){
  var g=S.groups[curGid]; if(!g) return;
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
  $('edSave').addEventListener('click', function(){
    var n=$('edName').value.trim();
    if(!n){ toast('El nombre no puede quedar vacío.'); return; }
    m.name=n; m.phone=L.normPhone($('edPhone').value.trim()); m.updatedAt=Date.now();
    save(); closeSheet(); renderMemList(); toast('Cambios guardados.');
  });
}

/* ---------- HISTORIAL ---------- */
function openHistory(){
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
  w.innerHTML='<label class="flabel">Día de corte del mes</label>'+
    '<input id="setCut" type="number" min="1" max="28" inputmode="numeric">';
  $('setCut').value=g.cutDay||5;
}
function saveSettings(){
  var g=S.groups[curGid]; if(!g) return;
  var f=L.freqOf(g);
  var name=$('setName').value.trim(), amount=parseInt($('setAmount').value,10);
  var cur=$('setCurrency').querySelector('button.on').getAttribute('data-cur');
  if(!name){ toast('El grupo necesita un nombre.'); return; }
  if(!amount||amount<=0){ toast('Revisa el monto.'); return; }
  if(f==='mes'){
    var cut=parseInt($('setCut').value,10);
    if(!cut||cut<1||cut>28){ toast('El día de corte va del 1 al 28.'); return; }
    g.cutDay=cut;
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
   'Tus datos están en este teléfono. La sincronización automática entre teléfonos llega en la próxima versión.'],
  ['¿Se puede cobrar diario o semanal?',
   'Sí. Al crear el grupo eliges la frecuencia: diaria, semanal o mensual.'],
  ['¿Cuánto cuesta?',
   '30 días gratis. Después US$2 al mes o US$20 al año por grupo. Tus datos nunca se borran.']
];
function renderFaq(from){
  show('v-faq');
  var list=$('faqList'); list.innerHTML='';
  FAQS.forEach(function(f){
    var d=document.createElement('div'); d.className='fitem';
    d.innerHTML='<button class="fq"><span>'+esc(f[0])+'</span><span class="chev">›</span></button>'+
      '<div class="fa">'+esc(f[1])+'</div>';
    d.querySelector('.fq').addEventListener('click', function(){ d.classList.toggle('open'); });
    list.appendChild(d);
  });
  $('faqBack').onclick=function(){ if(from==='group') renderGroup(); else renderHome(); };
}

/* ---------- PAYWALL ---------- */
var STRIPE_LINKS = {
  monthly: 'https://buy.stripe.com/28E8wI8AD1iGdK413kbV600',
  yearly:  'https://buy.stripe.com/14AcMYbMP7H45dy5jAbV601'
};
function renderPay(){
  show('v-pay');
}
/* Abre el enlace de pago real de Stripe (modo live) */
function payGo(which){
  S.pendingPlan = which; save();
  window.open(STRIPE_LINKS[which], '_blank');
}
/* Portal del cliente: cancelar, cambiar de plan o actualizar la tarjeta.
   El servidor crea una sesión segura con el correo que pagó en Stripe. */
function manageSub(){
  var email = (S.payEmail || '').trim();
  if(!email){
    email = (window.prompt('Escribe el correo con el que pagaste en Stripe:') || '').trim();
    if(!email || email.indexOf('@') < 0) return;
  }
  toast('Abriendo tu suscripción…');
  /* La pestaña se abre en el gesto del toque: si esperamos a que el
     servidor responda, el bloqueador de ventanas la cancela y "no pasa nada". */
  var w = null;
  try{ w = window.open('about:blank', '_blank'); }catch(e){ w = null; }
  function closeW(){ if(w){ try{ w.close(); }catch(e){} } }
  fetch(PAY_VERIFY_URL + '/portal?email=' + encodeURIComponent(email), {cache:'no-store'})
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(res && res.url){
        if(w && !w.closed){ w.location.href = res.url; }
        else { location.href = res.url; }
      }
      else if(res && res.error === 'not_found'){
        closeW();
        toast('No encontramos una suscripción con ese correo.');
      }else{
        closeW();
        toast('No se pudo abrir. Inténtalo de nuevo.');
      }
    })
    .catch(function(){ closeW(); toast('Sin conexión. Conéctate a internet e inténtalo de nuevo.'); });
}
/* ---------- PAGOS VERIFICADOS (Worker + Stripe) ---------- */
var PAY_VERIFY_URL = 'https://lacuota-pagos.deivyespinosa07.workers.dev';
function payCheck(email){
  return fetch(PAY_VERIFY_URL + '/sub?email=' + encodeURIComponent(email), {cache:'no-store'})
    .then(function(r){ return r.json(); })
    .catch(function(){ return {active:false, offline:true}; });
}
/* Stripe redirige aquí después del pago: #/pago-ok.
   Solo se activa si el verificador confirma un pago real. */
function pagoOk(){
  var plan = (S.pendingPlan==='yearly') ? 'yearly' : 'monthly';
  S.pendingPlan = null; save();
  location.hash='';
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
          ? 'Plan anual activo — $20/año por grupo.'
          : 'Plan mensual activo — $2/mes por grupo.';
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
$('pagoOkGo').addEventListener('click', renderHome);

/* ---------- LEGAL (discreto: solo enlaces en el pie) ---------- */
var LEGAL = {
priv: {
  t: 'Política de privacidad',
  h: '<p class="date">Vigente desde el 20 de septiembre de 2026.</p>'+
  '<h3>Qué datos guardamos</h3>'+
  '<p>Los datos de tu grupo (nombre, miembros, montos y pagos) se guardan en tu teléfono. Son tuyos.</p>'+
  '<p>Si usas el enlace de tesorero para sincronizar entre teléfonos, esos datos se copian a nuestra base de datos en la nube, protegidos por una llave secreta que solo tú tienes. Sin esa llave, nadie puede leerlos.</p>'+
  '<p>Para verificar tu suscripción guardamos tu correo electrónico y el estado de tu pago. Los pagos los procesa Stripe de forma segura: nosotros nunca vemos ni guardamos tu tarjeta.</p>'+
  '<h3>Lo que no hacemos</h3>'+
  '<p>No vendemos tus datos. No mostramos anuncios. No usamos rastreadores de terceros.</p>'+
  '<h3>Tus derechos</h3>'+
  '<p>Puedes borrar los datos de un grupo desde la app cuando quieras. Si quieres que borremos tu correo de nuestros registros, escríbenos a hola@lacuota.org.</p>'+
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
  '<p>30 días gratis por grupo desde que lo creas. Después: $2 USD al mes o $20 USD al año por grupo. Precios en dólares americanos.</p>'+
  '<h3>Pagos</h3>'+
  '<p>Los pagos los procesa Stripe de forma segura. Al pagar también aceptas los términos de Stripe.</p>'+
  '<h3>Cancelación</h3>'+
  '<p>Puedes cancelar cuando quieras desde el enlace de tu recibo de Stripe o escribiéndonos a hola@lacuota.org. Mantienes el acceso hasta que termine el período que ya pagaste. No hay reembolsos por períodos parciales.</p>'+
  '<h3>Tu responsabilidad</h3>'+
  '<p>El enlace de tesorero es tu llave de acceso y tu respaldo: guárdalo bien. Eres responsable de lo que se haga con tus enlaces.</p>'+
  '<h3>Disponibilidad</h3>'+
  '<p>Hacemos todo lo posible por mantener el servicio funcionando, pero no podemos garantizar que nunca falle. Tus datos principales viven en tu teléfono.</p>'+
  '<h3>Cambios</h3>'+
  '<p>Podemos actualizar estos términos; los cambios importantes se avisarán dentro de la app.</p>'+
  '<h3>Contacto y ley aplicable</h3>'+
  '<p>Escríbenos a hola@lacuota.org. Estos términos se rigen por las leyes del estado de Nueva Jersey, EE.&nbsp;UU.</p>'
}};
function showLegal(which){
  var L = LEGAL[which] || LEGAL.priv;
  $('legalTitle').textContent = L.t;
  $('legalBody').innerHTML = L.h;
  show('v-legal');
}
$('legalBack').addEventListener('click', function(){
  if(history.length>1){ history.back(); } else { location.hash=''; renderHome(); }
});

/* ---------- COMPARTIR ---------- */
function baseUrl(){
  return location.origin + location.pathname;
}
function shareSheet(){
  var g=S.groups[curGid];
  var mems=membersOf(curGid);
  var pays=S.payments[curGid]||{};
  var snap=L.encodeSnapshot({
    g:{id:g.id, name:g.name, amount:g.amount, currency:g.currency,
       freq:g.freq, cutDay:g.cutDay, cutWeekday:g.cutWeekday},
    members:mems.map(function(m){ return {id:m.id, name:m.name}; }),
    payments:pays, month:curMonth
  });
  var roLink=baseUrl()+'#/ver/'+snap;
  var edLink=baseUrl()+'#/g/'+g.id;
  openSheet('<h3>Compartir</h3>'+
    '<button class="sopt" id="shRo">👥&nbsp; Copiar enlace de miembros <span style="color:var(--muted);font-size:14px">(solo ven)</span></button>'+
    '<button class="sopt" id="shEd">🔑&nbsp; Copiar enlace de tesorero <span style="color:var(--muted);font-size:14px">(tu respaldo · guárdalo)</span></button>');
  $('shRo').addEventListener('click', function(){
    shareLink(roLink, 'La Cuota — enlace de miembros', 'Enlace copiado. Mándalo a tus miembros.');
    closeSheet();
  });
  $('shEd').addEventListener('click', function(){
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
  var g=S.groups[curGid]; if(!g) return;
  if(!window.jspdf){ toast('No se pudo generar el PDF.'); return; }
  var mems=membersOf(curGid);
  var pm=paidMap(curGid, curMonth);
  var sum=sumFor(curGid, curMonth);
  var doc=new window.jspdf.jsPDF({unit:'mm',format:'a4'});
  var M=14;
  var COLS=[{t:'Miembro',w:58},{t:'Teléfono',w:34},{t:'Estado',w:24},{t:'Monto',w:30},{t:'Fecha de pago',w:36}];
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
    var cells=[m.name, m.phone||'—', ts?'Pagó':'Debe',
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
}

/* ---------- CSV ---------- */
function exportCSV(){
  var g=S.groups[curGid]; if(!g) return;
  var csv=L.buildCSV(g, membersOf(curGid), S.payments[curGid]||{});
  var blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='lacuota_'+g.name.replace(/[^\wáéíóúñü-]+/gi,'_')+'.csv';
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },500);
  toast('Historial descargado.');
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
    '<button class="sopt" id="moSub">💳&nbsp; Administrar suscripción</button>');
  $('moMem').addEventListener('click', function(){ closeSheet(); openMembers(); });
  $('moShare').addEventListener('click', function(){ closeSheet(); shareSheet(); });
  $('moHist').addEventListener('click', function(){ closeSheet(); openHistory(); });
  $('moPdf').addEventListener('click', function(){ closeSheet(); downloadPDF(); });
  $('moCsv').addEventListener('click', function(){ closeSheet(); exportCSV(); });
  $('moSet').addEventListener('click', function(){ closeSheet(); openSettings(); });
  $('moSub').addEventListener('click', function(){ closeSheet(); manageSub(); });
}

/* ---------- eventos ---------- */
$('btnNewGroup').addEventListener('click', function(){ locked()?renderPay():startOnboarding(); });
$('btnFaqHome').addEventListener('click', function(){ renderFaq('home'); });
$('btnBack').addEventListener('click', renderHome);
$('btnMore').addEventListener('click', moreSheet);
$('mPrev').addEventListener('click', function(){ var g=S.groups[curGid]; curMonth=L.prevPeriod(curMonth, g); S.ui['m_'+curGid]=curMonth; save(); renderMonth(); });
$('mNext').addEventListener('click', function(){ var g=S.groups[curGid]; curMonth=L.nextPeriod(curMonth, g); S.ui['m_'+curGid]=curMonth; save(); renderMonth(); });

$('btnRemindAll').addEventListener('click', function(){
  var g=S.groups[curGid];
  var sum=sumFor(curGid, curMonth);
  if(!sum.owed.length){ toast('Todos están al día. 🎉'); return; }
  shareText(L.debtorsText(g, sum, L.periodLabel(curMonth, g)), g.name,
    'Texto copiado. Pégalo en tu grupo de WhatsApp.');
});
$('btnSummary').addEventListener('click', function(){
  var g=S.groups[curGid];
  var sum=sumFor(curGid, curMonth);
  shareText(L.summaryText(g, sum, L.periodLabel(curMonth, g)), g.name,
    'Resumen copiado. Compártelo donde quieras.');
});

$('memBack').addEventListener('click', renderGroup);
$('memAdd').addEventListener('click', addMember);
$('memDone').addEventListener('click', renderGroup);
$('histBack').addEventListener('click', renderGroup);
$('pdBack').addEventListener('click', openHistory);
$('setBack').addEventListener('click', renderGroup);
$('setSave').addEventListener('click', saveSettings);
$('setManageSub').addEventListener('click', manageSub);
$('setDelete').addEventListener('click', function(){
  var b=$('setDelete'), g=S.groups[curGid];
  if(b.dataset.confirm==='1'){
    Object.keys(S.members).forEach(function(k){ if(S.members[k].gid===curGid) delete S.members[k]; });
    var delGid=curGid;
    delete S.payments[curGid]; delete S.payTs[curGid]; delete S.delMembers[curGid]; delete S.unpays[curGid]; delete S.groups[curGid]; save();
    if(nubeLista()) CuotaNube.borrar(delGid);
    renderHome(); toast('Grupo eliminado.');
  }else{ b.dataset.confirm='1'; b.textContent='Toca de nuevo para eliminar'; }
});
$('payMonthly').addEventListener('click', function(){ payGo('monthly'); });
$('payYearly').addEventListener('click', function(){ payGo('yearly'); });
$('payViewData').addEventListener('click', renderHome);
$('payManageSub').addEventListener('click', manageSub);
$('pagoOkManage').addEventListener('click', manageSub);
$('btnManageSub').addEventListener('click', manageSub);
$('roCta').addEventListener('click', function(){ location.hash=''; locked()?renderPay():startOnboarding(); });

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
  $('rcGo').addEventListener('click', function(){
    var raw=( $('rcLink').value||'').trim();
    var m=raw.match(/#\/g\/([A-Za-z0-9_-]+)/);
    var gid=m?m[1]:null;
    if(!gid && /^[A-Za-z0-9_-]{5,}$/.test(raw)) gid=raw;
    if(!gid){ toast('Ese enlace no parece válido.'); return; }
    if(!nubeLista()){ toast('Sin conexión. Revisa tu internet.'); return; }
    closeSheet(); toast('Buscando el grupo…');
    fetchGroupToLocal(gid, function(ok){
      if(ok){ toast('Grupo recuperado. 🎉'); location.hash=''; renderHome(); }
      else toast('No encontramos ese grupo. Revisa el enlace.');
    });
  });
}
$('obRecover').addEventListener('click', recoverSheet);
$('btnRecoverHome').addEventListener('click', recoverSheet);

/* ---------- arranque ---------- */
function route(){
  var h=location.hash||'';
  if(h.indexOf('#/pago-ok')===0){ pagoOk(); return; }
  if(h==='#/privacidad'){ showLegal('priv'); return; }
  if(h==='#/terminos'){ showLegal('term'); return; }
  if(h.indexOf('#/ver/')===0){ showReadonly(h.slice(6)); return; }
  if(h.indexOf('#/g/')===0){
    var gid=h.slice(4);
    if(S.groups[gid]){ openGroup(gid); return; }
    if(nubeLista()){
      toast('Buscando el grupo…');
      CuotaNube.obtener(gid).then(function(remote){
        if(remote && remote.migratedTo){
          location.hash='#/g/'+remote.migratedTo; route(); return;
        }
        if(remote && remote.meta){
          L.applySnapshot(S, gid, remote); S.onboarded=true;
          limpiarLegados(gid); save(); openGroup(gid);
        }else{ toast('No se encontró ese grupo.'); renderHome(); }
      });
      return;
    }
  }
  if(!S.onboarded && Object.keys(S.groups).length===0){ startOnboarding(); return; }
  renderHome();
}
if('serviceWorker' in navigator){
  window.addEventListener('load', function(){
    /* updateViaCache:'none': el chequeo de actualización IGNORA la caché HTTP.
       Sin esto, GitHub Pages sirve sw.js con max-age=4h y el teléfono puede
       tardar horas en descubrir una versión nueva aunque la pida. */
    navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).catch(function(){});
  });
}
/* ---------- ACTUALIZACIONES AUTOMÁTICAS ----------
   La app se actualiza sola, el usuario no tiene que hacer nada: al arrancar
   (y cada 5 minutos, y al volver del fondo) compara su versión con
   version.json del servidor. Si hay una más nueva, le pide al service
   worker que se actualice y recarga cuando el nuevo toma el control. */
var APP_V = 32;
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
  navigator.serviceWorker.addEventListener('controllerchange', function(){
    if(sessionStorage.getItem('lacuota_upd')) return;
    sessionStorage.setItem('lacuota_upd','1');
    location.reload();
  });
}
document.addEventListener('visibilitychange', function(){
  if(!document.hidden) checkAppUpdate();
});
setInterval(checkAppUpdate, 5*60*1000);
route();
paintVer();
checkAppUpdate();
/* Re-verificar la suscripción en silencio al arrancar: si Stripe dice que
   ya no está activa, se desactiva sola (nadie la mantiene a mano). */
if(S.payActive && S.payEmail){
  payCheck(S.payEmail).then(function(res){
    if(res && !res.offline && !res.active){
      S.payActive = false; save(); route();
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
}
})();

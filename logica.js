/* La Cuota — lógica pura (sin DOM ni almacenamiento).
   Se usa en el navegador y se prueba en node. */
'use strict';
(function (root) {
  var L = {};

  var MESES = ['enero','febrero','marzo','abril','mayo','junio','julio',
               'agosto','septiembre','octubre','noviembre','diciembre'];

  var DIAS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseKeyDate(s) {
    var p = String(s).split('-');
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }
  function addDays(d, n) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  // Frecuencia del grupo: 'dia' | 'semana' | 'mes'. Los grupos viejos son 'mes'.
  L.freqOf = function (g) {
    var f = (g && g.freq) || 'mes';
    return (f === 'dia' || f === 'semana' || f === 'mes') ? f : 'mes';
  };

  // Clave del período que contiene `date`.
  // mes: "YYYY-MM" (corte=1 -> mes calendario; corte=15 -> del 15 al 14).
  // semana: "sYYYY-MM-DD" del día de cierre (cutWeekday 0=domingo..6=sábado);
  // la clave es el cierre de la semana que contiene la fecha (lunes..domingo si cierra domingo).
  // dia: "dYYYY-MM-DD".
  L.periodKey = function (date, g) {
    var f = L.freqOf(g);
    if (f === 'dia') return 'd' + dateKey(date);
    if (f === 'semana') {
      var wd = Math.min(Math.max(parseInt(g && g.cutWeekday, 10) || 0, 0), 6);
      var d = addDays(date, (wd - date.getDay() + 7) % 7);
      return 's' + dateKey(d);
    }
    var c = Math.min(Math.max(parseInt(g && g.cutDay, 10) || 1, 1), 28);
    var y = date.getFullYear(), m = date.getMonth();
    if (date.getDate() < c) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
    return y + '-' + pad2(m + 1);
  };

  // Clave del período anterior / siguiente.
  L.prevPeriod = function (key, g) {
    var f = L.freqOf(g), k = String(key);
    if (f === 'dia' || k.charAt(0) === 'd') return 'd' + dateKey(addDays(parseKeyDate(k.slice(1)), -1));
    if (f === 'semana' || k.charAt(0) === 's') return 's' + dateKey(addDays(parseKeyDate(k.slice(1)), -7));
    var p = k.split('-'), y = parseInt(p[0], 10), m = parseInt(p[1], 10);
    m -= 1; if (m < 1) { m = 12; y -= 1; }
    return y + '-' + pad2(m);
  };
  L.nextPeriod = function (key, g) {
    var f = L.freqOf(g), k = String(key);
    if (f === 'dia' || k.charAt(0) === 'd') return 'd' + dateKey(addDays(parseKeyDate(k.slice(1)), 1));
    if (f === 'semana' || k.charAt(0) === 's') return 's' + dateKey(addDays(parseKeyDate(k.slice(1)), 7));
    var p = k.split('-'), y = parseInt(p[0], 10), m = parseInt(p[1], 10);
    m += 1; if (m > 12) { m = 1; y += 1; }
    return y + '-' + pad2(m);
  };

  // Etiqueta legible del período.
  L.periodLabel = function (key, g) {
    var k = String(key || '');
    if (k.charAt(0) === 'd') {
      var d = parseKeyDate(k.slice(1));
      if (dateKey(d) === dateKey(new Date())) return 'Hoy';
      return DIAS[d.getDay()] + ', ' + d.getDate() + ' de ' + MESES[d.getMonth()] + ' de ' + d.getFullYear();
    }
    if (k.charAt(0) === 's') {
      var c = parseKeyDate(k.slice(1)), ini = addDays(c, -6);
      if (ini.getMonth() === c.getMonth())
        return 'Semana del ' + ini.getDate() + ' al ' + c.getDate() + ' de ' + MESES[c.getMonth()];
      return 'Semana del ' + ini.getDate() + ' de ' + MESES[ini.getMonth()] +
        ' al ' + c.getDate() + ' de ' + MESES[c.getMonth()];
    }
    var p = k.split('-'), m = parseInt(p[1], 10);
    if (!p[0] || !m || m < 1 || m > 12) return k;
    return MESES[m - 1] + ' de ' + p[0];
  };

  // "Mensual · corte día 5" / "Semanal · cierra domingo" / "Diaria"
  L.freqLabel = function (g) {
    var f = L.freqOf(g);
    if (f === 'dia') return 'Diaria';
    if (f === 'semana')
      return 'Semanal · cierra ' + DIAS[Math.min(Math.max(parseInt(g.cutWeekday, 10) || 0, 0), 6)];
    return 'Mensual · corte día ' + Math.min(Math.max(parseInt(g.cutDay, 10) || 1, 1), 28);
  };

  L.fmtMoney = function (n, currency) {
    n = Math.round(Number(n) || 0);
    var s = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (currency === 'USD' ? 'US$' : 'RD$') + s;
  };

  // Deja solo dígitos; si tiene 10 dígitos asume RD sin código país y agrega 1.
  L.normPhone = function (p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.length === 10) d = '1' + d;
    if (d.length === 11 && d.charAt(0) === '1') return d;
    return d; // cualquier otro largo se devuelve tal cual
  };

  L.waLink = function (phone, text) {
    return 'https://wa.me/' + L.normPhone(phone) + '?text=' + encodeURIComponent(text);
  };

  // Resumen del período: quién pagó / quién debe + totales.
  // paidMap: { memberId: timestamp }
  L.monthSummary = function (group, members, paidMap) {
    members = members || []; paidMap = paidMap || {};
    var paid = [], owed = [];
    members.forEach(function (m) {
      if (paidMap[m.id]) paid.push(m); else owed.push(m);
    });
    var amount = Number(group.amount) || 0;
    return {
      paid: paid, owed: owed,
      countPaid: paid.length, countTotal: members.length,
      amount: amount, currency: group.currency,
      collected: paid.length * amount,
      missing: owed.length * amount,
      total: members.length * amount
    };
  };

  L.reminderText = function (member, group, label) {
    return 'Hola ' + member.name + ', te escribe el tesorero de ' + group.name +
      '. Te recuerdo la cuota de ' + label + ': ' +
      L.fmtMoney(group.amount, group.currency) +
      '. ¡Gracias por estar al día!';
  };

  L.debtorsText = function (group, summary, label) {
    var lines = ['*' + group.name + '* — cuota de ' + label,
      'Cuota: ' + L.fmtMoney(summary.amount, summary.currency) + ' por miembro', ''];
    if (summary.owed.length) {
      lines.push('Pendientes (' + summary.owed.length + '):');
      summary.owed.forEach(function (m) { lines.push('• ' + m.name); });
    } else {
      lines.push('¡Todos al día! 🎉');
    }
    lines.push('', 'Organizado con La Cuota');
    return lines.join('\n');
  };

  L.summaryText = function (group, summary, label) {
    var fm = function (n) { return L.fmtMoney(n, summary.currency); };
    var lines = ['*' + group.name + '* — Cuota de ' + label,
      'Cuota: ' + fm(summary.amount) + ' por miembro', ''];
    lines.push('✅ Pagaron (' + summary.countPaid + '):');
    if (summary.paid.length) summary.paid.forEach(function (m) { lines.push('• ' + m.name); });
    else lines.push('• —');
    lines.push('', '❌ Deben (' + summary.owed.length + '):');
    if (summary.owed.length) summary.owed.forEach(function (m) { lines.push('• ' + m.name); });
    else lines.push('• —');
    lines.push('',
      'Recaudado: ' + fm(summary.collected) + ' de ' + fm(summary.total),
      'Faltan: ' + fm(summary.missing),
      '', 'Organizado con La Cuota');
    return lines.join('\n');
  };

  function csvEsc(v) {
    v = String(v == null ? '' : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  // CSV con todo el historial del grupo.
  // payments: { "YYYY-MM": { memberId: ts } }
  L.buildCSV = function (group, members, payments) {
    var rows = [['Grupo', 'Miembro', 'Teléfono', 'Período', 'Estado', 'Fecha de pago']];
    var byId = {};
    (members || []).forEach(function (m) { byId[m.id] = m; });
    Object.keys(payments || {}).sort().forEach(function (per) {
      var map = payments[per] || {};
      (members || []).forEach(function (m) {
        var ts = map[m.id];
        rows.push([group.name, m.name, m.phone || '', L.periodLabel(per, group),
          ts ? 'Pagó' : 'Debe',
          ts ? new Date(ts).toLocaleDateString('es-DO') : '']);
      });
    });
    return rows.map(function (r) { return r.map(csvEsc).join(','); }).join('\n');
  };

  L.uid = function (prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) +
      Math.floor(Math.random() * 1e6).toString(36);
  };

  /* Identificador de grupo con llave: id_<base>_<secreto de 128 bits>.
     La dirección completa en la nube ES la llave: sin ella no se puede
     leer ni escribir el grupo. */
  L.gidNuevo = function () {
    var c = '0123456789abcdef', s = '';
    for (var i = 0; i < 32; i++) s += c[(Math.random() * 16) | 0];
    return 'id_' + Date.now().toString(36) +
      Math.floor(Math.random() * 1e6).toString(36) + '_' + s;
  };

  /* Grupos creados antes de la llave (formato id_<base> sin secreto) */
  L.esLegado = function (gid) {
    return !/^id_[a-z0-9]+_[0-9a-f]{32}$/.test(gid || '');
  };

  L.token = function () {
    var c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
    for (var i = 0; i < 12; i++) s += c[(Math.random() * c.length) | 0];
    return s;
  };

  function b64urlEncode(str) {
    var b64 = typeof btoa !== 'undefined'
      ? btoa(unescape(encodeURIComponent(str)))
      : Buffer.from(str, 'utf8').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = typeof atob !== 'undefined' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    return decodeURIComponent(escape(bin));
  }

  // Foto de solo-lectura para el enlace compartible de miembros.
  L.encodeSnapshot = function (snap) { return b64urlEncode(JSON.stringify(snap)); };
  L.decodeSnapshot = function (s) {
    try { return JSON.parse(b64urlDecode(s)); } catch (e) { return null; }
  };

  /* ---------- SINCRONIZACIÓN EN LA NUBE ---------- */
  // Foto sincronizable del grupo: meta + miembros + pagos + marcas de tiempo.
  L.groupSnapshot = function (S, gid) {
    var g = (S.groups || {})[gid] || {};
    var members = {}, pays = {}, payTs = {}, dels = {}, unp = {};
    Object.keys(S.members || {}).forEach(function (mid) {
      var m = S.members[mid];
      if (m && m.gid === gid) members[mid] = { id: m.id, gid: gid, name: m.name, phone: m.phone || '', createdAt: m.createdAt || 0, updatedAt: m.updatedAt || m.createdAt || 0 };
    });
    Object.keys((S.payments || {})[gid] || {}).forEach(function (k) { pays[k] = S.payments[gid][k]; });
    Object.keys((S.payTs || {})[gid] || {}).forEach(function (k) { payTs[k] = S.payTs[gid][k]; });
    Object.keys((S.delMembers || {})[gid] || {}).forEach(function (k) { dels[k] = S.delMembers[gid][k]; });
    Object.keys((S.unpays || {})[gid] || {}).forEach(function (k) { unp[k] = S.unpays[gid][k]; });
    return {
      meta: { id: gid, name: g.name || '', amount: g.amount || 0, currency: g.currency || 'RD$',
              freq: L.freqOf(g), cutDay: g.cutDay || 1, cutWeekday: (g.cutWeekday == null ? 0 : g.cutWeekday),
              createdAt: g.createdAt || 0, updatedAt: g.updatedAt || g.createdAt || 0,
              /* La prueba gratis viaja con el grupo: borrar la app o el caché
                 no la reinicia, porque la nube recuerda cuándo empezó. */
              trialStart: (S.trialStart || 0) },
      members: members, payments: pays, payTs: payTs, delMembers: dels, unpays: unp
    };
  };

  // Escribe una foto (local o fusionada) dentro del estado S.
  L.applySnapshot = function (S, gid, st) {
    S.groups = S.groups || {}; S.members = S.members || {};
    S.payments = S.payments || {}; S.payTs = S.payTs || {}; S.delMembers = S.delMembers || {}; S.unpays = S.unpays || {};
    S.groups[gid] = st.meta;
    /* La prueba adopta la fecha MÁS VIEJA conocida (local o nube).
       Así ni borrando datos ni reinstalando se consigue otra prueba. */
    var rt = (st.meta || {}).trialStart || 0;
    if (rt && (!S.trialStart || rt < S.trialStart)) S.trialStart = rt;
    Object.keys(S.members).forEach(function (mid) { if (S.members[mid] && S.members[mid].gid === gid) delete S.members[mid]; });
    Object.keys(st.members || {}).forEach(function (mid) { S.members[mid] = st.members[mid]; });
    S.payments[gid] = st.payments || {};
    S.payTs[gid] = st.payTs || {};
    S.delMembers[gid] = st.delMembers || {};
    S.unpays[gid] = st.unpays || {};
  };

  function maxTs(a, b) { return Math.max(a || 0, b || 0); }
  // El menor valor positivo: la prueba que empezó primero es la que vale.
  function minPos(a, b) { a = a || 0; b = b || 0; if (a && b) return a < b ? a : b; return a || b; }

  // Fusiona foto local con foto remota. Gana lo más reciente por campo.
  // Devuelve {state, changed}.
  L.mergeGroup = function (local, remote) {
    if (!remote || !remote.meta) return { state: local, changed: false };
    if (!local || !local.meta) return { state: remote, changed: true };
    var changed = false;
    var meta = (remote.meta.updatedAt || 0) > (local.meta.updatedAt || 0) ? remote.meta : local.meta;
    if (meta !== local.meta) changed = true;
    // La prueba NUNCA se extiende al fusionar: gana la fecha más vieja.
    var mt = minPos((local.meta || {}).trialStart, (remote.meta || {}).trialStart);
    if (mt && mt !== (meta.trialStart || 0)) {
      var nm = {};
      Object.keys(meta).forEach(function (k) { nm[k] = meta[k]; });
      nm.trialStart = mt; meta = nm;
    }
    var members = {}, dels = {};
    var ids = {};
    Object.keys(local.members || {}).forEach(function (id) { ids[id] = 1; });
    Object.keys(remote.members || {}).forEach(function (id) { ids[id] = 1; });
    Object.keys(ids).forEach(function (id) {
      var lm = (local.members || {})[id], rm = (remote.members || {})[id];
      var dt = maxTs((local.delMembers || {})[id], (remote.delMembers || {})[id]);
      if (dt) dels[id] = dt;
      var m = null;
      if (lm && rm) m = (rm.updatedAt || 0) >= (lm.updatedAt || 0) ? rm : lm;
      else m = rm || lm;
      if (m && dt >= (m.updatedAt || 0) && dt > 0) m = null; // borrado gana
      if (m) members[id] = m;
    });
    var pays = {}, payTs = {}, unpays = {};
    var periods = {};
    Object.keys(local.payments || {}).forEach(function (k) { periods[k] = 1; });
    Object.keys(remote.payments || {}).forEach(function (k) { periods[k] = 1; });
    Object.keys(local.unpays || {}).forEach(function (k) { periods[k] = 1; });
    Object.keys(remote.unpays || {}).forEach(function (k) { periods[k] = 1; });
    Object.keys(periods).forEach(function (k) {
      // Fusión por miembro: cada "pagó" y cada "deshacer" tiene su hora.
      // Gana lo más reciente por miembro, así dos teléfonos pueden marcar
      // a la vez sin borrarse entre sí.
      var lp = (local.payments || {})[k] || {}, rp = (remote.payments || {})[k] || {};
      var lu = (local.unpays || {})[k] || {}, ru = (remote.unpays || {})[k] || {};
      var u = {}, uu = {}, mids = {}, maxts = 0;
      [lp, rp, lu, ru].forEach(function (o) { Object.keys(o).forEach(function (mid) { mids[mid] = 1; }); });
      Object.keys(mids).forEach(function (mid) {
        var pts = maxTs(lp[mid], rp[mid]); // último "pagó"
        var uts = maxTs(lu[mid], ru[mid]); // último "deshacer"
        if (pts > uts) u[mid] = pts;
        else if (uts > 0) uu[mid] = uts;
        if (pts > maxts) maxts = pts;
        if (uts > maxts) maxts = uts;
      });
      pays[k] = u;
      if (Object.keys(uu).length) unpays[k] = uu; // no guardar períodos vacíos
      payTs[k] = Math.max((local.payTs || {})[k] || 0, (remote.payTs || {})[k] || 0, maxts);
    });
    var state = { meta: meta, members: members, payments: pays, payTs: payTs, delMembers: dels, unpays: unpays };
    if (!changed && JSON.stringify(state) !== JSON.stringify(local)) changed = true;
    return { state: state, changed: changed };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  else root.CuotaLogica = L;
})(typeof self !== 'undefined' ? self : this);

/* La Cuota — lógica pura (sin DOM ni almacenamiento).
   Se usa en el navegador y se prueba en node. */
'use strict';
(function (root) {
  var L = {};

  var MESES = ['enero','febrero','marzo','abril','mayo','junio','julio',
               'agosto','septiembre','octubre','noviembre','diciembre'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Clave "YYYY-MM" del período que contiene `date`, dado el día de corte (1-28).
  // corte=1 -> mes calendario. corte=15 -> del 15 al 14 del mes siguiente.
  L.periodKey = function (date, cutDay) {
    var c = Math.min(Math.max(parseInt(cutDay, 10) || 1, 1), 28);
    var y = date.getFullYear(), m = date.getMonth();
    if (date.getDate() < c) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
    return y + '-' + pad2(m + 1);
  };

  // "2026-09" -> "septiembre de 2026"
  L.periodLabel = function (key) {
    var p = String(key || '').split('-');
    var m = parseInt(p[1], 10);
    if (!p[0] || !m || m < 1 || m > 12) return String(key || '');
    return MESES[m - 1] + ' de ' + p[0];
  };

  // Clave del período anterior a "YYYY-MM"
  L.prevPeriod = function (key) {
    var p = String(key).split('-'), y = parseInt(p[0], 10), m = parseInt(p[1], 10);
    m -= 1; if (m < 1) { m = 12; y -= 1; }
    return y + '-' + pad2(m);
  };

  // Clave del período siguiente
  L.nextPeriod = function (key) {
    var p = String(key).split('-'), y = parseInt(p[0], 10), m = parseInt(p[1], 10);
    m += 1; if (m > 12) { m = 1; y += 1; }
    return y + '-' + pad2(m);
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
        rows.push([group.name, m.name, m.phone || '', L.periodLabel(per),
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

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  else root.CuotaLogica = L;
})(typeof self !== 'undefined' ? self : this);

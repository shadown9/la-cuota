/* Pruebas de logica.js — La Cuota (alineadas a la API real) */
var L = require('/home/hatch/workspace/la_cuota/logica.js');
var ok = 0, bad = 0;
function eq(a, b, name){
  var sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb){ ok++; }
  else { bad++; console.log('FALLA:', name, '\n  esperado:', sb, '\n  real:    ', sa); }
}
function t(cond, name){ if (cond) ok++; else { bad++; console.log('FALLA:', name); } }

/* --- períodos --- */
eq(L.periodKey(new Date(2026, 8, 20), 5), '2026-09', 'periodKey sep, corte 5');
eq(L.periodKey(new Date(2026, 8, 3), 5), '2026-08', 'periodKey antes del corte');
eq(L.periodKey(new Date(2026, 8, 5), 5), '2026-09', 'periodKey día exacto del corte');
eq(L.periodKey(new Date(2026, 0, 2), 5), '2025-12', 'periodKey cruza año');
eq(L.prevPeriod('2026-09'), '2026-08', 'prevPeriod');
eq(L.prevPeriod('2026-01'), '2025-12', 'prevPeriod año');
eq(L.nextPeriod('2026-12'), '2027-01', 'nextPeriod año');
eq(L.periodLabel('2026-09'), 'septiembre de 2026', 'periodLabel');

/* --- dinero --- */
eq(L.fmtMoney(500, 'RD$'), 'RD$500', 'fmtMoney RD$');
eq(L.fmtMoney(5000, 'RD$'), 'RD$5,000', 'fmtMoney miles RD$');
eq(L.fmtMoney(2, 'USD'), 'US$2', 'fmtMoney USD');
eq(L.fmtMoney(20, 'USD'), 'US$20', 'fmtMoney USD 20');

/* --- teléfonos / WhatsApp --- */
eq(L.normPhone('809-555-1234'), '18095551234', 'normPhone RD con guiones');
eq(L.normPhone('+1 (809) 555-1234'), '18095551234', 'normPhone con +1');
eq(L.normPhone(''), '', 'normPhone vacío');
t(L.waLink('18095551234', 'hola').indexOf('https://wa.me/18095551234?text=') === 0, 'waLink forma');

/* --- escenario del tesorero: Junta de Vecinos Los Prados --- */
var g = {id: 'g1', name: 'Junta de Vecinos Los Prados', amount: 500, currency: 'RD$', cutDay: 5};
var mems = [];
for (var i = 1; i <= 10; i++) mems.push({id: 'm' + i, gid: 'g1', name: 'Miembro ' + i, phone: '1809555000' + i});
// pagan 6, deben 4
var pays = {'2026-09': {}};
['m1','m2','m3','m4','m5','m6'].forEach(function(id){ pays['2026-09'][id] = Date.now(); });
var sum = L.monthSummary(g, mems, pays['2026-09']);
eq(sum.countPaid, 6, 'pagaron 6');
eq(sum.countTotal, 10, 'total 10');
eq(sum.collected, 3000, 'recaudado = 6×500 = 3000');
eq(sum.total, 5000, 'esperado = 10×500 = 5000');
eq(sum.missing, 2000, 'faltante = 4×500 = 2000');
eq(sum.collected + sum.missing, sum.total, 'recaudado + faltante = esperado');
eq(sum.paid.length, 6, 'lista paid');
eq(sum.owed.length, 4, 'lista owed');

/* --- textos --- */
var rt = L.reminderText(mems[6], g, L.periodLabel('2026-09'));
t(rt.indexOf('Miembro 7') >= 0 && rt.indexOf('RD$500') >= 0 && rt.indexOf('septiembre de 2026') >= 0, 'reminderText: ' + rt);
var dt = L.debtorsText(g, sum, L.periodLabel('2026-09'));
t(dt.indexOf('Miembro 7') >= 0 && dt.indexOf('Miembro 10') >= 0 && dt.indexOf('Pendientes (4)') >= 0, 'debtorsText');
var st = L.summaryText(g, sum, L.periodLabel('2026-09'));
t(st.indexOf('RD$3,000') >= 0 && st.indexOf('RD$2,000') >= 0 && st.indexOf('RD$5,000') >= 0, 'summaryText números');

/* --- CSV --- */
var csv = L.buildCSV(g, mems, pays);
var lines = csv.trim().split('\n');
eq(lines.length, 11, 'CSV: encabezado + 10 filas');
t(lines[0] === 'Grupo,Miembro,Teléfono,Período,Estado,Fecha de pago', 'CSV encabezado: ' + lines[0]);
t(csv.indexOf('Pagó') >= 0 && csv.indexOf('Debe') >= 0, 'CSV estados');
t(csv.indexOf('septiembre de 2026') >= 0, 'CSV período');

/* --- snapshot solo lectura --- */
var snapObj = {g: g, members: mems.map(function(m){ return {id: m.id, name: m.name}; }), payments: pays, month: '2026-09'};
var snap = L.encodeSnapshot(snapObj);
t(typeof snap === 'string' && snap.length > 50 && snap.indexOf('/') < 0 && snap.indexOf('+') < 0, 'encodeSnapshot url-safe');
var back = L.decodeSnapshot(snap);
eq(back.g.name, g.name, 'decodeSnapshot grupo');
eq(back.month, '2026-09', 'decodeSnapshot mes');
eq(back.members.length, 10, 'decodeSnapshot 10 miembros');
t(back.payments['2026-09'].m1 > 0, 'decodeSnapshot pagos');
t(L.decodeSnapshot('!!!no-valido!!!') === null, 'decodeSnapshot inválido → null');
// el resumen se puede reconstruir solo con el snapshot
var rsum = L.monthSummary(back.g, back.members, back.payments[back.month]);
eq(rsum.collected, 3000, 'snapshot → resumen reconstruido');

/* --- ids --- */
var u1 = L.uid(), u2 = L.uid();
t(u1 !== u2 && u1.length >= 8, 'uid únicos');
t(L.token().length === 12, 'token 12 chars');

console.log('\n' + ok + ' pasadas, ' + bad + ' falladas.');
process.exit(bad ? 1 : 0);

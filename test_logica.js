/* Pruebas de logica.js — La Cuota (alineadas a la API real) */
var L = require('./logica.js');
var ok = 0, bad = 0;
function eq(a, b, name){
  var sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb){ ok++; }
  else { bad++; console.log('FALLA:', name, '\n  esperado:', sb, '\n  real:    ', sa); }
}
function t(cond, name){ if (cond) ok++; else { bad++; console.log('FALLA:', name); } }

/* --- períodos --- */
var gm={freq:'mes',cutDay:5}, gs={freq:'semana',cutWeekday:0}, gd={freq:'dia'};
eq(L.freqOf({}), 'mes', 'freqOf por defecto es mes');
eq(L.freqOf({freq:'semana'}), 'semana', 'freqOf respeta grupo');
eq(L.periodKey(new Date(2026, 8, 20), gm), '2026-09', 'mensual sep, corte 5');
eq(L.periodKey(new Date(2026, 8, 3), gm), '2026-08', 'mensual antes del corte');
eq(L.periodKey(new Date(2026, 8, 5), gm), '2026-09', 'mensual día exacto del corte');
eq(L.periodKey(new Date(2026, 0, 2), gm), '2025-12', 'mensual cruza año');
eq(L.periodKey(new Date(2026, 8, 20), {}), '2026-09', 'grupo viejo sin freq = mensual');
eq(L.periodKey(new Date(2026, 8, 20), gd), 'd2026-09-20', 'diaria');
eq(L.periodKey(new Date(2026, 11, 31), gd), 'd2026-12-31', 'diaria fin de año');
eq(L.periodKey(new Date(2026, 8, 20), gs), 's2026-09-20', 'semanal: domingo 20 cierra el 20');
eq(L.periodKey(new Date(2026, 8, 19), gs), 's2026-09-20', 'semanal: sábado 19 cierra domingo 20');
eq(L.periodKey(new Date(2026, 8, 21), gs), 's2026-09-27', 'semanal: lunes 21 abre semana que cierra 27');
eq(L.periodKey(new Date(2026, 8, 26), gs), 's2026-09-27', 'semanal: sábado 26 cierra domingo 27');
eq(L.periodKey(new Date(2026, 8, 19), {freq:'semana',cutWeekday:5}), 's2026-09-25', 'semanal: sábado 19 con cierre viernes -> viernes 25');
eq(L.periodKey(new Date(2026, 8, 23), {freq:'semana',cutWeekday:3}), 's2026-09-23', 'semanal: miércoles 23 cierra miércoles 23');
eq(L.periodKey(new Date(2026, 8, 24), {freq:'semana',cutWeekday:3}), 's2026-09-30', 'semanal: jueves 24 cierra miércoles 30');
eq(L.prevPeriod('2026-09', gm), '2026-08', 'prevPeriod mensual');
eq(L.prevPeriod('2026-01', gm), '2025-12', 'prevPeriod mensual año');
eq(L.nextPeriod('2026-12', gm), '2027-01', 'nextPeriod mensual año');
eq(L.prevPeriod('d2026-09-01', gd), 'd2026-08-31', 'prevPeriod diaria cruza mes');
eq(L.nextPeriod('d2026-12-31', gd), 'd2027-01-01', 'nextPeriod diaria cruza año');
eq(L.prevPeriod('s2026-09-20', gs), 's2026-09-13', 'prevPeriod semanal');
eq(L.nextPeriod('s2026-09-20', gs), 's2026-09-27', 'nextPeriod semanal');
eq(L.periodLabel('2026-09', gm), 'septiembre de 2026', 'periodLabel mensual');
eq(L.periodLabel('d2026-05-04', gd), 'lunes, 4 de mayo de 2026', 'periodLabel diaria');
eq(L.periodLabel('s2026-09-20', gs), 'Semana del 14 al 20 de septiembre', 'periodLabel semanal');
eq(L.periodLabel('s2026-10-04', gs), 'Semana del 28 de septiembre al 4 de octubre', 'periodLabel semanal cruza mes');
eq(L.freqLabel(gm), 'Mensual · corte día 5', 'freqLabel mensual');
eq(L.freqLabel(gs), 'Semanal · cierra domingo', 'freqLabel semanal');
eq(L.freqLabel(gd), 'Diaria', 'freqLabel diaria');
eq(L.freqLabel({}), 'Mensual · corte día 1', 'freqLabel grupo viejo');

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
var rt = L.reminderText(mems[6], g, L.periodLabel('2026-09', g));
t(rt.indexOf('Miembro 7') >= 0 && rt.indexOf('RD$500') >= 0 && rt.indexOf('septiembre de 2026') >= 0, 'reminderText: ' + rt);
var dt = L.debtorsText(g, sum, L.periodLabel('2026-09', g));
t(dt.indexOf('Miembro 7') >= 0 && dt.indexOf('Miembro 10') >= 0 && dt.indexOf('Pendientes (4)') >= 0, 'debtorsText');
var st = L.summaryText(g, sum, L.periodLabel('2026-09', g));
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

/* --- sincronización --- */
function mkS(){
  return { groups:{g1:{id:'g1',name:'Junta',amount:25,currency:'RD$',freq:'semana',cutWeekday:0,createdAt:100,updatedAt:100}},
    members:{m1:{id:'m1',gid:'g1',name:'Ana',phone:'1',createdAt:100,updatedAt:100}},
    payments:{g1:{s1:{m1:50}}}, payTs:{g1:{s1:60}}, delMembers:{}, ui:{} };
}
var s1=mkS(), snap1=L.groupSnapshot(s1,'g1');
eq(snap1.meta.name, 'Junta', 'snapshot: meta');
eq(snap1.members.m1.name, 'Ana', 'snapshot: miembro');
eq(snap1.payTs.s1, 60, 'snapshot: payTs');
var mNone=L.mergeGroup(snap1, null);
t(mNone.changed===false, 'merge: sin remoto no cambia');
var mNew=L.mergeGroup(null, snap1);
t(mNew.changed===true && mNew.state.meta.name==='Junta', 'merge: sin local toma remoto');
// remoto más nuevo en meta gana
var s2=mkS(); s2.groups.g1.name='Junta Nueva'; s2.groups.g1.updatedAt=200;
var mMeta=L.mergeGroup(snap1, L.groupSnapshot(s2,'g1'));
t(mMeta.changed && mMeta.state.meta.name==='Junta Nueva', 'merge: meta remota más nueva gana');
// local más nuevo en meta gana
var mMeta2=L.mergeGroup(L.groupSnapshot(s2,'g1'), snap1);
t(mMeta2.state.meta.name==='Junta Nueva' && !mMeta2.changed, 'merge: meta local más nueva se conserva');
// miembros: unión, gana el más reciente por miembro
var s3=mkS(); s3.members.m1.name='Ana María'; s3.members.m1.updatedAt=300;
s3.members.m2={id:'m2',gid:'g1',name:'Luis',phone:'',createdAt:300,updatedAt:300};
var mMem=L.mergeGroup(snap1, L.groupSnapshot(s3,'g1'));
t(mMem.state.members.m1.name==='Ana María' && mMem.state.members.m2.name==='Luis', 'merge: miembros se unen y gana el reciente');
// borrado (tombstone) gana sobre edición vieja
var s4=mkS(); s4.delMembers={g1:{m1:400}}; delete s4.members.m1;
var mDel=L.mergeGroup(snap1, L.groupSnapshot(s4,'g1'));
t(!mDel.state.members.m1 && mDel.state.delMembers.m1===400, 'merge: borrado remoto elimina miembro');
// pagos: gana el período con payTs mayor
var s5=mkS(); s5.payments={g1:{s1:{}}}; s5.payTs={g1:{s1:500}};
var mPay=L.mergeGroup(snap1, L.groupSnapshot(s5,'g1'));
t(Object.keys(mPay.state.payments.s1).length===0, 'merge: pagos remotos más nuevos ganan');
// applySnapshot escribe todo en S
var s6={groups:{},members:{m9:{id:'m9',gid:'g1',name:'Viejo'}},payments:{},payTs:{},delMembers:{},ui:{}};
L.applySnapshot(s6,'g1',snap1);
t(s6.groups.g1.name==='Junta' && s6.members.m1 && !s6.members.m9 && s6.payments.g1.s1.m1===50, 'applySnapshot escribe estado');

console.log('\n' + ok + ' pasadas, ' + bad + ' falladas.');
process.exit(bad ? 1 : 0);

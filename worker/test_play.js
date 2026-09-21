/* La Cuota — pruebas de Google Play Billing (worker).
   1) playEvalSubscription: interpreta la respuesta de subscriptionsv2
      (activa, en gracia, vencida, en espera, sin reconocer, plan correcto).
   2) playAccessToken: flujo JWT de cuenta de servicio con fetch simulado;
      verifica forma del JWT y el grant_type correcto.
   3) Endpoints /play-verify y /play-sub con la API de Google simulada:
      verificación, acknowledge, atado al sub, re-verificación en /play-sub,
      rechazo de datos malos.
   Ejecutar: node worker/test_play.js */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const DIR = __dirname;
let failures = 0, count = 0;
function t(name, cond, extra) {
  count++;
  if (cond) { console.log('ok   ' + name); }
  else { failures++; console.log('FALLO ' + name + (extra ? ' — ' + extra : '')); }
}
function b64urlJson(s) {
  return Buffer.from(s, 'base64url').toString('utf8');
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
  const mjs = path.join(tmp, 'worker.mjs');
  fs.copyFileSync(path.join(DIR, 'worker.js'), mjs);
  const W = await import('file://' + mjs);

  /* ---------- 1. playEvalSubscription (pura) ---------- */
  const subActiva = {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [{ productId: 'lacuota_mensual',
      expiryTime: '2026-10-21T10:00:00Z',
      autoRenewingPlan: { autoRenewEnabled: true } }],
  };
  let ev = W.playEvalSubscription(subActiva, 'lacuota_mensual');
  t('suscripción activa se reconoce', ev.active === true && ev.productId === 'lacuota_mensual');
  t('plan mensual mapeado', ev.expiryTime === '2026-10-21T10:00:00Z');
  t('sin acknowledge pendiente', ev.pendingAck === false);

  ev = W.playEvalSubscription(Object.assign({}, subActiva,
    { subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' }), 'lacuota_mensual');
  t('período de gracia cuenta como activa', ev.active === true);

  ev = W.playEvalSubscription(Object.assign({}, subActiva,
    { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }), 'lacuota_mensual');
  t('vencida no está activa', ev.active === false);

  ev = W.playEvalSubscription(Object.assign({}, subActiva,
    { subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }), 'lacuota_mensual');
  t('en espera no está activa', ev.active === false);

  ev = W.playEvalSubscription(Object.assign({}, subActiva,
    { acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING' }), 'lacuota_mensual');
  t('detecta acknowledge pendiente', ev.pendingAck === true);

  const dosPlanes = {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [
      { productId: 'lacuota_mensual', expiryTime: '2026-10-21T10:00:00Z' },
      { productId: 'lacuota_anual', expiryTime: '2027-09-21T10:00:00Z' },
    ],
  };
  ev = W.playEvalSubscription(dosPlanes, 'lacuota_anual');
  t('elige el plan pedido entre varios', ev.productId === 'lacuota_anual');
  t('expiry toma el más lejano', ev.expiryTime === '2027-09-21T10:00:00Z');

  ev = W.playEvalSubscription({}, 'lacuota_mensual');
  t('respuesta vacía no revienta', ev.active === false && ev.productId === 'lacuota_mensual');

  /* ---------- 2. playAccessToken con clave generada ---------- */
  const RSA = 'RSASSA-PKCS1-v1_5';
  const kp = await crypto.subtle.generateKey(
    { name: RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const keyPem = '-----BEGIN PRIVATE KEY-----\n' + pkcs8.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
  t('pemToDerPrivate extrae DER', W.pemToDerPrivate(keyPem).length > 100);

  const llamadas = [];
  const realFetch = globalThis.fetch;
  const googleSub = {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    lineItems: [{ productId: 'lacuota_mensual', expiryTime: '2026-10-21T10:00:00Z' }],
  };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    llamadas.push({ url: u, opts: opts || {} });
    if (u.indexOf('oauth2.googleapis.com/token') >= 0) {
      return new Response(JSON.stringify({ access_token: 'tok-de-prueba', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.indexOf('subscriptionsv2/tokens/') >= 0 && u.indexOf(':acknowledge') < 0) {
      if (u.indexOf('token-malo') >= 0) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(googleSub),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.indexOf(':acknowledge') >= 0) return new Response('{}', { status: 200 });
    return realFetch(url, opts);
  };

  const env = {
    PLAY_SA_EMAIL: 'cuenta@proyecto.iam.gserviceaccount.com',
    PLAY_SA_KEY: keyPem,
    SUBS: null, // se asigna abajo
  };
  const store = new Map();
  env.SUBS = {
    get: async (k, type) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v, o) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };
  async function post(pathn, body) {
    const req = new Request('https://x' + pathn,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = await W.default.fetch(req, env);
    return { status: res.status, json: await res.json() };
  }

  // Dispara el flujo: /play-verify usa playAccessToken internamente.
  const r1 = await post('/play-verify',
    { purchaseToken: 'token-bueno-1', productId: 'lacuota_mensual', googleSub: 'sub-abc-123' });
  t('/play-verify acepta compra válida', r1.status === 200 && r1.json.ok === true && r1.json.active === true,
    JSON.stringify(r1.json));
  t('/play-verify mapea el plan', r1.json.plan === 'mensual', r1.json.plan);

  const llamadaToken = llamadas.find(l => l.url.indexOf('oauth2.googleapis.com/token') >= 0);
  t('pide token OAuth2 a Google', !!llamadaToken);
  const cuerpoTok = String(llamadaToken.opts.body || '');
  t('usa el flujo jwt-bearer', cuerpoTok.indexOf('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer') >= 0);
  const assertion = decodeURIComponent((cuerpoTok.match(/assertion=([^&]*)/) || [])[1] || '');
  const partes = assertion.split('.');
  t('el JWT tiene 3 partes', partes.length === 3);
  const cab = JSON.parse(b64urlJson(partes[0]));
  const claim = JSON.parse(b64urlJson(partes[1]));
  t('JWT firmado RS256', cab.alg === 'RS256');
  t('JWT con iss, scope y aud correctos',
    claim.iss === env.PLAY_SA_EMAIL &&
    claim.scope === 'https://www.googleapis.com/auth/androidpublisher' &&
    claim.aud === 'https://oauth2.googleapis.com/token',
    JSON.stringify(claim).slice(0, 120));

  const llamadaSub = llamadas.find(l => l.url.indexOf('/purchases/subscriptionsv2/tokens/token-bueno-1') >= 0);
  t('consulta subscriptionsv2 con el token', !!llamadaSub);
  t('usa el Bearer de la cuenta de servicio',
    llamadaSub && llamadaSub.opts.headers['Authorization'] === 'Bearer tok-de-prueba');
  t('consulta el paquete correcto', llamadaSub && llamadaSub.url.indexOf('/applications/org.lacuota.app/') >= 0);

  const llamadaAck = llamadas.find(l => l.url.indexOf(':acknowledge') >= 0);
  t('reconoce (acknowledge) la compra pendiente', !!llamadaAck && llamadaAck.opts.method === 'POST');

  const clave = 'playsub:' + Buffer.from(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode('sub-abc-123'))).toString('hex');
  const guardado = JSON.parse(store.get(clave));
  t('ata el acceso al sub (hash, no el sub directo)',
    guardado && guardado.active === true && guardado.productId === 'lacuota_mensual' &&
    !JSON.stringify(guardado).includes('sub-abc-123'));
  t('no guarda el purchaseToken en claro fuera del registro',
    guardado && guardado.purchaseToken === 'token-bueno-1');

  /* /play-sub: estado sin volver a comprar */
  const r2 = await post('/play-sub', { googleSub: 'sub-abc-123' });
  t('/play-sub reporta activa', r2.json.active === true && r2.json.plan === 'mensual',
    JSON.stringify(r2.json));

  const r3 = await post('/play-sub', { googleSub: 'nadie' });
  t('/play-sub sin registro → inactiva', r3.json.active === false);

  /* /play-verify: datos malos */
  const r4 = await post('/play-verify',
    { purchaseToken: 'x', productId: 'plan_inventado', googleSub: 'sub-abc-123' });
  t('producto desconocido se rechaza', r4.status === 400 && r4.json.reason === 'datos');

  const r5 = await post('/play-verify',
    { purchaseToken: 'token-malo', productId: 'lacuota_mensual', googleSub: 'sub-abc-123' });
  t('token inválido de Google se rechaza', r5.status === 400 && r5.json.reason === 'token_invalido',
    JSON.stringify(r5.json));

  const r6 = await post('/play-verify',
    { purchaseToken: 'token-bueno-1', productId: 'lacuota_mensual', googleSub: '' });
  t('sin sub no se verifica', r6.status === 400);

  /* /play-sub re-verifica con Google: cancelación apaga el acceso */
  googleSub.subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
  const r7 = await post('/play-sub', { googleSub: 'sub-abc-123' });
  t('si Google dice vencida, se apaga', r7.json.active === false, JSON.stringify(r7.json));

  globalThis.fetch = realFetch;
  console.log('\n' + count + ' pruebas, ' + failures + ' fallos');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('EXCEPCIÓN', e); process.exit(1); });

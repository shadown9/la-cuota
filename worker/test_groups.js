/* La Cuota — pruebas del worker: los grupos siguen a la cuenta de Google.
   1) /google/code e /google/idtoken emiten un token de sesión opaco (sess).
   2) POST /me/claim registra el gid en la cuenta (401 sin sesión, 400 con gid malo).
   3) GET /me/groups devuelve los gids reclamados (401 sin sesión, [] si no hay).
   Ejecutar: node worker/test_groups.js */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const DIR = __dirname;
let failures = 0, count = 0;
function t(name, cond, extra) {
  count++;
  if (cond) { console.log('ok   ' + name); }
  else { failures++; console.log('FALLO ' + name + (extra ? ' — ' + extra : '')); }
}
function b64url(obj) {
  return Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-'));
  const mjs = path.join(tmp, 'worker.mjs');
  fs.copyFileSync(path.join(DIR, 'worker.js'), mjs);
  const W = await import('file://' + mjs);

  /* Clave RSA de prueba + certificado JWK como los de Google. */
  const RSA = 'RSASSA-PKCS1-v1_5';
  const kp = await crypto.subtle.generateKey(
    { name: RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  pubJwk.kid = 'testkid-g';
  pubJwk.alg = 'RS256';
  const now = Math.floor(Date.now() / 1000);
  const CLIENT_ID = '741417625058-oug08d9kbgtu1ma6ft6dninmdg7nk1ug.apps.googleusercontent.com';
  async function mintIdToken(sub) {
    const h = b64url({ alg: 'RS256', kid: 'testkid-g', typ: 'JWT' });
    const p = b64url({ sub: sub, aud: CLIENT_ID, iss: 'https://accounts.google.com',
      iat: now - 10, exp: now + 3600 });
    const sig = await crypto.subtle.sign({ name: RSA, hash: 'SHA-256' }, kp.privateKey,
      new TextEncoder().encode(h + '.' + p));
    const b64 = Buffer.from(sig).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return h + '.' + p + '.' + b64;
  }
  const idTokA = await mintIdToken('cuenta-A');
  const idTokB = await mintIdToken('cuenta-B');

  /* Interceptar la red del worker: canje OAuth y certificados. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.indexOf('oauth2.googleapis.com/token') >= 0) {
      return new Response(JSON.stringify({ id_token: idTokA }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.indexOf('www.googleapis.com/oauth2/v3/certs') >= 0) {
      return new Response(JSON.stringify({ keys: [pubJwk] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url);
  };

  const store = new Map();
  const env = {
    FB_PROJECT: 'la-cuota',
    SUBS: {
      get: async (k, type) => {
        const v = store.get(k);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v) => { store.set(k, v); },
      delete: async (k) => { store.delete(k); },
    },
  };
  async function req(method, path, body, ip) {
    const init = { method: method,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip || '9.9.9.9' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await W.default.fetch(new Request('https://x' + path, init), env);
    return { status: res.status, body: await res.json() };
  }

  /* 1. /google/code emite sess junto con la prueba. */
  const rc = await req('POST', '/google/code',
    { code: 'codigo-de-google-12345', verifier: 'v'.repeat(50), redirectUri: 'https://lacuota.org/' });
  t('/google/code emite sess opaco (64 hex)', rc.status === 200 && rc.body.ok === true &&
    /^[0-9a-f]{64}$/.test(rc.body.sess || ''), JSON.stringify(rc.body).slice(0, 120));
  t('/google/code sigue devolviendo sub y prueba', rc.body.sub === 'cuenta-A' && rc.body.trialActive === true);
  const sessA = rc.body.sess;
  const recSess = JSON.parse(store.get('sess:' + sessA));
  t('la sesión queda en KV con el sub', recSess && recSess.sub === 'cuenta-A');

  /* 2. /google/idtoken también emite sess. */
  const ri = await req('POST', '/google/idtoken', { idToken: idTokB }, '9.9.9.10');
  t('/google/idtoken emite sess opaco', ri.status === 200 && ri.body.ok === true &&
    /^[0-9a-f]{64}$/.test(ri.body.sess || ''));
  const sessB = ri.body.sess;
  t('sesiones distintas por cuenta', sessA !== sessB);

  /* 3. /me/claim. */
  const c0 = await req('POST', '/me/claim', { sess: 'mala', gid: 'grupo1' }, '9.9.9.11');
  t('/me/claim sin sesión → 401', c0.status === 401 && c0.body.ok === false, c0.status);
  const c1 = await req('POST', '/me/claim', { sess: sessA, gid: 'ab' }, '9.9.9.11');
  t('/me/claim con gid corto → 400', c1.status === 400 && c1.body.reason === 'gid', c1.status);
  const c2 = await req('POST', '/me/claim', { sess: sessA, gid: 'grupo-ABC_123' }, '9.9.9.11');
  t('/me/claim registra el grupo', c2.status === 200 && c2.body.ok === true, JSON.stringify(c2.body));
  const c3 = await req('POST', '/me/claim', { sess: sessA, gid: 'grupo-ABC_123' }, '9.9.9.11');
  t('/me/claim no duplica el gid', c3.body.ok === true &&
    JSON.parse(store.get('groups:' + require('crypto').createHash('sha256').update('cuenta-A').digest('hex'))).length === 1);
  await req('POST', '/me/claim', { sess: sessA, gid: 'otro-grupo-9' }, '9.9.9.11');
  await req('POST', '/me/claim', { sess: sessB, gid: 'grupo-de-B' }, '9.9.9.12');

  /* 4. /me/groups. */
  const g0 = await req('GET', '/me/groups?sess=mala', undefined, '9.9.9.13');
  t('/me/groups sin sesión → 401', g0.status === 401 && g0.body.ok === false, g0.status);
  const g1 = await req('GET', '/me/groups?sess=' + sessA, undefined, '9.9.9.13');
  t('/me/groups devuelve los gids de la cuenta', g1.status === 200 && g1.body.ok === true &&
    JSON.stringify(g1.body.gids.sort()) === JSON.stringify(['grupo-ABC_123', 'otro-grupo-9'].sort()),
    JSON.stringify(g1.body));
  const g2 = await req('GET', '/me/groups?sess=' + sessB, undefined, '9.9.9.13');
  t('/me/groups no mezcla cuentas', g2.body.ok === true &&
    JSON.stringify(g2.body.gids) === JSON.stringify(['grupo-de-B']), JSON.stringify(g2.body));

  /* Cuenta nueva sin reclamos: lista vacía. */
  const idTokC = await mintIdToken('cuenta-C');
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.indexOf('oauth2.googleapis.com/token') >= 0) {
      return new Response(JSON.stringify({ id_token: idTokC }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.indexOf('www.googleapis.com/oauth2/v3/certs') >= 0) {
      return new Response(JSON.stringify({ keys: [pubJwk] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url);
  };
  const rcC = await req('POST', '/google/code',
    { code: 'otro-codigo-67890', verifier: 'w'.repeat(50), redirectUri: 'https://lacuota.org/' }, '9.9.9.14');
  const g3 = await req('GET', '/me/groups?sess=' + rcC.body.sess, undefined, '9.9.9.15');
  t('/me/groups de cuenta sin grupos → []', g3.body.ok === true &&
    Array.isArray(g3.body.gids) && g3.body.gids.length === 0, JSON.stringify(g3.body));

  /* 5. Sesión vencida → 401. */
  const recA = JSON.parse(store.get('sess:' + sessA));
  recA.exp = Date.now() - 1000;
  store.set('sess:' + sessA, JSON.stringify(recA));
  const gV = await req('GET', '/me/groups?sess=' + sessA, undefined, '9.9.9.16');
  t('/me/groups con sesión vencida → 401', gV.status === 401 && gV.body.ok === false, gV.status);

  /* 6. Límite de intentos en /me/claim (canal propio, no toca el de login). */
  let limiteVisto = false;
  for (let i = 0; i < 35; i++) {
    const r = await req('POST', '/me/claim', { sess: sessB, gid: 'grupo-de-B' }, '9.9.9.99');
    if (r.status === 429) { limiteVisto = true; break; }
  }
  t('/me/claim frena a los 30 intentos por IP', limiteVisto);

  globalThis.fetch = realFetch;
  console.log('\n' + count + ' pruebas, ' + failures + ' fallos');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });

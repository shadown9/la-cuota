/* La Cuota — pruebas del worker: verificación de identidad con Google.
   1) El parser DER extrae un SPKI válido del certificado REAL de Google.
   2) Roundtrip JWT: clave generada + certificado openssl autofirmado,
      el verifyFirebaseIdToken del worker lo acepta; manipulaciones se rechazan.
   3) El endpoint POST /trial registra una sola prueba por cuenta (KV simulado).
   Ejecutar: node worker/test_trial.js */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const mjs = path.join(tmp, 'worker.mjs');
  fs.copyFileSync(path.join(DIR, 'worker.js'), mjs);
  const W = await import('file://' + mjs);

  /* 1. Certificado real de Google (fixture) */
  const fixture = JSON.parse(fs.readFileSync(path.join(DIR, 'test/securetoken_certs_fixture.json'), 'utf8'));
  const kids = Object.keys(fixture);
  t('fixture trae certificados de Google', kids.length >= 1);
  const spki = W.derFindSpki(W.pemToDer(fixture[kids[0]]));
  t('derFindSpki extrae SPKI del cert real', spki && spki.length > 100, 'len=' + (spki && spki.length));
  let keyOk = false;
  try {
    await W.importRsaKey(spki.slice().buffer);
    keyOk = true;
  } catch (e) { /* noop */ }
  t('el SPKI del cert real se importa en WebCrypto', keyOk);
  t('derFindSpki rechaza basura', W.derFindSpki(new Uint8Array([1, 2, 3])) === null);

  /* 2. Roundtrip con clave propia + cert openssl */
  const RSA = 'RSASSA-PKCS1-v1_5'; /* nombre que acepta node */
  const kp = await crypto.subtle.generateKey(
    { name: RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const keyPem = '-----BEGIN PRIVATE KEY-----\n' + pkcs8.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
  fs.writeFileSync(path.join(tmp, 'k.pem'), keyPem);
  cp.execSync('openssl req -new -x509 -key k.pem -out c.pem -days 2 -subj "/CN=prueba" -sha256', { cwd: tmp });
  const certPem = fs.readFileSync(path.join(tmp, 'c.pem'), 'utf8');
  const fetchCerts = async () => ({ testkid: certPem });

  async function mint(payload, kid) {
    const h = b64url({ alg: 'RS256', kid: kid || 'testkid', typ: 'JWT' });
    const p = b64url(payload);
    const sig = await crypto.subtle.sign({ name: RSA, hash: 'SHA-256' }, kp.privateKey,
      new TextEncoder().encode(h + '.' + p));
    const b64 = Buffer.from(sig).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return h + '.' + p + '.' + b64;
  }
  const now = Math.floor(Date.now() / 1000);
  const base = { sub: 'usuario123', aud: 'la-cuota', iss: 'https://securetoken.google.com/la-cuota', iat: now - 10, exp: now + 3600 };

  const v1 = await W.verifyFirebaseIdToken(await mint(base), 'la-cuota', fetchCerts);
  t('token válido se acepta', v1.ok === true && v1.sub === 'usuario123', JSON.stringify(v1));

  const tok2 = await mint(base);
  const bad = tok2.slice(0, -4) + 'AAAA';
  const v2 = await W.verifyFirebaseIdToken(bad, 'la-cuota', fetchCerts);
  t('firma manipulada se rechaza', !v2.ok && v2.reason === 'firma', v2.reason);

  const v3 = await W.verifyFirebaseIdToken(await mint(Object.assign({}, base, { aud: 'otro' })), 'la-cuota', fetchCerts);
  t('aud incorrecto se rechaza', !v3.ok && v3.reason === 'aud', v3.reason);

  const v4 = await W.verifyFirebaseIdToken(await mint(Object.assign({}, base, { exp: now - 3600 })), 'la-cuota', fetchCerts);
  t('token vencido se rechaza', !v4.ok && v4.reason === 'exp', v4.reason);

  const v5 = await W.verifyFirebaseIdToken(await mint(base, 'desconocido'), 'la-cuota', fetchCerts);
  t('kid desconocido se rechaza', !v5.ok && v5.reason === 'kid', v5.reason);

  const v6 = await W.verifyFirebaseIdToken('no-es-un-jwt', 'la-cuota', fetchCerts);
  t('token malformado se rechaza', !v6.ok, v6.reason);

  const hNone = b64url({ alg: 'none', kid: 'testkid' }) + '.' + b64url(base) + '.firma';
  const v7 = await W.verifyFirebaseIdToken(hNone, 'la-cuota', fetchCerts);
  t('alg=none se rechaza', !v7.ok && v7.reason === 'alg', v7.reason);

  /* 3. Endpoint /trial con KV simulado.
     El worker busca los certificados de Google en la red: aquí se
     intercepta fetch para devolver el certificado de prueba. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).indexOf('securetoken@system.gserviceaccount.com') >= 0) {
      return new Response(JSON.stringify({ testkid: certPem }),
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
  async function postTrial(token, ip) {
    const req = new Request('https://x/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip || '1.2.3.4' },
      body: JSON.stringify({ idToken: token }),
    });
    const res = await W.default.fetch(req, env);
    return { status: res.status, body: await res.json() };
  }
  const DAY = 86400000;
  const goodTok = await mint(base);
  const r1 = await postTrial(goodTok);
  t('/trial primera vez: registra la prueba', r1.status === 200 && r1.body.ok && r1.body.trialUsed === false && r1.body.trialStart > 0, JSON.stringify(r1.body));
  t('/trial primera vez: trae trialActive y trialExpiresAt (30 días)',
    r1.body.trialActive === true && r1.body.trialExpired === false &&
    r1.body.trialExpiresAt === r1.body.trialStart + 30 * DAY, JSON.stringify(r1.body));
  const r2 = await postTrial(goodTok);
  t('/trial segunda vez: la misma cuenta NO obtiene otra prueba',
    r2.body.ok && r2.body.trialUsed === true && r2.body.trialStart === r1.body.trialStart, JSON.stringify(r2.body));
  t('/trial reingreso durante la prueba: idempotente y sigue activa',
    r2.body.trialActive === true && r2.body.trialExpired === false &&
    r2.body.trialExpiresAt === r1.body.trialStart + 30 * DAY, JSON.stringify(r2.body));
  /* Prueba vencida hace 31 días: el reingreso conserva la fecha original,
     marca vencida y NO extiende la prueba. */
  const ncrypto = require('crypto');
  const subVieja = 'cuenta-vencida';
  const inicioViejo = Date.now() - 31 * DAY;
  store.set('trial:g:' + ncrypto.createHash('sha256').update(subVieja).digest('hex'),
    JSON.stringify({ trialStart: inicioViejo, createdAt: inicioViejo }));
  const rV = await postTrial(await mint(Object.assign({}, base, { sub: subVieja })));
  t('/trial reingreso con prueba vencida: conserva la fecha original',
    rV.body.ok && rV.body.trialUsed === true && rV.body.trialStart === inicioViejo, JSON.stringify(rV.body));
  t('/trial prueba vencida: trialActive=false, trialExpired=true, sin extender',
    rV.body.trialActive === false && rV.body.trialExpired === true &&
    rV.body.trialExpiresAt === inicioViejo + 30 * DAY, JSON.stringify(rV.body));
  const r3 = await postTrial(await mint(Object.assign({}, base, { sub: 'otra-persona' })));
  t('/trial otra cuenta sí obtiene su prueba', r3.body.ok && r3.body.trialUsed === false && r3.body.trialActive === true, JSON.stringify(r3.body));
  const r4 = await postTrial('basura');
  t('/trial token inválido → 401', r4.status === 401 && r4.body.ok === false, r4.status);
  const r5 = await W.default.fetch(new Request('https://x/trial', { method: 'OPTIONS' }), env);
  t('/trial responde preflight CORS', r5.status === 204);

  /* 4. Boleto de un solo uso (/ticket + /ticket/redeem). */
  async function postTicket(token, ip) {
    const req = new Request('https://x/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip || '5.6.7.8' },
      body: JSON.stringify({ idToken: token }),
    });
    const res = await W.default.fetch(req, env);
    return { status: res.status, body: await res.json() };
  }
  async function postRedeem(ticket, ip) {
    const req = new Request('https://x/ticket/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip || '5.6.7.8' },
      body: JSON.stringify({ ticket: ticket }),
    });
    const res = await W.default.fetch(req, env);
    return { status: res.status, body: await res.json() };
  }
  const t1 = await postTicket(await mint(Object.assign({}, base, { sub: 'boleto-uno' })));
  t('/ticket con token válido entrega un boleto',
    t1.status === 200 && t1.body.ok === true && /^[0-9a-f]{48}$/.test(t1.body.ticket || ''),
    JSON.stringify(t1.body).slice(0, 80));
  const t2 = await postTicket('basura');
  t('/ticket con token inválido → 401', t2.status === 401 && t2.body.ok === false, t2.status);
  const rd1 = await postRedeem(t1.body.ticket);
  t('/ticket/redeem canjea el boleto y trae el estado de la prueba',
    rd1.status === 200 && rd1.body.ok === true && rd1.body.sub === 'boleto-uno' &&
    rd1.body.trialStart > 0 && rd1.body.trialActive === true,
    JSON.stringify(rd1.body).slice(0, 120));
  const rd2 = await postRedeem(t1.body.ticket);
  t('/ticket/redeem el boleto sirve una sola vez (segundo canje → 404)',
    rd2.status === 404 && rd2.body.ok === false, rd2.status);
  const rd3 = await postRedeem('no-es-un-boleto');
  t('/ticket/redeem boleto malformado → 400', rd3.status === 400 && rd3.body.ok === false, rd3.status);
  /* El boleto respeta la prueba ya usada: no regala días. */
  const tV = await postTicket(await mint(Object.assign({}, base, { sub: subVieja })));
  const rdV = await postRedeem(tV.body.ticket);
  t('/ticket/redeem con prueba vencida: conserva la fecha original, sin extender',
    rdV.body.ok === true && rdV.body.trialUsed === true &&
    rdV.body.trialStart === inicioViejo && rdV.body.trialExpired === true,
    JSON.stringify(rdV.body).slice(0, 120));

  console.log('\n' + count + ' pruebas, ' + failures + ' fallos');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });

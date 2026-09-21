// La Cuota — verificador de pagos (Cloudflare Worker)
// --------------------------------------------------
// Recibe los avisos (webhooks) de Stripe, verifica la firma
// y guarda el estado de la suscripción en KV.
// La app consulta GET /sub?email=... para saber si el pago es real.
//
// Variables de entorno: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY (secreto,
// solo para crear sesiones del portal del cliente en /portal)
// FB_PROJECT: ID del proyecto Firebase (por defecto 'la-cuota')
// KV binding: SUBS

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Verificación de identidad con Google (una prueba por cuenta) ----------
   v63: la app navega directo a Google con PKCE y nos envía el código de un
   solo uso. Aquí lo canjeamos con Google, verificamos la firma del ID token
   con los certificados públicos de Google y registramos la primera vez que
   esa cuenta usa la prueba gratis. Solo guardamos el hash SHA-256 del ID de
   usuario, nunca el ID directo. Los endpoints viejos /ticket se conservan
   por compatibilidad pero la app ya no los usa. */

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) {
  const b = b64urlToBytes(s);
  let str = '';
  for (let i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
  return decodeURIComponent(escape(str));
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Lector DER mínimo: lee un TLV y lista los hijos de un SEQUENCE. */
function derRead(buf, off) {
  const tag = buf[off];
  const lb = buf[off + 1];
  let len, hl;
  if (lb < 0x80) { len = lb; hl = 2; }
  else {
    const n = lb & 0x7f;
    if (n === 0 || n > 4 || off + 2 + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[off + 2 + i];
    hl = 2 + n;
  }
  if (off + hl + len > buf.length) return null;
  return { tag, len, contentOff: off + hl, totalLen: hl + len };
}
function derChildren(buf, off) {
  const t = derRead(buf, off);
  if (!t || t.tag !== 0x30) return null;
  const kids = [];
  let p = t.contentOff;
  const end = p + t.len;
  while (p < end) {
    const c = derRead(buf, p);
    if (!c) return null;
    kids.push({ off: p, totalLen: c.totalLen });
    p += c.totalLen;
  }
  return kids;
}
const OID_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
/* Encuentra el SubjectPublicKeyInfo (SEQUENCE con OID rsaEncryption +
   BIT STRING) dentro del certificado y devuelve su DER completo. */
function derFindSpki(certBytes) {
  try {
    const certKids = derChildren(certBytes, 0);
    if (!certKids || !certKids.length) return null;
    const tbsKids = derChildren(certBytes, certKids[0].off);
    if (!tbsKids) return null;
    for (const k of tbsKids) {
      const sk = derChildren(certBytes, k.off);
      if (!sk || sk.length < 2) continue;
      const algKids = derChildren(certBytes, sk[0].off);
      if (!algKids || !algKids.length) continue;
      const oid = derRead(certBytes, algKids[0].off);
      if (!oid || oid.tag !== 0x06 || oid.len !== OID_RSA.length) continue;
      let match = true;
      for (let i = 0; i < OID_RSA.length; i++) {
        if (certBytes[oid.contentOff + i] !== OID_RSA[i]) { match = false; break; }
      }
      if (!match) continue;
      const bs = derRead(certBytes, sk[1].off);
      if (!bs || bs.tag !== 0x03) continue;
      const t = derRead(certBytes, k.off);
      return certBytes.slice(k.off, k.off + t.totalLen);
    }
    return null;
  } catch (e) { return null; }
}

let certCache = { at: 0, data: null };
async function getGoogleCerts() {
  if (certCache.data && Date.now() - certCache.at < 3600e3) return certCache.data;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!r.ok) throw new Error('certs');
  const data = await r.json();
  certCache = { at: Date.now(), data };
  return data;
}

/* WebCrypto llama al algoritmo RSA de dos formas según el entorno
   ('RSASSA-PKCS1-v15' en navegadores/Workers, 'RSASSA-PKCS1-v1_5' en node).
   Se prueba con ambos para no depender del entorno. */
const RSA_NAMES = ['RSASSA-PKCS1-v15', 'RSASSA-PKCS1-v1_5'];
async function importRsaKey(spkiBuf) {
  let last = null;
  for (const name of RSA_NAMES) {
    try {
      const key = await crypto.subtle.importKey(
        'spki', spkiBuf, { name, hash: 'SHA-256' }, false, ['verify']);
      return { key, name };
    } catch (e) { last = e; }
  }
  throw last;
}
function rsaVerify(k, sig, data) {
  return crypto.subtle.verify({ name: k.name, hash: 'SHA-256' }, k.key, sig, data);
}

/* Verifica un Firebase ID token. Devuelve {ok:true, sub} o {ok:false, reason}.
   fetchCerts es inyectable para pruebas. */
async function verifyFirebaseIdToken(idToken, projectId, fetchCerts) {
  try {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: 'formato' };
    const header = JSON.parse(b64urlToString(parts[0]));
    const payload = JSON.parse(b64urlToString(parts[1]));
    if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'alg' };
    const now = Math.floor(Date.now() / 1000);
    if (!payload.sub || typeof payload.sub !== 'string') return { ok: false, reason: 'sub' };
    if (payload.aud !== projectId) return { ok: false, reason: 'aud' };
    if (payload.iss !== 'https://securetoken.google.com/' + projectId) return { ok: false, reason: 'iss' };
    if (typeof payload.exp !== 'number' || payload.exp < now - 60) return { ok: false, reason: 'exp' };
    if (payload.iat && payload.iat > now + 60) return { ok: false, reason: 'iat' };
    const certs = await (fetchCerts || getGoogleCerts)();
    const pem = certs[header.kid];
    if (!pem) return { ok: false, reason: 'kid' };
    const spki = derFindSpki(pemToDer(pem));
    if (!spki) return { ok: false, reason: 'spki' };
    let k;
    try { k = await importRsaKey(spki.slice().buffer); }
    catch (e) { return { ok: false, reason: 'llave' }; }
    const sig = b64urlToBytes(parts[2]);
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const valid = await rsaVerify(k, sig, data);
    if (!valid) return { ok: false, reason: 'firma' };
    return { ok: true, sub: payload.sub };
  } catch (e) {
    return { ok: false, reason: 'excepcion' };
  }
}

/* v63: entrada con Google por PKCE directo (sin Firebase Auth).
   El cliente OAuth web del proyecto (ID público) acepta como URIs de
   redireccionamiento solo los registrados en la consola de Google. */
const GOOGLE_OAUTH_CLIENT_ID = '741417625058-oug08d9kbgtu1ma6ft6dninmdg7nk1ug.apps.googleusercontent.com';
const GOOGLE_REDIRECT_URIS = ['https://lacuota.org/', 'https://shadown9.github.io/la-cuota/'];

let oauthCertCache = { at: 0, data: null };
async function getGoogleOAuthCerts() {
  if (oauthCertCache.data && Date.now() - oauthCertCache.at < 3600e3) return oauthCertCache.data;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('certs');
  const data = await r.json();
  oauthCertCache = { at: Date.now(), data };
  return data;
}
async function importRsaJwk(jwk) {
  let last = null;
  for (const name of RSA_NAMES) {
    try {
      const key = await crypto.subtle.importKey(
        'jwk', jwk, { name, hash: 'SHA-256' }, false, ['verify']);
      return { key, name };
    } catch (e) { last = e; }
  }
  throw last;
}
/* Verifica un ID token emitido por Google para nuestro cliente OAuth.
   Devuelve {ok:true, sub} o {ok:false, reason}. fetchCerts es inyectable
   para pruebas. */
async function verifyGoogleIdToken(idToken, clientId, fetchCerts) {
  try {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: 'formato' };
    const header = JSON.parse(b64urlToString(parts[0]));
    const payload = JSON.parse(b64urlToString(parts[1]));
    if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'alg' };
    const now = Math.floor(Date.now() / 1000);
    if (!payload.sub || typeof payload.sub !== 'string') return { ok: false, reason: 'sub' };
    if (payload.aud !== clientId) return { ok: false, reason: 'aud' };
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com')
      return { ok: false, reason: 'iss' };
    if (typeof payload.exp !== 'number' || payload.exp < now - 60) return { ok: false, reason: 'exp' };
    if (payload.iat && payload.iat > now + 60) return { ok: false, reason: 'iat' };
    const certs = await (fetchCerts || getGoogleOAuthCerts)();
    const jwk = ((certs && certs.keys) || []).find(k => k.kid === header.kid);
    if (!jwk) return { ok: false, reason: 'kid' };
    let k;
    try { k = await importRsaJwk(jwk); }
    catch (e) { return { ok: false, reason: 'llave' }; }
    const sig = b64urlToBytes(parts[2]);
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const valid = await crypto.subtle.verify({ name: k.name, hash: 'SHA-256' }, k.key, sig, data);
    if (!valid) return { ok: false, reason: 'firma' };
    return { ok: true, sub: payload.sub };
  } catch (e) {
    return { ok: false, reason: 'excepcion' };
  }
}

/* Calcula el estado de la prueba gratis de una cuenta (una cuenta = una
   prueba, para siempre). El reingreso es idempotente: devuelve la fecha
   original sin extenderla. La usan /trial y /ticket. */
async function trialState(env, sub) {
  const key = 'trial:g:' + await sha256Hex(sub);
  const rec = await env.SUBS.get(key, 'json');
  const now = Date.now();
  if (rec && rec.trialStart) {
    const trialExpiresAt = rec.trialStart + TRIAL_MS;
    const trialActive = now < trialExpiresAt;
    return { trialUsed: true, trialStart: rec.trialStart,
      trialExpiresAt: trialExpiresAt, trialActive: trialActive,
      trialExpired: !trialActive };
  }
  const ts = now;
  await env.SUBS.put(key, JSON.stringify({ trialStart: ts, createdAt: ts }));
  return { trialUsed: false, trialStart: ts,
    trialExpiresAt: ts + TRIAL_MS, trialActive: true, trialExpired: false };
}

function hexRandom(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function checkRateLimit(env, ip) {
  if (!ip) return true;
  const k = 'rl:' + await sha256Hex('trial|' + ip);
  const n = parseInt(await env.SUBS.get(k) || '0', 10) || 0;
  if (n >= 30) return false;
  await env.SUBS.put(k, String(n + 1), { expirationTtl: 3600 });
  return true;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function verifyStripeSig(payload, header, secret) {
  try {
    const parts = Object.fromEntries(header.split(',').map(p => {
      const i = p.indexOf('=');
      return [p.slice(0, i), p.slice(i + 1)];
    }));
    if (!parts.t || !parts.v1) return false;
    // Rechaza avisos viejos (más de 5 minutos) contra replays
    const ts = parseInt(parts.t, 10);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return false;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(parts.t + '.' + payload)
    );
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    return timingSafeEqual(hex, parts.v1);
  } catch (e) {
    return false;
  }
}

function planFromAmount(cents) {
  if (cents === 2000) return 'anual';
  return 'mensual'; // 200
}

/* Duración de la prueba gratis: 30 días (la usa /trial). */
const TRIAL_MS = 30 * 86400000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Preflight CORS para las llamadas POST desde el navegador
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ---- Prueba gratis por cuenta de Google (la app llama aquí) ----
    // POST /trial {idToken} -> {ok, trialUsed, trialStart, trialExpiresAt, trialActive, trialExpired}
    // El servidor es la autoridad: una cuenta = una prueba, para siempre.
    // El reingreso es idempotente: devuelve la fecha original y dice si la
    // prueba sigue activa, para no bloquear a quien cambia de teléfono.
    if (url.pathname === '/trial' && req.method === 'POST') {
      const ip = req.headers.get('cf-connecting-ip') || '';
      if (!await checkRateLimit(env, ip)) {
        return json({ ok: false, reason: 'limite' }, 429);
      }
      let body = null;
      try { body = await req.json(); } catch (e) { /* noop */ }
      const v = await verifyFirebaseIdToken(
        body && body.idToken, env.FB_PROJECT || 'la-cuota');
      if (!v.ok) return json({ ok: false, reason: v.reason }, 401);
      const st = await trialState(env, v.sub);
      return json(Object.assign({ ok: true }, st));
    }

    // ---- Boleto de un solo uso: regreso automático a la app instalada ----
    // En Android el login con Google siempre se completa en el navegador del
    // sistema (el teléfono saca la página de Google de la app instalada).
    // La pestaña del sistema, tras verificar con /trial, pide aquí un boleto
    // con el ID token y reabre la app instalada con ?t=<boleto>. La app lo
    // canjea abajo y entra directo a los grupos, sin pasar por Google.
    // El boleto vive 5 minutos, sirve una sola vez y solo entrega el estado
    // de la prueba de esa cuenta (no es una credencial de Google).
    if (url.pathname === '/ticket' && req.method === 'POST') {
      const ip = req.headers.get('cf-connecting-ip') || '';
      if (!await checkRateLimit(env, ip)) {
        return json({ ok: false, reason: 'limite' }, 429);
      }
      let body = null;
      try { body = await req.json(); } catch (e) { /* noop */ }
      const v = await verifyFirebaseIdToken(
        body && body.idToken, env.FB_PROJECT || 'la-cuota');
      if (!v.ok) return json({ ok: false, reason: v.reason }, 401);
      const st = await trialState(env, v.sub);
      const ticket = hexRandom(24);
      await env.SUBS.put('ticket:' + ticket, JSON.stringify({
        sub: v.sub,
        trialStart: st.trialStart, trialUsed: st.trialUsed,
        trialActive: st.trialActive, trialExpired: st.trialExpired,
        createdAt: Date.now(),
      }), { expirationTtl: 300 });
      return json({ ok: true, ticket: ticket });
    }

    // POST /ticket/redeem {ticket} -> estado de la prueba (un solo uso).
    if (url.pathname === '/ticket/redeem' && req.method === 'POST') {
      const ip = req.headers.get('cf-connecting-ip') || '';
      if (!await checkRateLimit(env, ip)) {
        return json({ ok: false, reason: 'limite' }, 429);
      }
      let body = null;
      try { body = await req.json(); } catch (e) { /* noop */ }
      const ticket = String((body && body.ticket) || '');
      if (!/^[0-9a-f]{48}$/.test(ticket)) {
        return json({ ok: false, reason: 'boleto' }, 400);
      }
      const rec = await env.SUBS.get('ticket:' + ticket, 'json');
      if (!rec) return json({ ok: false, reason: 'boleto' }, 404);
      try { await env.SUBS.delete('ticket:' + ticket); } catch (e) { /* noop */ }
      return json({ ok: true, sub: rec.sub,
        trialStart: rec.trialStart, trialUsed: rec.trialUsed,
        trialActive: rec.trialActive, trialExpired: rec.trialExpired });
    }

    // ---- v63: canje del código de Google (PKCE directo) ----
    // La app regresa de Google con ?code=...&state=... en su propia
    // dirección. Aquí se canjea con Google (PKCE), se verifica el ID token
    // y se devuelve el estado de la prueba de esa cuenta.
    // POST /google/code {code, verifier, redirectUri} -> {ok, sub, ...trial}
    if (url.pathname === '/google/code' && req.method === 'POST') {
      const ip = req.headers.get('cf-connecting-ip') || '';
      if (!await checkRateLimit(env, ip)) {
        return json({ ok: false, reason: 'limite' }, 429);
      }
      let body = null;
      try { body = await req.json(); } catch (e) { /* noop */ }
      const code = String((body && body.code) || '');
      const verifier = String((body && body.verifier) || '');
      const redirectUri = String((body && body.redirectUri) || '');
      if (!/^[A-Za-z0-9\-_~.]{10,512}$/.test(code) ||
          !/^[A-Za-z0-9\-_~.]{43,128}$/.test(verifier) ||
          GOOGLE_REDIRECT_URIS.indexOf(redirectUri) < 0) {
        return json({ ok: false, reason: 'entrada' }, 400);
      }
      let tok = null;
      try {
        const tr = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'code=' + encodeURIComponent(code) +
                '&client_id=' + encodeURIComponent(GOOGLE_OAUTH_CLIENT_ID) +
                '&code_verifier=' + encodeURIComponent(verifier) +
                '&redirect_uri=' + encodeURIComponent(redirectUri) +
                '&grant_type=authorization_code',
        });
        try { tok = { ok: tr.ok, d: await tr.json() }; }
        catch (e2) { tok = { ok: false, d: null }; }
      } catch (e) { tok = { ok: false, d: null }; }
      if (!tok.ok || !tok.d || !tok.d.id_token) {
        /* invalid_grant = código vencido, mal verifier o ya canjeado
           (otra ventana lo usó): la app espera la sesión verificada. */
        if (tok.d && tok.d.error === 'invalid_grant')
          return json({ ok: false, reason: 'codigo_usado' }, 400);
        return json({ ok: false, reason: 'google' }, 400);
      }
      const v = await verifyGoogleIdToken(tok.d.id_token, GOOGLE_OAUTH_CLIENT_ID);
      if (!v.ok) return json({ ok: false, reason: 'permiso' }, 401);
      const st = await trialState(env, v.sub);
      return json(Object.assign({ ok: true, sub: v.sub }, st));
    }

    // ---- Verificación de suscripción (la app llama aquí) ----
    if (url.pathname === '/sub' && req.method === 'GET') {
      const email = (url.searchParams.get('email') || '').toLowerCase().trim();
      if (!email || !email.includes('@')) {
        return json({ active: false, reason: 'email' }, 400);
      }
      const rec = await env.SUBS.get('sub:' + await sha256Hex(email), 'json');
      if (!rec) return json({ active: false });
      const active = rec.status === 'active' || rec.status === 'trialing';
      return json({
        active,
        plan: rec.plan || null,
        until: rec.currentPeriodEnd || null, // epoch segundos
        status: rec.status || null,
      });
    }

    // ---- Webhook de Stripe ----
    if (url.pathname === '/stripe-webhook' && req.method === 'POST') {
      const payload = await req.text();
      const sigHeader = req.headers.get('stripe-signature') || '';
      if (!await verifyStripeSig(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET)) {
        return new Response('firma inválida', { status: 400 });
      }
      let ev;
      try { ev = JSON.parse(payload); } catch (e) {
        return new Response('json inválido', { status: 400 });
      }

      if (ev.type === 'checkout.session.completed') {
        const s = ev.data.object;
        const email = ((s.customer_email || (s.customer_details && s.customer_details.email) || '').toLowerCase().trim());
        if (email && s.mode === 'subscription') {
          const key = 'sub:' + await sha256Hex(email);
          const prev = (await env.SUBS.get(key, 'json')) || {};
          await env.SUBS.put(key, JSON.stringify({
            email,
            status: 'active',
            plan: planFromAmount(s.amount_total),
            customerId: s.customer || prev.customerId || null,
            subscriptionId: s.subscription || prev.subscriptionId || null,
            updatedAt: Date.now(),
          }));
          if (s.subscription) {
            await env.SUBS.put('sid:' + s.subscription, key);
          }
        }
      }

      if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted' || ev.type === 'customer.subscription.created') {
        const sub = ev.data.object;
        const key = await env.SUBS.get('sid:' + sub.id);
        if (key) {
          const prev = (await env.SUBS.get(key, 'json')) || {};
          const item = sub.items && sub.items.data && sub.items.data[0];
          const cents = item && item.price ? item.price.unit_amount : null;
          await env.SUBS.put(key, JSON.stringify({
            ...prev,
            status: sub.status, // active, trialing, past_due, canceled, unpaid
            plan: cents ? planFromAmount(cents) : prev.plan,
            currentPeriodEnd: sub.current_period_end || prev.currentPeriodEnd || null,
            customerId: sub.customer || prev.customerId || null,
            subscriptionId: sub.id,
            updatedAt: Date.now(),
          }));
        }
      }

      return new Response('ok', { status: 200 });
    }

    // ---- Portal del cliente (administrar suscripción) ----
    // La app llama GET /portal?email=... y recibe {url} para abrir el
    // portal de Stripe, donde el cliente cancela, cambia de plan o
    // actualiza su tarjeta sin nuestra intervención.
    // Requiere STRIPE_SECRET_KEY como secreto del Worker.
    if (url.pathname === '/portal' && req.method === 'GET') {
      const email = (url.searchParams.get('email') || '').toLowerCase().trim();
      if (!email || !email.includes('@')) {
        return json({ error: 'email' }, 400);
      }
      if (!env.STRIPE_SECRET_KEY) {
        return json({ error: 'no_config' }, 503);
      }
      const rec = await env.SUBS.get('sub:' + await sha256Hex(email), 'json');
      if (!rec || !rec.customerId) {
        return json({ error: 'not_found' }, 404);
      }
      try {
        const body = new URLSearchParams({
          customer: rec.customerId,
          return_url: 'https://lacuota.org/',
        });
        const r = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });
        const data = await r.json();
        if (!r.ok || !data.url) {
          return json({ error: 'stripe', detail: data.error ? data.error.message : 'sin url' }, 502);
        }
        return json({ url: data.url });
      } catch (e) {
        return json({ error: 'stripe', detail: 'excepción' }, 502);
      }
    }

    return new Response('La Cuota · verificador de pagos', { status: 200 });
  }
};

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'content-type': 'application/json' }, corsHeaders()),
  });
}

/* Exportadas para las pruebas (node). */
export { verifyFirebaseIdToken, verifyGoogleIdToken, derFindSpki, pemToDer, b64urlToBytes, sha256Hex, importRsaKey };

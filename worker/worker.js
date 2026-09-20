// La Cuota — verificador de pagos (Cloudflare Worker)
// --------------------------------------------------
// Recibe los avisos (webhooks) de Stripe, verifica la firma
// y guarda el estado de la suscripción en KV.
// La app consulta GET /sub?email=... para saber si el pago es real.
//
// Variables de entorno: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY (secreto,
// solo para crear sesiones del portal del cliente en /portal)
// KV binding: SUBS

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  });
}

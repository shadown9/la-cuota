# Tarea pendiente: Deploy del Cloudflare Worker

## Contexto

Repositorio: `shadown9/la-cuota` (rama `main`, actualmente en v68)

Se aplicaron correcciones de seguridad en `worker/worker.js` pero **no han sido
desplegadas en Cloudflare**. El archivo en el repo ya tiene el código correcto;
solo falta subirlo.

## Cambios ya hechos en worker/worker.js (commits 8fab8aa y 6f544af en main)

1. **CORS whitelist** — se reemplazó `Access-Control-Allow-Origin: *` por una
   lista de orígenes permitidos:
   ```js
   const ALLOWED_ORIGINS = [
     'https://lacuota.org',
     'https://www.lacuota.org',
     'https://shadown9.github.io'
   ];
   ```
   La función `corsHeaders(origin)` ahora recibe el `Origin` de la petición y
   solo lo refleja si está en esa lista; de lo contrario devuelve el primero.
   Se añade `Vary: Origin` en todas las respuestas.

2. **TextDecoder** — `b64urlToString` ya no usa `escape()`/`unescape()` (obsoleto);
   usa `new TextDecoder().decode(b64urlToBytes(s))`.

3. **`client_secret` en OAuth** — el intercambio de código de Google ya incluye
   `client_secret` desde el KV secret `GOOGLE_CLIENT_SECRET`.

## Lo que debes hacer

### Opción A — Cloudflare Dashboard (más fácil, sin credenciales)

1. Abre [dash.cloudflare.com](https://dash.cloudflare.com)
2. Workers & Pages → **lacuota-pagos** → Edit code
3. Borra todo el contenido actual
4. Pega el contenido completo de `worker/worker.js` del repo
   (`https://github.com/shadown9/la-cuota/blob/main/worker/worker.js`)
5. Clic en **Deploy**

### Opción B — wrangler deploy (requiere credenciales de Cloudflare)

El repo ya tiene `worker/wrangler.toml` (commit 18bca51). Solo necesitas:

1. Obtener el ID real del KV namespace `SUBS`:
   - Dashboard → Workers & Pages → KV → busca el namespace que usa `lacuota-pagos`
   - Copia el **ID** (cadena hex)
2. Editar `worker/wrangler.toml` y reemplazar `REEMPLAZAR_CON_ID_REAL_DE_KV`
   con ese ID
3. Asegúrate de que `CLOUDFLARE_API_TOKEN` está disponible en el entorno
4. Desde la carpeta `worker/`:
   ```bash
   npx wrangler deploy
   ```

## Variables de entorno / secrets que debe tener el Worker

Estas ya deben existir en el Worker de producción (no se crean aquí):

| Secret | Descripción |
|--------|-------------|
| `GOOGLE_CLIENT_SECRET` | Client secret del proyecto OAuth de Google |
| `STRIPE_SECRET_KEY` | Clave secreta de Stripe |
| `STRIPE_WEBHOOK_SECRET` | Secreto de firma del webhook de Stripe |

## Verificación

Después del deploy, confirma que el CORS funciona:

```bash
curl -s -I -X OPTIONS \
  https://lacuota-pagos.deivyespinosa07.workers.dev/sub \
  -H "Origin: https://lacuota.org" \
  -H "Access-Control-Request-Method: GET" \
  | grep -i "access-control"
```

Debe devolver `access-control-allow-origin: https://lacuota.org` (no `*`).

## Estado general del proyecto al momento de esta tarea

| Versión | Cambio |
|---------|--------|
| v64 | Login con Google (client_secret en worker) |
| v65 | Seguridad y optimización SW (caché de vendor separado) |
| v66 | Fix: login fallaba tras cerrar sesión (expectNoSession) |
| v67 | Fix: guardián interfería durante actualización automática |
| v68 | Fix: FAQ actualizado, CSP añadido en index.html |

La app en GitHub Pages (lacuota.org) está al día. Solo el Worker está pendiente.

# InstaGen — Cloudflare Reverse-Proxy Configuration

Audit and changes for running InstaGen behind Cloudflare, fronting
the Express deployment described in the original prompt.

## Architecture

The codebase is an **Express application** served by `server.js`.
Handlers in `api/*.js` export `GET` / `POST` Web Fetch API functions,
and `server.js` mounts each one under `/api/*` by converting each
Express `req`/`res` into a Web `Request`/`Response` round-trip. The
audit below therefore:

- Adds a Web Fetch–native request helper (`api/_request.js`) that
  the handlers themselves use for CORS, client-IP resolution, and
  preflight handling.
- Adds an Express `server.js` that wires `trust proxy`, dynamic
  `cors`, and `express-rate-limit` to the same allowlist rules
  used by the helpers.
- Wires every existing handler with `withCors`, so the in-handler
  observability (the resolved client IP) and the platform-agnostic
  CORS path stay in one place.

The frontend (`public/app.js`, `public/hub.js`, `public/state.js`)
uses **relative paths** (`/api/generate-content`,
`/api/generate-daily-videos`, `/generator`). No hardcoded
deployment URLs were found in the frontend, so no frontend changes
were required for deployment-portability.

## Files added

### `api/_request.js`
- `getClientIp(request)` — resolves the real end-user IP. Order:
  `CF-Connecting-IP` → left-most `X-Forwarded-For` → `X-Real-IP` →
  `''`. Cloudflare sets `CF-Connecting-IP` for every orange-clouded
  request; when that is missing (local dev, direct origin hit) the
  fallback chain still returns a useful value.
- `isAllowedOrigin(origin)` — allowlist check. Matches either an
  exact origin from `ALLOWED_ORIGINS` or any host that shares the
  apex with `PUBLIC_URL` (so `https://instagen.app` and
  `https://www.instagen.app` are both allowed when `PUBLIC_URL=
  https://instagen.app`).
- `getCorsHeaders(request)` — returns CORS headers for an allowed
  request, `{}` otherwise. Never echoes a foreign origin back. Always
  sets `Vary: Origin` so Cloudflare's cache and the browser HTTP cache
  do not collapse per-origin responses.
- `handleOptions(request)` — preflight responder (204 with CORS
  headers, or 403 with no CORS headers for a rejected origin).
- `withCors(handler)` — higher-order wrapper that handles preflight,
  invokes the handler, and stamps CORS headers onto its response.
  Errors are caught and translated to a JSON 500 (with CORS headers
  attached, so the browser can read the body).
- `getPublicOrigin(request)` — resolves the canonical public origin
  (prefers `PUBLIC_URL`, falls back to the request's `X-Forwarded-
  Host`/`Host` + `X-Forwarded-Proto`). Used to build the MiniMax
  video callback URL so the webhook lands on the Cloudflare-fronted
  public host, not the raw deployment host.

### `server.js`
Reference Express bootstrap for Railway / Fly / a VM. Highlights:
- `app.set('trust proxy', true)` — Express walks the full
  `X-Forwarded-For` chain, so `req.ip` resolves to the real
  end-user IP, not a Cloudflare edge IP. The Cloudflare IPs
  documentation (well-known, published) makes `true` safe here.
- `cors()` with the **same** allowlist rules as `api/_request.js`,
  driven by `PUBLIC_URL` + `ALLOWED_ORIGINS`. No wildcard.
- Two-tier `express-rate-limit`:
  - **Global**: 200 req / 15 min / IP across all `/api/*`.
  - **Generation endpoints** (`/api/generate-content`,
    `/api/generate-daily-videos`): 10 req / 15 min / IP — each call
    fires 8 image generations + 1–2 LLM calls, so the cap is tight.
  - Both limiters key on `req.ip` (resolved via trust-proxy) and
    skip requests carrying the correct `x-internal-key` header
    (so Railway-internal smoke tests are not throttled).
- Static assets served from `public/` with the same `extension: ['html']`
  behavior (so `/generator` resolves to `generator.html`).
- API routes are mounted by re-using the Web Fetch handlers
  directly: an Express req/res is converted to a Web `Request` via
  `Request(url, { method, headers, body })`, handed to the handler,
  and the returned Web `Response` is written back to the Express
  res. This keeps the handler code single-source.

## Files changed

### `api/generate-content.js`
- Imports `withCors`, `getClientIp` from `_request.js`.
- `GET` and `POST` are now wrapped with `withCors` (was
  `export async function GET()`).
- POST logs `ctx.ip` (the resolved end-user IP) on entry for audit.

### `api/generate-daily-videos.js`
- Same CORS / IP changes as `generate-content.js`.
- The MiniMax video callback URL is now built from
  `getPublicOrigin(request)` (prefers `PUBLIC_URL`) and falls back
  to the request host. The webhook now lands on the public domain
  by default, where Cloudflare's WAF / rate-limiting / TLS already
  apply.

### `api/video-callback.js`
- Wrapped in `withCors` (the webhook itself is server-to-server, so
  the CORS path is dormant; the IP log is useful for audit).

### `api/video-status.js`
- Wrapped in `withCors`.

### `.env`
- `MINIMAX_API_KEY` line trimmed (the previous value accidentally
  contained the literal `MINIMAX_API_KEY=` prefix twice — fixed).
- New `PUBLIC_URL=` and `ALLOWED_ORIGINS=` placeholders, with
  inline documentation of the rules each one drives.

## How the Express (and Web Fetch) handler safely reads forwarded payloads under Cloudflare

When a request hits Cloudflare and is proxied to the origin
(Railway, Fly, Render, a VM — anything behind the orange cloud),
the following headers are added by Cloudflare on the way in:

| Header | Source | Use |
|---|---|---|
| `CF-Connecting-IP` | Cloudflare | The **authoritative** real end-user IP. Always set on orange-clouded traffic. |
| `X-Forwarded-For` | Chain of proxies | Append-only: each proxy adds its own IP. The left-most entry is the original client. |
| `X-Forwarded-Proto` | Cloudflare | Original scheme (`https` in production). |
| `X-Forwarded-Host` | Cloudflare | Original `Host` header (the public domain, not the deployment host). |
| `CF-Ray` | Cloudflare | Request ID for support tickets. |
| `True-Client-IP` (Enterprise) | Cloudflare | Same as `CF-Connecting-IP`, Enterprise only. |

**Trust order used in this codebase:**

1. `CF-Connecting-IP` first. It is set by Cloudflare, cannot be
   spoofed by the client (Cloudflare strips the inbound header
   before setting its own), and is the recommended authoritative
   source per Cloudflare's docs.
2. `X-Forwarded-For` left-most. The chain behind a Cloudflare
   proxy is `client, cloudflare-edge`. The first entry is the real
   client. We never read entries past the first — those are
   attacker-influenced.
3. `X-Real-IP`. Single-value analogue used by some proxies.
4. Empty string. The handler treats this as "unknown" rather than
   the loopback, so an unconfigured deployment doesn't accidentally
   rate-limit every request as if it came from `127.0.0.1`.

**What `app.set('trust proxy', true)` does in Express:**

Express's `req.ip` is computed by combining `req.connection.remoteAddress`
with the `X-Forwarded-For` chain. With `trust proxy = true`, Express
walks the entire chain and returns the left-most (original client)
entry. With `trust proxy = false` (the default), `req.ip` returns the
immediate upstream's IP — which under Cloudflare is one of the CF
edge IPs, useless for rate-limiting. Setting `trust proxy = true` is
the single switch that makes `express-rate-limit`, `req.ip`, and any
IP-aware security middleware see the real end-user IP.

**Why `Vary: Origin` matters on CORS responses:**

If two origins (`https://instagen.app` and `https://www.instagen.app`)
are both allowed, the response headers are identical except for
`Access-Control-Allow-Origin`. Without `Vary: Origin`, Cloudflare's
edge cache and the browser HTTP cache may serve origin A's response
to origin B's request — which would either leak B's data to A
(worse) or break B's CORS check (more common). The `Vary: Origin`
header tells every cache in the path to key the cache entry on the
Origin header value.

## Cloudflare-side checklist (not in this repo)

The DNS / WAF / TLS layer is configured in the Cloudflare dashboard,
not in the codebase. The settings that matter for this app:

1. **DNS** — orange-cloud the apex and any subdomain that fronts
   the deployment (`instagen.app`, `www.instagen.app`,
   `app.instagen.app`).
2. **SSL/TLS** — set mode to "Full (strict)". Cloudflare's origin
   certificate is installed at the deployment host; the visitor
   sees Cloudflare's edge cert.
3. **Network → WebSockets** — off (this app is HTTP-only).
4. **Security → Bots** — "Bot Fight Mode" on (or Super Bot Fight
   Mode, on paid plans).
5. **Security → WAF** — at least one rate-limit rule scoped to
   `/api/*` so the edge absorbs abuse before it reaches the origin
   (the in-app `express-rate-limit` is the second line of defense).
6. **Caching → Configuration** — by default Cloudflare does not
   cache API responses with `Content-Type: application/json`. If
   you turn on APO or similar, exclude `/api/*` explicitly.
7. **Rules → Transform Rules** — if you serve the static frontend
   through Cloudflare and the API through a different origin,
   add a redirect / rewrite so `/api/*` goes to the API origin
   and everything else goes to the static origin.
8. **Verify**: `curl -sI https://instagen.app/api/generate-content`
   should return `server: cloudflare` and a `cf-ray` header.

## What I did not change

- The MiniMax API URL (`api.minimax.io`) — that is the upstream
  service, not a deployment URL; it stays as a constant.

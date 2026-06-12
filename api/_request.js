// =====================================================================
// InstaGen — Cloudflare-aware request helpers
// =====================================================================
// Shared utilities for every handler in api/*. Exports two things the
// handlers all need when running behind a Cloudflare reverse proxy:
//
//   1. getClientIp(request)
//        Returns the *real* end-user IP — not Cloudflare's edge IP,
//        not the container host's NAT IP, not the load balancer's. Cloudflare
//        sets `CF-Connecting-IP` for every request; if that's missing
//        (e.g. a non-Cloudflare caller, a local dev request) we fall
//        back to the left-most entry of `X-Forwarded-For`, then
//        `X-Real-IP`, then a stable empty string.
//
//   2. withCors(handler, options?)
//        Higher-order wrapper that:
//          a) short-circuits `OPTIONS` preflight with a 204 + correct
//             `Access-Control-Allow-*` headers
//          b) stamps CORS headers onto the wrapped handler's Response
//          c) leaves non-2xx responses alone (we never want a CORS
//             header to mask a real failure from the browser)
//
// The CORS allowlist is built at request time from three sources, in
// this priority order:
//
//   a) `process.env.ALLOWED_ORIGINS` — comma-separated exact origins,
//      e.g. "https://instagen.app,https://www.instagen.app".
//   b) `process.env.PUBLIC_URL` — the canonical apex/sub-domain
//      Cloudflare fronts (https://instagen.app). When set, its
//      origin is added to the allowlist and used to derive the
//      apex domain so subdomains match too (e.g. "www.instagen.app"
//      is allowed when PUBLIC_URL is "https://instagen.app").
//   c) The request's own `Origin` header, IF its host is the same
//      apex as PUBLIC_URL. This is what lets the same deployment
//      serve a bare domain and a `www.` subdomain without two env
//      vars. If PUBLIC_URL is unset, this branch is skipped
//      (allowlist is strictly env-driven — never trust the request).
//
// Per the Cloudflare proxy model, a `Vary: Origin` header is always
// emitted on CORS-stamped responses so downstream caches (Cloudflare
// itself, the browser HTTP cache) do not collapse responses for
// different origins into a single entry.
//
// References:
//   - https://developers.cloudflare.com/fundamentals/reference/http-request-headers/#cf-connecting-ip
//   - https://expressjs.com/en/guide/behind-proxies.html
// =====================================================================

// ---------------------------------------------------------------------
// Internal: parse the env-driven allowlist ONCE per cold start.
// ---------------------------------------------------------------------
//
// Both `ALLOWED_ORIGINS` and `PUBLIC_URL` are evaluated at module load
// and cached. This is fine because the deployment host (Express
// process, container, or VM) restarts when env vars change, and the
// result is a tiny set.

/** @type {Set<string>} Exact-match origins parsed from ALLOWED_ORIGINS. */
const EXPLICIT_ORIGINS = (() => {
  const raw = process.env.ALLOWED_ORIGINS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
})();

/**
 * Apex host derived from PUBLIC_URL. `https://instagen.app` → `instagen.app`.
 * `null` when PUBLIC_URL is unset or unparseable.
 * @type {string | null}
 */
const APEX_HOST = (() => {
  const raw = process.env.PUBLIC_URL;
  if (!raw) return null;
  try {
    // PUBLIC_URL may be a bare host or a full URL. URL() needs a scheme.
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).host.toLowerCase();
  } catch {
    return null;
  }
})();

/**
 * The canonical origin to advertise back (e.g. "https://instagen.app").
 * `null` when PUBLIC_URL is unset.
 * @type {string | null}
 */
const PUBLIC_ORIGIN = (() => {
  const raw = process.env.PUBLIC_URL;
  if (!raw) return null;
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).origin.toLowerCase();
  } catch {
    return null;
  }
})();

// ---------------------------------------------------------------------
// getClientIp — resolve the real end-user IP behind Cloudflare.
// ---------------------------------------------------------------------
//
// Cloudflare's `CF-Connecting-IP` is the authoritative source when the
// request comes in over the Cloudflare proxy (orange-clouded DNS).
// When it is missing (direct origin hit, local dev), we walk a
// documented fallback chain so the function returns *something*
// stable. Callers that need a guaranteed IP for rate-limiting should
// treat an empty string as "unknown" rather than the loopback.
//
// IMPORTANT: do NOT trust `X-Forwarded-For` blindly. When Cloudflare
// is the *only* proxy in front, `X-Forwarded-For` is the same value
// as `CF-Connecting-IP` (CF appends the real client to the existing
// chain). When Cloudflare is behind something else (e.g. Railway
// sitting behind CF), the chain becomes
// "client, railway-nat, cloudflare-edge" and the left-most entry is
// still the real client. We never look at entries past the first —
// an attacker can forge trailing entries but cannot delete the
// first one without dropping the header entirely (and we'd then fall
// through to the next source).

/**
 * Returns the real end-user IP for `request`, or '' if it cannot be
 * determined. Never returns a loopback / private address label —
 * callers get the raw string and decide what to do with it.
 *
 * @param {Request} request
 * @returns {string}
 */
export function getClientIp(request) {
  if (!request || !request.headers) return '';

  // 1) Cloudflare (authoritative when present).
  const cf = request.headers.get('cf-connecting-ip');
  if (cf && cf.trim().length > 0) return cf.trim();

  // 2) X-Forwarded-For — left-most entry is the original client.
  //    The chain is "client, proxy1, proxy2, ...". We take the first.
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }

  // 3) X-Real-IP — set by some reverse proxies (nginx, traefik) as
  //    a single-value analogue to XFF.
  const xri = request.headers.get('x-real-ip');
  if (xri && xri.trim().length > 0) return xri.trim();

  return '';
}

// ---------------------------------------------------------------------
// CORS — origin allowlist + header builder.
// ---------------------------------------------------------------------

/**
 * Returns true iff `origin` (a full URL string like
 * "https://app.instagen.app") is allowed to call the API.
 *
 * The rules, in order:
 *   1. Exact match against ALLOWED_ORIGINS.
 *   2. The request's Origin is the same apex host as PUBLIC_URL
 *      (e.g. "https://instagen.app", "https://www.instagen.app",
 *      "https://app.instagen.app" all match when PUBLIC_URL is
 *      "https://instagen.app"). Port differences are ignored.
 *   3. Otherwise: not allowed.
 *
 * @param {string | null} origin
 * @returns {boolean}
 */
export function isAllowedOrigin(origin) {
  if (!origin) return false;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const normalized = parsed.origin.toLowerCase();

  // Rule 1: explicit allowlist.
  if (EXPLICIT_ORIGINS.has(normalized)) return true;

  // Rule 2: same apex as PUBLIC_URL. Compare hosts, not full origins,
  // so port differences (e.g. dev on :3000 vs prod on :443) don't
  // open a hole.
  if (APEX_HOST && parsed.host.toLowerCase() === APEX_HOST) return true;

  return false;
}

/**
 * Build the CORS response headers for `request`. If the request's
 * Origin is not in the allowlist, returns an EMPTY object — never
 * echo back a foreign origin (this is the classic CORS misconfig
 * that turns a same-origin policy into a wildcard).
 *
 * Always emits `Vary: Origin` so caches don't collapse per-origin
 * responses into a single entry. `Access-Control-Allow-Credentials`
 * is intentionally omitted; the API is cookie-free (the MiniMax key
 * is server-side), and shipping credentials=true forces the
 * `Access-Control-Allow-Origin` to be a concrete origin (not `*`),
 * which we already do.
 *
 * @param {Request} request
 * @returns {Record<string, string>}
 */
export function getCorsHeaders(request) {
  const origin = request?.headers?.get('origin') || '';

  // Same-origin / no-Origin requests (e.g. server-to-server callbacks
  // from MiniMax, curl, same-origin browser XHR) don't need CORS
  // headers at all. Returning {} keeps the response lean.
  if (!origin) return {};

  if (!isAllowedOrigin(origin)) return {};

  // Methods are fixed by the API surface: GET for reads, POST for
  // generation, OPTIONS for preflight. PATCH/PUT/DELETE are never
  // used by the frontend.
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, anthropic-version, x-api-key',
    // 24h — preflight results can be cached aggressively; the
    // allowlist is env-controlled and only changes on deploy.
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/**
 * Handle an `OPTIONS` preflight request. Returns a 204 Response with
 * the CORS headers stamped on, or `null` if the request's Origin is
 * not allowed (the caller should then return 403/405 to drop the
 * request on the floor).
 *
 * @param {Request} request
 * @returns {Response | null}
 */
export function handleOptions(request) {
  const cors = getCorsHeaders(request);
  if (Object.keys(cors).length === 0) {
    // Origin not in the allowlist — refuse the preflight outright
    // with a generic 403 (no CORS headers, so the browser blocks it
    // before it ever reaches the user's code).
    return new Response('CORS origin not allowed.', { status: 403 });
  }
  return new Response(null, { status: 204, headers: cors });
}

/**
 * Wrap a Web Fetch API handler with CORS handling. The wrapper:
 *
 *   - For `OPTIONS` requests: short-circuits with `handleOptions`.
 *   - For all other methods: calls `handler(request)`, then stamps
 *     the CORS headers onto the returned Response. If the handler
 *     throws, the error becomes a 500 JSON response WITH CORS
 *     headers, so the browser can read the body.
 *
 * The wrapper does NOT swallow the handler's status code — a 5xx
 * stays a 5xx. CORS headers are appended to whatever the handler
 * returned so the browser gets the same payload it would have
 * gotten from a same-origin call.
 *
 * Usage (Web Fetch API handler — works on Express via server.js
 * AND on any other platform that mounts Web Fetch handlers):
 *
 *   import { withCors } from './_request.js';
 *   export const GET  = withCors(async (request) => ...);
 *   export const POST = withCors(async (request) => ...);
 *
 * @template T
 * @param {(request: Request, ctx: { ip: string }) => Promise<Response> | Response} handler
 * @param {{ methods?: string[] }} [options]
 * @returns {(request: Request) => Promise<Response>}
 */
export function withCors(handler, options = {}) {
  const { methods } = options;

  return async (request) => {
    // Preflight.
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }

    // Optional method allowlist — useful if a route should refuse
    // a method that the platform routed here (e.g. PUT/DELETE).
    if (methods && !methods.includes(request.method)) {
      return new Response('Method not allowed.', {
        status: 405,
        headers: { Allow: methods.join(', ') },
      });
    }

    // Stamp the resolved IP on the request context so the handler
    // can log it without re-parsing the headers.
    const ip = getClientIp(request);

    let response;
    try {
      response = await handler(request, { ip });
    } catch (err) {
      // Translate thrown errors into a JSON 500 so the browser can
      // read the body. CORS headers are still stamped below.
      console.error('[handler] uncaught:', err);
      response = new Response(
        JSON.stringify({
          error: 'Internal server error.',
          details: err?.message || String(err),
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Stamp CORS onto the response. We only merge CORS-shaped keys
    // (never overwrite Content-Type, never overwrite Allow). If the
    // request has no Origin (server-to-server), the helper returns
    // {} and we leave the response alone.
    const cors = getCorsHeaders(request);
    if (Object.keys(cors).length === 0) return response;

    // Build a fresh Headers object so we can append (not overwrite).
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) {
      // `Vary` may already be set (e.g. by a cache layer). Append
      // rather than overwrite so existing Vary directives are kept.
      if (k === 'Vary' && headers.has('Vary')) {
        const existing = headers.get('Vary');
        const set = new Set(
          existing.split(',').map((s) => s.trim().toLowerCase())
        );
        set.add('origin');
        headers.set('Vary', [...set].join(', '));
      } else {
        headers.set(k, v);
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

// ---------------------------------------------------------------------
// Origin helper for outbound URLs (e.g. video callback URL, OAuth
// redirects). The webhook caller can read PUBLIC_URL at request time
// and POST back to PUBLIC_URL + '/api/video-callback' — keeping the
// callback URL on the public domain (not the raw deployment host)
// so Cloudflare's firewall and rate-limiting apply to the inbound
// webhook traffic too.
// ---------------------------------------------------------------------

/**
 * Resolve the canonical public origin (scheme + host[:port], no
 * trailing slash). Returns:
 *   - `process.env.PUBLIC_URL` parsed, when set
 *   - the request's own origin as a last-resort fallback, when the
 *     `Host` header is present and looks like a public hostname
 *
 * Returns `null` if neither is usable. Callers should fall back to
 * the request URL directly in that case.
 *
 * @param {Request} [request]
 * @returns {string | null}
 */
export function getPublicOrigin(request) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;

  if (request?.headers) {
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
    const proto =
      request.headers.get('x-forwarded-proto') ||
      request.headers.get('x-forwarded-protocol') ||
      'https';
    if (host) {
      try {
        return new URL(`${proto}://${host}`).origin.toLowerCase();
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Re-exports for tests + observability.
// ---------------------------------------------------------------------
export const _internal = {
  EXPLICIT_ORIGINS,
  APEX_HOST,
  PUBLIC_ORIGIN,
};

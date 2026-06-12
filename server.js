// =====================================================================
// InstaGen — Express server
// =====================================================================
// The application's runtime entrypoint. This file is the Express
// bootstrap for running InstaGen on a long-lived Node.js process
// (Railway, Fly, Render, a VM, etc.). Every request to /api/* is
// routed through the same Web Fetch API handler exported from
// api/*.js — server.js converts each Express req/res into a Web
// Request/Response round-trip so the handler code stays single-
// source and platform-agnostic.
//
// Three things this file does that the handlers themselves cannot:
//
//   1. Trust proxy. Express's `app.set('trust proxy', ...)` is the
//      single switch that makes `req.ip` and `req.ips` return the
//      real end-user IP behind Cloudflare. Without it, every IP-
//      aware middleware (rate limiters, security middleware, even
//      the built-in `req.ip` returned to the handler) sees a CF
//      edge IP. We set it to `true` so Express walks the full
//      X-Forwarded-For chain — safe because Cloudflare is the only
//      proxy the deployment expects to be behind.
//
//   2. Real rate-limiting. `express-rate-limit` keyed on the real
//      end-user IP, with sensible defaults (200 req / 15 min) and
//      a stricter cap on the expensive generation endpoint. The
//      limit bypasses the loopback and bypasses requests with a
//      valid `x-internal-key` header so smoke tests from the
//      container's own network don't get throttled.
//
//   3. Static asset hosting. The same `public/` folder is served
//      by `express.static` so a single repo deploys without needing
//      a separate static-only host.
//
// Required env:
//   MINIMAX_API_KEY
//   PUBLIC_URL                       (e.g. "https://instagen.app")
//   ALLOWED_ORIGINS                  (optional, comma-separated)
//   PORT                             (default 3000)
//   INTERNAL_KEY                     (optional, bypasses rate limit
//                                     when present in x-internal-key)
// =====================================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------
// Dynamic CORS — same allowlist rules as api/_request.js
// ---------------------------------------------------------------------
// Reads PUBLIC_URL + ALLOWED_ORIGINS at boot, then evaluates the
// incoming Origin header against the resulting allowlist on every
// request. The result is a per-request `Access-Control-Allow-Origin`
// header (never the wildcard `*` when credentials are present, and
// never an echoed-back foreign origin). The Vary: Origin header is
// always emitted so Cloudflare's cache and the browser HTTP cache
// do not collapse per-origin responses.

const PUBLIC_URL = process.env.PUBLIC_URL || '';
const APEX_HOST = (() => {
  if (!PUBLIC_URL) return null;
  try {
    const withScheme = /^https?:\/\//i.test(PUBLIC_URL)
      ? PUBLIC_URL
      : `https://${PUBLIC_URL}`;
    return new URL(withScheme).host.toLowerCase();
  } catch {
    return null;
  }
})();

const EXPLICIT_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const normalized = parsed.origin.toLowerCase();
  if (EXPLICIT_ORIGINS.has(normalized)) return true;
  if (APEX_HOST && parsed.host.toLowerCase() === APEX_HOST) return true;
  return false;
}

const corsOptions = {
  // Per-request origin check. Returning false (instead of the
  // string `false`) makes cors() reflect the absence of the
  // Access-Control-Allow-Origin header, which the browser treats
  // as a CORS failure — exactly what we want for unknown origins.
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'anthropic-version',
    'x-api-key',
  ],
  maxAge: 86400,
};

// ---------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Trust the full X-Forwarded-For chain. Cloudflare is the only
// proxy in front (orange-clouded DNS), and Cloudflare's edge IPs
// are well-known. Setting `true` makes Express walk every entry
// in X-Forwarded-For when computing `req.ip`; the left-most entry
// is the real client (Cloudflare appends the client IP and then
// appends its own edge IP). `req.ip` now resolves to the real
// end-user IP, so express-rate-limit and any future security
// middleware that reads `req.ip` will key on the right value.
//
// If you ever need to harden this further (e.g. accept proxy
// headers ONLY from Cloudflare's published IP ranges), swap
// `true` for a custom function:
//   app.set('trust proxy', (ip) =>
//     CLOUDFLARE_IPS.includes(ip) || ip === '::ffff:127.0.0.1');
app.set('trust proxy', true);

// Behind Cloudflare the `X-Forwarded-Proto` header is set to
// `https`, which makes `req.secure` return true — required for
// any future code that gates features on HTTPS (secure cookies,
// HSTS, etc.).
app.disable('x-powered-by');

// Web Fetch API handlers expect a raw `Request` body. Capture
// the parsed body so the Web Fetch handler can re-serialize it
// without re-reading the stream.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// CORS — applied to /api/* only. Static assets are same-origin
// (the static middleware serves them) and do not need CORS.
app.use('/api', cors(corsOptions));

// ---------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------
// Two tiers:
//   - Global: 200 req / 15 min / IP across /api/* (broad protection)
//   - Generation endpoints: 10 req / 15 min / IP (expensive, since
//     each call fires 8 image generations and 1-2 LLM calls)
//
// keyGenerator is explicit (Express 7 deprecates the default that
// uses req.ip without opt-in) and reads the resolved client IP from
// the trust-proxy chain. skip() lets the smoke-test INTERNAL_KEY
// bypass the cap.

const internalKey = process.env.INTERNAL_KEY || '';
const ipKey = (req) => `ip:${req.ip}`;

const globalLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  skip: (req) =>
    Boolean(internalKey) && req.header('x-internal-key') === internalKey,
  message: { error: 'Too many requests, please slow down.' },
});

const generationLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  skip: (req) =>
    Boolean(internalKey) && req.header('x-internal-key') === internalKey,
  message: { error: 'Generation rate limit exceeded. Try again in 15 min.' },
});

app.use('/api', globalLimiter);
app.use(['/api/generate-content', '/api/generate-daily-videos'], generationLimiter);

// ---------------------------------------------------------------------
// /api/* — mount the Web Fetch API handlers from api/*.js
// ---------------------------------------------------------------------
// Each handler in api/* exports `GET` and/or `POST` as Web Fetch API
// functions. We convert each Express req/res into a Web Request,
// hand it to the handler, and write the returned Web Response back
// to the Express res. The handler code is platform-agnostic — it
// doesn't know whether it is running on Express, Workers, Deno, or
// Bun, as long as the runtime speaks Web Fetch.

const apiHandlers = {
  'generate-content':       (await import('./api/generate-content.js')),
  'generate-daily-videos':  (await import('./api/generate-daily-videos.js')),
  'video-callback':         (await import('./api/video-callback.js')),
  'video-status':           (await import('./api/video-status.js')),
};

function mountApiRoute(slug, mod) {
  // Per-method: pick GET vs POST from the module exports, mount.
  const getHandler = typeof mod.GET === 'function' ? mod.GET : null;
  const postHandler = typeof mod.POST === 'function' ? mod.POST : null;

  if (getHandler) {
    app.get(`/api/${slug}`, async (req, res, next) => {
      try {
        await runHandler(getHandler, req, res);
      } catch (err) {
        next(err);
      }
    });
  }
  if (postHandler) {
    app.post(`/api/${slug}`, async (req, res, next) => {
      try {
        await runHandler(postHandler, req, res);
      } catch (err) {
        next(err);
      }
    });
  }
}

async function runHandler(handler, req, res) {
  // Build a Web Request from Express's req. We construct the Web
  // Request ourselves (rather than using a requestListener adapter)
  // so the trust-proxy-derived `req.ip` and any req-scoped state
  // (cookies, signed headers) are preserved before the handler runs.
  const proto = req.protocol;
  const host = req.get('host');
  const url = `${proto}://${host}${req.originalUrl}`;
  const method = req.method;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else if (v != null) headers.set(k, String(v));
  }
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    // express.json() has already parsed the body; re-serialize it
    // for the Web Fetch handler. For raw streams (octet-stream,
    // multipart) the handler should be re-designed to read a
    // stream — none of our current handlers take that shape.
    body = req.body && Object.keys(req.body).length > 0
      ? JSON.stringify(req.body)
      : undefined;
  }
  const webRequest = new Request(url, { method, headers, body });
  const webResponse = await handler(webRequest);
  // Convert the Web Response back to Express res.
  res.status(webResponse.status);
  webResponse.headers.forEach((v, k) => res.setHeader(k, v));
  // Body may be a stream (image data), JSON, or null. Buffer when
  // small; for large responses, prefer streaming. For this app,
  // the only large responses are the image proxy which already
  // returns data: URLs to the browser, so the body is always
  // small enough to buffer.
  const buf = webResponse.body ? Buffer.from(await webResponse.arrayBuffer()) : null;
  res.end(buf);
}

for (const [slug, mod] of Object.entries(apiHandlers)) {
  mountApiRoute(slug, mod);
}

// Health check.
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    apiKeyConfigured: Boolean(process.env.MINIMAX_API_KEY),
  });
});

// ---------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------
// Static assets — serve public/ via express.static. The
// `extensions: ['html']` option makes /generator resolve to
// /generator.html automatically (clean URL).

const publicDir = resolve(__dirname, 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));

// Explicit clean-URL routes (so /generator and / both work even
// when the static lookup order would otherwise be ambiguous).
app.get('/generator', (_req, res) => res.sendFile(resolve(publicDir, 'generator.html')));
app.get('/', (_req, res) => res.sendFile(resolve(publicDir, 'index.html')));

// ---------------------------------------------------------------------
// Error handler — last resort. Always returns JSON so the browser
// can read the body even when something inside the pipeline threw.
// ---------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[express] uncaught:', err);
  res.status(500).json({
    error: 'Internal server error.',
    details: err?.message || String(err),
  });
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[instagen] listening on :${PORT}`);
  console.log(`[instagen] PUBLIC_URL=${PUBLIC_URL || '(unset)'}`);
  console.log(`[instagen] CORS apex=${APEX_HOST || '(unset)'} explicit=${[...EXPLICIT_ORIGINS].join(',') || '(none)'}`);
});

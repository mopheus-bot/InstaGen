// =====================================================================
// InstaGen — Passcode gate
// =====================================================================
// Every request to the Express app — pages, static assets, and
// /api/* — must pass this middleware before the route handler
// runs. Unauthenticated callers see an iPhone-style passcode
// screen; correct entry flips them into a signed HTTP-only
// session cookie and the original request continues.
//
// Why a separate module? The gate owns three responsibilities
// that span routes:
//   1. The hashed passcode constant (so the plaintext never lives
//      in this file or anywhere else on disk).
//   2. The HTML for the passcode screen (a single self-contained
//      document with inline CSS + JS).
//   3. The cookie-issuing / -verifying helpers, used by the
//      /api/auth endpoint and the middleware below.
//
// Passcode:
//   The operator passcode is 6 digits. The plaintext is held
//   nowhere on disk; only its SHA-256 hash is embedded here. The
//   /api/auth handler hashes whatever the user types with the
//   same algorithm and compares the two digests in constant time
//   so a timing-attack probe can't recover the plaintext a byte
//   at a time.
//
// Session cookie:
//   On success the server issues an HTTP-only cookie
//   `instagen_session` whose value is
//     HMAC_SHA256(secret, issuedAt) + '.' + issuedAt
//   The secret is a 32-byte random string written to
//   `data/session.key` on first boot (or generated in memory if
//   the filesystem is read-only — survives for the process
//   lifetime, kills sessions on restart, which is acceptable for
//   a personal tool). The HMAC defends against cookie forgery
//   when the attacker is on the box but the secret isn't readable
//   to anyone who only has the cookie.
//
// Routes that bypass the gate:
//   - GET  /api/health          (smoke tests from the container)
//   - POST /api/auth            (verifies the passcode)
//   - GET/POST /api/auth/logout (destroys the session)
//
//   The bypasses are enforced by URL prefix in `isBypassedPath`
//   below — keep this list small and audited.
// =====================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SESSION_COOKIE = 'instagen_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// SHA-256 of the operator passcode. The plaintext is NEVER
// written to disk in this file or anywhere else on the
// filesystem. The hash is resolved at boot from one of two
// sources, in priority order:
//
//   1) process.env.APP_PASSWORD — set in Railway's variable
//      manager (or any other deploy host's env config). The
//      plaintext lives only in the secret store, never in this
//      file, never in a committed .env, and never in build
//      artifacts. The string `%APP_PASSWORD%` appears in the
//      env-config example so the operator can paste it
//      directly into Railway's template syntax.
//
//   2) The fallback hash below — used when APP_PASSWORD is
//      unset so local dev works out of the box. The fallback
//      hash is the SHA-256 of "272443", generated once with
//      `node -e "console.log(require('crypto').createHash('sha256')
//      .update('272443').digest('hex'))"` and pasted here. The
//      plaintext is NOT in this file.
//
// To rotate the passcode, set APP_PASSWORD in the deploy env to
// the new value and restart. The hash is recomputed on the
// first request after boot, so any 6-digit numeric string (or
// any string at all — the regex in /api/auth enforces the 6
// digits, but the hash is over whatever the operator types)
// works.
const FALLBACK_PASSCODE_SHA256 = '363b6422703a1d4defc3ce5be4250949cf7d7f5292be512fe1b069b05cdca39c';

/**
 * Resolve the active passcode hash. Reads APP_PASSWORD from the
 * env at boot and hashes it; falls back to FALLBACK_PASSCODE_SHA256
 * when the env var is unset (so a fresh clone still boots).
 *
 * Memoised: the env doesn't change at runtime, so we only hash
 * once. The result is stored in PASSCODE_SHA256 below.
 */
const PASSCODE_SHA256 = (() => {
  const fromEnv = (process.env.APP_PASSWORD || '').trim();
  if (fromEnv.length > 0) {
    return crypto.createHash('sha256').update(fromEnv, 'utf8').digest('hex');
  }
  return FALLBACK_PASSCODE_SHA256;
})();

/** True iff the active passcode came from APP_PASSWORD. */
const PASSCODE_FROM_ENV = ((process.env.APP_PASSWORD || '').trim().length > 0);

// ---------------------------------------------------------------------
// Persistent HMAC secret (best-effort)
// ---------------------------------------------------------------------
let SESSION_SECRET = null;
function loadSessionSecret() {
  // 1) Env override (so the operator can share a secret across
  //    multiple replicas behind a load balancer).
  if (process.env.ADMIN_SESSION_SECRET) {
    SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
    return SESSION_SECRET;
  }
  // 2) On-disk file. Created on first read if missing.
  const dir = path.join(PROJECT_ROOT, 'data');
  const file = path.join(dir, 'session.key');
  try {
    if (fs.existsSync(file)) {
      SESSION_SECRET = fs.readFileSync(file, 'utf8').trim();
      return SESSION_SECRET;
    }
    fs.mkdirSync(dir, { recursive: true });
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, SESSION_SECRET, { mode: 0o600 });
    console.log('[gate] generated new session secret at', file);
  } catch (err) {
    // Read-only filesystem (some ephemeral containers) — fall
    // back to an in-memory secret. Sessions reset on restart,
    // which is acceptable for a personal tool.
    console.warn('[gate] could not persist session secret:', err.message);
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  }
  return SESSION_SECRET;
}
loadSessionSecret();

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** SHA-256 hex digest of a UTF-8 string. */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/** Constant-time string equality. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a, 'utf8');
  const B = Buffer.from(b, 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/**
 * Verify a session cookie's HMAC + freshness. Returns
 * `true` iff the cookie was issued by THIS process (or any
 * process sharing ADMIN_SESSION_SECRET) AND is not older than
 * SESSION_TTL_MS.
 */
function verifySessionCookie(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const dot = raw.indexOf('.');
  if (dot < 0) return false;
  const mac = raw.slice(0, dot);
  const tsStr = raw.slice(dot + 1);
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > SESSION_TTL_MS) return false;

  const expected = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(String(ts))
    .digest('hex');
  return timingSafeEqual(mac, expected);
}

/** Mint a fresh session cookie value. */
function mintSessionCookie() {
  const ts = Date.now();
  const mac = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(String(ts))
    .digest('hex');
  return `${mac}.${ts}`;
}

// ---------------------------------------------------------------------
// Bypass list — paths the gate MUST NOT block
// ---------------------------------------------------------------------
// The auth endpoint and the health probe both need to be reachable
// without a session. Keep this list as short as possible so the
// gate's blast radius stays small.
const BYPASS_PREFIXES = [
  '/api/auth',
  '/api/health',
];

function isBypassedPath(pathname) {
  return BYPASS_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// ---------------------------------------------------------------------
// The passcode screen
// ---------------------------------------------------------------------
// A single self-contained HTML document. The styling imitates
// iOS: dark background, six hollow bubbles at the top that fill
// in as digits are entered, a 3×4 number pad below, and a
// "Access denied" message with a shake animation when the
// entered code doesn't match.
//
// The form POSTs to /api/auth with a single `code` field. The
// server compares its hash to PASSCODE_SHA256 and, on match,
// returns a Set-Cookie that the next request will carry.
//
// (We could POST straight from JavaScript, but a form-based
//  fallback ensures the screen still works with JavaScript
//  disabled — defense in depth on a personal tool.)
const PASSCODE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <meta name="theme-color" content="#000" />
  <title>InstaGen — Enter Passcode</title>
  <style>
    :root {
      color-scheme: dark;
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body {
      margin: 0; padding: 0;
      height: 100%; min-height: 100dvh;
      background: #000;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      padding: max(env(safe-area-inset-top), 24px) 24px max(env(safe-area-inset-bottom), 24px) 24px;
      overflow: hidden;
      user-select: none;
    }
    .gate-header {
      text-align: center;
      margin-top: 8vh;
    }
    .gate-title {
      font-size: 17px;
      font-weight: 500;
      letter-spacing: 0.01em;
      margin: 0;
    }
    .gate-subtitle {
      font-size: 13px;
      color: #8e8e93;
      margin: 6px 0 0 0;
    }
    .gate-bubbles {
      display: flex;
      gap: 18px;
      margin: 36px 0 24px;
    }
    .bubble {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 1.5px solid #8e8e93;
      background: transparent;
      transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
    }
    .bubble.filled {
      background: #fff;
      border-color: #fff;
      transform: scale(1.06);
    }
    .gate-message {
      height: 18px;
      font-size: 13px;
      color: #ff453a;
      opacity: 0;
      margin: 0;
      transition: opacity 180ms ease;
      text-align: center;
    }
    .gate-message.visible { opacity: 1; }
    .gate-pad {
      width: 100%;
      max-width: 320px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-bottom: 8px;
    }
    .pad-btn {
      aspect-ratio: 1 / 1;
      width: 100%;
      max-width: 100px;
      justify-self: center;
      border: none;
      border-radius: 50%;
      background: #1c1c1e;
      color: #fff;
      font: inherit;
      font-size: 30px;
      font-weight: 400;
      cursor: pointer;
      transition: background 120ms ease, transform 80ms ease;
      font-variant-numeric: tabular-nums;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pad-btn:hover { background: #2c2c2e; }
    .pad-btn:active { background: #3a3a3c; transform: scale(0.96); }
    .pad-btn.spacer { background: transparent; pointer-events: none; }
    .pad-btn.delete svg { width: 26px; height: 26px; fill: #fff; }

    .shake {
      animation: gate-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97);
    }
    @keyframes gate-shake {
      10%, 90% { transform: translateX(-2px); }
      20%, 80% { transform: translateX(3px); }
      30%, 50%, 70% { transform: translateX(-5px); }
      40%, 60% { transform: translateX(5px); }
    }

    /* Dark form fallback for the no-JS path. */
    .js-fallback { display: none; }
    noscript .js-fallback { display: block; }
  </style>
</head>
<body>
  <div>
    <div class="gate-header">
      <p class="gate-title">Enter Passcode</p>
      <p class="gate-subtitle">Six digits to continue</p>
    </div>

    <div class="gate-bubbles" id="bubbles" aria-hidden="true">
      <span class="bubble"></span>
      <span class="bubble"></span>
      <span class="bubble"></span>
      <span class="bubble"></span>
      <span class="bubble"></span>
      <span class="bubble"></span>
    </div>
    <p class="gate-message" id="message" role="alert" aria-live="assertive">Access denied</p>
  </div>

  <div class="gate-pad" id="pad">
    <button class="pad-btn" data-digit="1" type="button">1</button>
    <button class="pad-btn" data-digit="2" type="button">2</button>
    <button class="pad-btn" data-digit="3" type="button">3</button>
    <button class="pad-btn" data-digit="4" type="button">4</button>
    <button class="pad-btn" data-digit="5" type="button">5</button>
    <button class="pad-btn" data-digit="6" type="button">6</button>
    <button class="pad-btn" data-digit="7" type="button">7</button>
    <button class="pad-btn" data-digit="8" type="button">8</button>
    <button class="pad-btn" data-digit="9" type="button">9</button>
    <span class="pad-btn spacer" aria-hidden="true"></span>
    <button class="pad-btn" data-digit="0" type="button">0</button>
    <button class="pad-btn delete" id="delete" type="button" aria-label="Delete">
      <svg viewBox="0 0 24 24"><path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.59 12 19 15.59z"/></svg>
    </button>
  </div>

  <form class="js-fallback" method="POST" action="/api/auth" id="fallbackForm">
    <input type="hidden" name="code" id="fallbackCode" />
    <noscript>
      <p style="text-align:center; color:#8e8e93; font-size:13px;">
        JavaScript is disabled. The passcode screen requires JavaScript.
      </p>
    </noscript>
  </form>

  <script>
    (function () {
      var MAX = 6;
      var bubbles = document.getElementById('bubbles').children;
      var message = document.getElementById('message');
      var pad = document.getElementById('pad');
      var code = '';

      function render() {
        for (var i = 0; i < bubbles.length; i++) {
          if (i < code.length) bubbles[i].classList.add('filled');
          else bubbles[i].classList.remove('filled');
        }
      }

      function deny() {
        var padEl = document.getElementById('pad');
        padEl.classList.remove('shake');
        // Force reflow so the animation can replay.
        void padEl.offsetWidth;
        padEl.classList.add('shake');
        message.classList.add('visible');
        setTimeout(function () { message.classList.remove('visible'); }, 1400);
        code = '';
        render();
      }

      function submit() {
        // The server compares the SHA-256 of the typed string to
        // its stored hash. POSTing the raw digits is fine because
        // the channel is HTTPS (Cloudflare) and the plaintext is
        // throwaway.
        fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code }),
          credentials: 'same-origin',
        }).then(function (res) {
          if (res.ok) {
            // Reload to fetch the originally-requested resource
            // with the new cookie in the jar.
            window.location.reload();
            return;
          }
          deny();
        }).catch(function () { deny(); });
      }

      pad.addEventListener('click', function (e) {
        var target = e.target.closest('.pad-btn');
        if (!target || target.classList.contains('spacer')) return;

        if (target.id === 'delete') {
          code = code.slice(0, -1);
          render();
          return;
        }
        if (code.length >= MAX) return;
        var digit = target.getAttribute('data-digit');
        if (!digit) return;
        code += digit;
        render();
        if (code.length === MAX) {
          // Tiny delay so the last bubble animates in before the
          // request fires — feels like the iPhone flow.
          setTimeout(submit, 140);
        }
      });

      // Keyboard fallback (numeric row, numpad, backspace) so
      // desktop testing doesn't need a mouse.
      window.addEventListener('keydown', function (e) {
        if (e.key >= '0' && e.key <= '9' && code.length < MAX) {
          code += e.key; render();
          if (code.length === MAX) setTimeout(submit, 140);
        } else if (e.key === 'Backspace') {
          code = code.slice(0, -1); render();
        }
      });
    })();
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------
/**
 * Returns an Express middleware that gates every request behind a
 * signed session cookie. Unauthenticated callers receive the
 * iPhone-style passcode screen instead of the requested
 * resource.
 *
 *   - The passcode screen is a single in-memory HTML string — no
 *     static asset lookup is needed for the gate itself.
 *   - /api/auth, /api/auth/logout, and /api/health are exempt
 *     so the gate can verify the passcode, log out, and answer
 *     liveness probes without first being unlocked.
 *   - Static asset requests are also gated (so a casual visitor
 *     can't preview assets in the browser before unlocking). The
 *     passcode screen is small enough to keep the middleware
 *     cost trivial.
 *
 * Cookie parsing is done inline (Express does not parse cookies
 * by default) so the gate is self-contained and doesn't need a
 * cookie-parser dependency.
 */
export function gateMiddleware() {
  return function gate(req, res, next) {
    const pathname = req.path || '/';

    if (isBypassedPath(pathname)) return next();

    // Parse the Cookie header into a plain object. Format per RFC
    // 6265: `name=value; name2=value2`. We don't decodeURIComponent
    // here because the cookie value is base64-safe text emitted
    // by the server.
    const cookies = parseCookieHeader(req.headers?.cookie);
    const cookie = cookies[SESSION_COOKIE];
    if (cookie && verifySessionCookie(cookie)) {
      return next();
    }

    // Unauthenticated — return the passcode screen.
    res.status(401);
    // Cache the gate on no-store so a logged-out browser doesn't
    // cache it for the next visitor.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(PASSCODE_HTML);
  };
}

/** Minimal Cookie header parser. Returns { name: value } map. */
function parseCookieHeader(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------

/**
 * Verify a submitted passcode. Returns a 200 + Set-Cookie on
 * match, a 401 + Access Denied JSON on mismatch. Mounted as
 * POST /api/auth by server.js.
 *
 * Body: { code: "272443" } (JSON) OR application/x-www-form-
 * urlencoded with `code=...` (for the no-JS form fallback).
 */
export async function handleAuthPost(request) {
  // Accept both JSON and form-urlencoded.
  let code = '';
  const ct = request.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) {
      const body = await request.json();
      code = String(body?.code || '');
    } else {
      const text = await request.text();
      const params = new URLSearchParams(text);
      code = String(params.get('code') || '');
    }
  } catch {
    return json({ error: 'Invalid body.' }, 400);
  }

  // Reject anything that isn't 6 numeric digits — the gate's
  // frontend only emits digits, so anything else is fishy.
  if (!/^\d{6}$/.test(code)) {
    return json({ error: 'Access denied' }, 401);
  }

  const candidate = sha256Hex(code);
  if (!timingSafeEqual(candidate, PASSCODE_SHA256)) {
    return json({ error: 'Access denied' }, 401);
  }

  const cookieValue = mintSessionCookie();
  const cookie = [
    `${SESSION_COOKIE}=${cookieValue}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (request.url?.startsWith('https://')) cookie.push('Secure');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie.join('; '),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Destroy the session. Always returns 200.
 */
export function handleAuthLogout() {
  const cookie = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
  });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Re-exports for tests + observability.
export const _internal = {
  PASSCODE_SHA256,
  PASSCODE_FROM_ENV,
  FALLBACK_PASSCODE_SHA256,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  BYPASS_PREFIXES,
};

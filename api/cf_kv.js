// =====================================================================
// InstaGen — Cloudflare KV client
// =====================================================================
// Minimal REST client for the three operations InstaGen needs from
// Cloudflare KV: get, put (with TTL), delete. The KV namespace is
// used as the persistent metadata store for the daily content
// (carousels + videos) — bytes go to R2 (cf_r2.js), not here, so
// a 1 GB KV cap is enough for years of metadata.
//
// Auth:  Authorization: Bearer {CF_API_TOKEN}
// Base:  https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}
//        /storage/kv/namespaces/{CF_KV_NAMESPACE_ID}
//
// Env (all optional — the client no-ops cleanly when missing, so
// dev / local CI works without a Cloudflare account):
//   CF_API_TOKEN         API token scoped to the namespace (KV edit)
//   CF_ACCOUNT_ID        Cloudflare account id
//   CF_KV_NAMESPACE_ID   KV namespace id
//
// Failure mode: any error from Cloudflare is LOGGED and swallowed
// at the call site (setDailyContent / getDailyContent) so a KV
// outage never breaks a content-generation call. The in-memory
// store is the fallback that keeps the system functional during
// a KV incident.
// =====================================================================

const KV_BASE = (() => {
  const account = process.env.CF_ACCOUNT_ID;
  const ns      = process.env.CF_KV_NAMESPACE_ID;
  if (!account || !ns) return null;
  return `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}`;
})();
// Accept either the new CLOUDFLARE_API_TOKEN or the legacy CF_API_TOKEN
// so an operator can wire either name in their env without renaming.
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || null;

/**
 * Is the KV layer actually configured? Use this to short-circuit
 * setDailyContent's KV write when the user hasn't wired Cloudflare
 * (saves a network round-trip + a noisy 401 in the log).
 */
export function kvConfigured() {
  return Boolean(KV_BASE && CF_TOKEN);
}

/**
 * GET a value by key. Returns the RAW STRING (we store JSON-stringified
 * values). Returns `null` on:
 *   - KV unconfigured (graceful no-op)
 *   - 404 (key missing — the normal "no content for today" case)
 *   - any other non-2xx (logged + swallowed)
 */
export async function kvGet(key) {
  if (!kvConfigured()) return null;
  const url = `${KV_BASE}/values/${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${CF_TOKEN}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`[cf_kv] GET ${key} → ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.error(`[cf_kv] GET ${key} failed:`, err.message);
    return null;
  }
}

/**
 * PUT a value with an optional `expiration_ttl` (seconds). We always
 * JSON-stringify `value` so the read path can JSON.parse it
 * uniformly. Returns true on 2xx, false on any other outcome.
 *
 * The TTL of "seconds until next local midnight" is what makes
 * metadata auto-expire at the day boundary — no manual kvDelete
 * call needed for the daily flush.
 */
export async function kvPut(key, value, ttlSeconds) {
  if (!kvConfigured()) return false;
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const url = new URL(`${KV_BASE}/values/${encodeURIComponent(key)}`);
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    // Cloudflare accepts fractional seconds. Round up to the next
    // whole second so the boundary is never undershot.
    url.searchParams.set('expiration_ttl', String(Math.ceil(ttlSeconds)));
  }
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[cf_kv] PUT ${key} → ${res.status}: ${errBody.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[cf_kv] PUT ${key} failed:`, err.message);
    return false;
  }
}

/**
 * DELETE a key. Used by the admin "flush-daily" action and by the
 * midnight-flush safety net (the primary flush mechanism is the
 * KV TTL, but a manual override is useful for ops).
 */
export async function kvDelete(key) {
  if (!kvConfigured()) return false;
  const url = `${KV_BASE}/values/${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${CF_TOKEN}` },
    });
    // 404 is fine — the entry was already gone.
    if (!res.ok && res.status !== 404) {
      console.error(`[cf_kv] DELETE ${key} → ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[cf_kv] DELETE ${key} failed:`, err.message);
    return false;
  }
}

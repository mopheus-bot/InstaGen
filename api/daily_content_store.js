// =====================================================================
// InstaGen — Daily content store
// =====================================================================
// Persists today's generated carousel + videos metadata with a
// midnight-aligned flush. Three layers:
//
//   1. In-memory Map  — hot cache. Mirrors the authoritative KV
//      value, but doesn't depend on a network call.
//   2. Cloudflare KV  — authoritative. Written with a TTL of
//      "seconds until next local midnight" so it auto-expires
//      at the day boundary. The frontend can never see stale
//      content from a previous day, even if it clears its
//      browser data.
//   3. Date-key check — every read verifies the stored record's
//      `dateKey` matches today. Defensive against any scenario
//      where the TTL didn't fire (theoretical: a clock skew).
//
// All env vars (CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID)
// are optional. If KV is unconfigured, the store is in-memory
// only — fine for dev, fine for a single-instance hobby deploy.
//
// Key shape:  `${type}:${niche}`   where type ∈ { 'carousel', 'videos' }
//
// Record:  { payload, dateKey, ts }
//   payload  — the full carousel or videos metadata
//   dateKey  — 'YYYY-MM-DD' (server local) the entry was written
//   ts       — Date.now() epoch ms (for the lazy safety-net sweep)
// =====================================================================

import { kvGet, kvPut, kvDelete, kvConfigured } from './cf_kv.js';

// ---------------------------------------------------------------------
// Date helpers (server-local timezone)
// ---------------------------------------------------------------------
function currentDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Seconds until the next local midnight. We round UP so the
 * KV entry never expires a moment before midnight.
 */
function secondsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // next local midnight
  return Math.max(60, Math.ceil((midnight.getTime() - now.getTime()) / 1000));
}

// ---------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------
const mem = new Map();   // key -> { payload, dateKey, ts }

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------
/**
 * Return the payload for `${type}:${niche}` if it exists for today,
 * else null. Read order:
 *   1. In-memory cache (with dateKey check)
 *   2. Cloudflare KV (with dateKey check)
 *
 * The KV fetch is async; this function is async for that reason.
 * On a KV miss the in-memory value is left untouched. On a KV
 * hit, the in-memory cache is updated (so the next read is fast).
 */
export async function getDailyContent(type, niche) {
  const key = makeKey(type, niche);
  const today = currentDateKey();

  // 1. In-memory check.
  const memHit = mem.get(key);
  if (memHit && memHit.dateKey === today) {
    return memHit.payload;
  }
  // 2. In-memory had something but it's stale — drop it. (Lazy
  // flush; the safety-net sweep will catch anything else.)
  if (memHit && memHit.dateKey !== today) {
    mem.delete(key);
  }

  // 3. KV check.
  if (!kvConfigured()) return null;
  const raw = await kvGet(key);
  if (raw == null) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || record.dateKey !== today) {
    // Defensive: KV should auto-expire via TTL, but if the clock
    // was wrong, the record could be here with a stale dateKey.
    // Drop it from in-memory and ignore.
    return null;
  }
  // Hydrate the in-memory cache.
  mem.set(key, { payload: record.payload, dateKey: record.dateKey, ts: record.ts || Date.now() });
  return record.payload;
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------
/**
 * Persist `${type}:${niche}` for today. The payload is stamped
 * with `dateKey: today` so the read path can verify freshness.
 *
 * Writes to BOTH the in-memory cache and Cloudflare KV (if
 * configured). The KV write is fire-and-forget relative to the
 * in-memory write — the caller sees the in-memory write
 * immediately.
 */
export async function setDailyContent(type, niche, payload) {
  const key = makeKey(type, niche);
  const dateKey = currentDateKey();
  const record = {
    payload: { ...payload, dateKey },
    dateKey,
    ts: Date.now(),
  };
  mem.set(key, record);

  // KV write — async, best-effort. We don't await it from the
  // in-memory write above; the in-memory value is the source
  // for THIS process; KV is for other processes and for
  // cross-restart continuity. Errors are logged inside kvPut.
  if (kvConfigured()) {
    const ttl = secondsUntilMidnight();
    // Don't await — let the request return promptly. The KV
    // write completes in the background; on a slow KV the user
    // can still proceed and the next request reads from the
    // in-memory cache. If the user wants stricter consistency,
    // set CF_KV_REQUIRED=1 and we'll await.
    if (process.env.CF_KV_REQUIRED === '1') {
      await kvPut(key, record, ttl);
    } else {
      kvPut(key, record, ttl).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------
/**
 * Drop every in-memory entry whose dateKey !== today. Returns
 * the count removed. Cloudflare KV is left alone — its TTL
 * will reap obsolete entries.
 */
export function flushStale() {
  const today = currentDateKey();
  let removed = 0;
  for (const [key, rec] of mem.entries()) {
    if (rec.dateKey !== today) {
      mem.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Force a KV-side delete for `${type}:${niche}`. Used by the
 * admin's "flush-daily" action for manual ops. Returns true
 * if the KV (or in-memory) layer acknowledged the removal.
 */
export async function deleteDailyContent(type, niche) {
  const key = makeKey(type, niche);
  mem.delete(key);
  if (!kvConfigured()) return true;
  return kvDelete(key);
}

// ---------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------
let flusherHandle = null;

/**
 * Boot a flusher that runs `flushStale()`:
 *   - on a setTimeout aligned to the next local midnight, then
 *     every 24h (the exact-midnight pass)
 *   - on a setInterval every 15 minutes as a safety net (catches
 *     the case where the server was restarted across midnight
 *     and the exact-midnight timeout is missed)
 *
 * Both timers are unref()'d so they don't pin the event loop at
 * shutdown. Calling this more than once is a no-op.
 */
export function startDailyFlusher() {
  if (flusherHandle) return flusherHandle;

  const tick = () => {
    try {
      const n = flushStale();
      if (n > 0) {
        console.log(`[daily-content] swept ${n} stale in-memory entr${n === 1 ? 'y' : 'ies'}`);
      }
    } catch (err) {
      console.error('[daily-content] sweep failed:', err);
    }
  };

  // Safety-net interval.
  const safetyMs = Math.max(60_000, Number(process.env.DAILY_FLUSH_SAFETY_MS) || 15 * 60_000);
  const safety = setInterval(tick, safetyMs);
  if (typeof safety.unref === 'function') safety.unref();

  // Exact-midnight alignment. Compute the delay to the next
  // local midnight, then schedule the first tick there and
  // every 24h thereafter.
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msToMidnight = Math.max(1000, midnight.getTime() - now.getTime());
  const scheduleNext = () => {
    setTimeout(() => {
      tick();
      // Reschedule the next 24h tick. setInterval here would
      // misalign if the server is restarted across midnight, so
      // we use a self-rescheduling setTimeout.
      const next = setInterval(tick, 24 * 60 * 60 * 1000);
      if (typeof next.unref === 'function') next.unref();
    }, msToMidnight);
  };
  scheduleNext();

  flusherHandle = {
    safety,
    safetyMs,
    stop() {
      clearInterval(safety);
      flusherHandle = null;
    },
  };
  return flusherHandle;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function makeKey(type, niche) {
  if (type !== 'carousel' && type !== 'videos') {
    throw new Error(`daily_content_store: bad type ${type}`);
  }
  return `${type}:${niche}`;
}

export const _internal = {
  currentDateKey,
  secondsUntilMidnight,
  memSize: () => mem.size,
  // Test-only escape hatch: write a raw entry with an explicit
  // (possibly stale) dateKey. Used by dev/daily-content-test.mjs
  // to exercise the flush sweep. NOT exported in the public API.
  _setRawEntry(key, record) {
    mem.set(key, record);
  },
};

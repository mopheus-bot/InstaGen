// =====================================================================
// InstaGen — Browser-side media bytes cache
// =====================================================================
// The server stores media BYTES in Cloudflare R2 and metadata in
// Cloudflare KV. The browser fetches the bytes from the R2 URL on
// first visit of the day; this module caches the actual bytes in
// IndexedDB so subsequent visits read straight from the local
// disk and never hit R2.
//
// Why IndexedDB and not the browser's HTTP cache?
//   - The HTTP cache is small (~32 MB default) and gets evicted
//     aggressively. 70 MB of media + 3 videos per day would
//     thrash the cache constantly.
//   - IndexedDB has a per-origin quota measured in hundreds of
//     MB to GBs. Plenty of room for a day's media.
//   - The HTTP cache is shared with every other site; IDB is
//     per-origin and persists across sessions.
//
// Schema (per the parent module's pattern in cache-store.js):
//   Database :  instagen-cache
//   Store    :  media       (keyPath: 'key')
//   Record   :  { key: <r2-url>, blob, mimeType, bytes, cachedAt }
//
// Key = the R2 URL. The same URL re-fetched later resolves to
// the same bytes (R2 is content-addressable in practice for our
// use), so keying by URL is safe.
// =====================================================================

import { cacheGet, cachePut } from './cache-store.js';

const STORE_NAME = 'media';
const DB_VERSION = 2;   // bumped from cache-store.js's v1 to add the new store

// The parent cache-store.js opens the database at v1 with one
// store ("carousels"). We need v2 with two stores. We do our
// own open here so the version bump + new store creation lives
// in one place.

let dbPromise = null;

function openMediaDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'));
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('instagen-cache', DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // v1 may have only created `carousels`; re-create it for
      // a fresh DB (no-op if it already exists).
      if (!db.objectStoreNames.contains('carousels')) {
        db.createObjectStore('carousels', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB for media cache.'));
  });
  return dbPromise;
}

/**
 * Read a cached media record. Returns the record or null.
 */
export async function loadMedia(key) {
  try {
    const db = await openMediaDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * Persist a media record. The `blob` is stored as-is (IndexedDB
 * supports the Blob type natively — no base64 round-trip).
 *
 * @param {string}  key       — the R2 URL (used as the lookup key)
 * @param {Blob}    blob      — the raw bytes
 * @param {string}  [mimeType]— content-type, inferred from blob.type
 *                              when not provided
 * @returns {Promise<void>}
 */
export async function saveMedia(key, blob, mimeType) {
  try {
    const db = await openMediaDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record = {
        key,
        blob,
        mimeType: mimeType || blob.type || 'application/octet-stream',
        bytes: blob.size,
        cachedAt: Date.now(),
      };
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    // Best-effort cache — swallow errors so a write failure never
    // breaks the page render. The user just re-fetches from R2
    // next time.
    console.warn('[media-cache] save failed:', err?.message);
  }
}

/**
 * Load a cached media record and return a `blob:` URL ready to
 * drop into <img src> or <video src>. Returns null on miss.
 *
 * Callers should URL.revokeObjectURL when they're done with the
 * URL (typically on slide removal or page unload) — otherwise
 * the blob lives in memory until the document is closed.
 */
export async function mediaBlobUrl(key) {
  const rec = await loadMedia(key);
  if (!rec || !rec.blob) return null;
  return URL.createObjectURL(rec.blob);
}

/**
 * Fetch `url` from R2, store the bytes in the cache, and return
 * a `blob:` URL. On any failure (network, R2 down) the function
 * throws so the caller can fall back to the direct R2 URL.
 */
export async function fetchAndCacheMedia(url, opts = {}) {
  const { fetchImpl = fetch } = opts;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`media fetch ${res.status}`);
  const blob = await res.blob();
  await saveMedia(url, blob, blob.type);
  return URL.createObjectURL(blob);
}

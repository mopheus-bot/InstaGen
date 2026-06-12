// =====================================================================
// InstaGen — IndexedDB-backed cache for the daily carousel payload
// =====================================================================
// Why IndexedDB and not localStorage?
//
//   localStorage has a hard 5 MB per-origin cap in most browsers.
//   The carousel payload is the niche's 8 events PLUS 8 base64-
//   encoded JPEG images (each ~200–600 KB) — totals 1.6–4.8 MB.
//   On Safari that quota is enforced strictly: `setItem` throws
//   `QuotaExceededError` and the cache silently fails, so a
//   page reload wipes the carousel even though the user just
//   generated it.
//
//   IndexedDB has a per-origin quota of typically 50% of free
//   disk space, which is more than enough for hundreds of
//   cached carousels. The API is a bit clumsier than localStorage
//   (it's async, callback-based, and version-gated), so this
//   module wraps the two operations the rest of the app needs
//   (get + put) behind a Promise-based surface that mirrors the
//   `localStorage.getItem / setItem` shape.
//
// Schema:
//   - Database:  instagen-cache
//   - Store:     carousels  (keyPath: 'key')
//   - Record:    { key: 'instagen:daily:v2:<niche>:<date>', ...payload }
//
// The `key` field is the same string the old localStorage code
// used, so swapping the implementation is invisible to the rest
// of app.js.
//
// Fallback: if IndexedDB is unavailable (e.g. private mode in
// some browsers, very old environments), every operation
// resolves to the localStorage equivalent so the old behavior
// is preserved as a degraded mode.
// =====================================================================

const DB_NAME = 'instagen-cache';
const DB_VERSION = 1;
const STORE_NAME = 'carousels';

let dbPromise = null;

/**
 * Open the IndexedDB database. Memoises the open promise so
 * concurrent callers share a single connection. If IndexedDB is
 * unavailable the promise rejects — the caller can fall back to
 * localStorage (or treat it as a cache miss).
 */
function openDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'));
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB.'));
  });
  return dbPromise;
}

/**
 * Read a record by key. Resolves to `null` on miss (NOT
 * `undefined` — `null` matches the localStorage contract the
 * old code used).
 */
export async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Fallback: localStorage (degraded but better than nothing).
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Persist a record under `key`. Throws on quota / serialization
 * failure (callers can choose to log + ignore). The wrapped
 * value is the full record object (not a JSON string) so
 * subsequent reads don't have to parse it.
 */
export async function cachePut(key, record) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put({ key, ...record });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    // Fallback: localStorage. Probably the cause of the original
    // bug — but better a partial save than nothing.
    try {
      localStorage.setItem(key, JSON.stringify({ key, ...record }));
    } catch {
      /* swallow: cache is best-effort */
    }
  }
}

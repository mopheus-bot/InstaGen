// =====================================================================
// InstaGen — Video task state store
// =====================================================================
// Shared in-process Map backing the async text-to-video pipeline.
//
// Both api/video-callback.js (writer) and api/video-status.js (reader)
// import from here so a task_id submitted in one invocation can be
// resolved in another — provided they share the same warm Node
// process.
//
// LIMITATION (single-process state):
//   In-process state is per-process. Behind a load balancer with N
//   Node workers, a callback received in worker A and a status poll
//   landing in worker B will not see each other. This is fine for
//   local dev, a single-instance deployment, and the demo flow;
//   production should swap this module for a shared store
//   (Redis, Postgres, Cloudflare KV, etc.) without changing the
//   exported API.
//
// "Zero-database" architecture: we deliberately use only a Map in
// process memory and reap stale entries with a timer. This keeps
// the deployment footprint to a single small container — no
// external database cluster, no migrations, no connection pool.
// The cost is that records are lost on restart and cannot span
// replicas; the reward is zero idle cost on a $4 VPS.
//
// Stored record shape (per task_id):
//   {
//     status     : 'processing' | 'success' | 'failed' | 'unknown',
//     url        : string | null,   // hosted video URL on success
//     fileId     : string | null,   // MiniMax file_id on success
//     error      : string | null,   // failure reason on failed
//     updatedAt  : ISO timestamp,
//     timestamp  : number           // Date.now() epoch ms, used by
//                                  // the GC sweep to find stale
//                                  // entries without parsing the
//                                  // ISO string on every record
//   }
// =====================================================================

const store = new Map();

/**
 * Merge `partial` into the record stored under `taskId`, creating
 * the record if it does not exist. Always stamps `updatedAt` (ISO)
 * and `timestamp` (epoch ms). The numeric `timestamp` is what the
 * background GC sweep compares against — keeping it as a number
 * avoids parsing an ISO string on every record on every sweep.
 *
 * @param {string} taskId
 * @param {object} partial  Subset of the record shape.
 * @returns {object}        The merged record (post-write snapshot).
 */
export function setVideoTask(taskId, partial) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('setVideoTask: taskId must be a non-empty string.');
  }
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const prev = store.get(taskId) || {
    status: 'processing',
    url: null,
    fileId: null,
    error: null,
    updatedAt: nowIso,
    timestamp: nowMs,
  };
  const next = {
    ...prev,
    ...(partial || {}),
    updatedAt: nowIso,
    timestamp: nowMs,
  };
  store.set(taskId, next);
  return next;
}

/**
 * Read a single record. Returns `null` if the id is unknown.
 *
 * @param {string} taskId
 * @returns {object|null}
 */
export function getVideoTask(taskId) {
  return store.has(taskId) ? { ...store.get(taskId) } : null;
}

/**
 * Read many records in one call. Missing ids come back as `null` so
 * the caller can distinguish "not yet arrived" from "never submitted."
 *
 * @param {string[]} taskIds
 * @returns {object}  { [taskId]: record | null }
 */
export function getVideoTasks(taskIds) {
  const out = {};
  for (const id of taskIds) {
    out[id] = store.has(id) ? { ...store.get(id) } : null;
  }
  return out;
}

/**
 * Drop a record. Used by cleanup jobs (not currently wired) and by
 * tests.
 *
 * @param {string} taskId
 * @returns {boolean}  true if a record was removed.
 */
export function deleteVideoTask(taskId) {
  return store.delete(taskId);
}

// ---------------------------------------------------------------------
// Automatic garbage collection
// ---------------------------------------------------------------------
// To keep the in-memory Map from growing without bound on a small
// VPS, sweep entries whose last write is older than the TTL. The
// sweep is intentionally cheap (one numeric comparison per entry)
// and the timer is unref()'d so it never holds the event loop open
// at shutdown.
//
// Defaults match the Zero-Database architecture spec:
//   TTL  = 1 hour     (after this, the frontend has long since
//                      given up polling and the record is junk)
//   step = 15 minutes (sweep cadence — frequent enough to bound
//                      peak memory, infrequent enough to be free)

export const DEFAULT_VIDEO_TASK_TTL_MS = 60 * 60 * 1000;     // 1 hour
export const DEFAULT_VIDEO_TASK_SWEEP_MS = 15 * 60 * 1000;   // 15 minutes

/**
 * Drop every record whose last write is older than `ttlMs`. Returns
 * the number of records removed so a caller (or test) can assert
 * the sweep did work.
 *
 * @param {number} [ttlMs=DEFAULT_VIDEO_TASK_TTL_MS]
 * @returns {number}  count of removed entries
 */
export function sweepStaleVideoTasks(ttlMs = DEFAULT_VIDEO_TASK_TTL_MS) {
  const now = Date.now();
  let removed = 0;
  for (const [taskId, data] of store.entries()) {
    // Defensive: a record written before the GC field existed will
    // lack `timestamp` — treat it as stale so it can't outlive the
    // sweep by accident.
    const age = now - (typeof data?.timestamp === 'number' ? data.timestamp : 0);
    if (age > ttlMs) {
      store.delete(taskId);
      removed++;
    }
  }
  return removed;
}

/**
 * Boot a `setInterval` that periodically calls sweepStaleVideoTasks.
 * The timer is unref()'d so it does not keep the Node process alive
 * when nothing else is happening (e.g. in tests). Calling this more
 * than once is a no-op — the second call returns the existing
 * handle so server.js can call it unconditionally at boot.
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]   Stale threshold (default 1 hour).
 * @param {number} [opts.stepMs]  Sweep cadence (default 15 min).
 * @returns {{ stop: () => void, removed: () => number, ttlMs: number, stepMs: number }}
 */
export function startVideoTaskSweeper(opts = {}) {
  if (sweeperHandle) {
    return sweeperHandle;
  }
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_VIDEO_TASK_TTL_MS;
  const stepMs = Number.isFinite(opts.stepMs) ? opts.stepMs : DEFAULT_VIDEO_TASK_SWEEP_MS;
  let totalRemoved = 0;

  const tick = () => {
    try {
      const n = sweepStaleVideoTasks(ttlMs);
      if (n > 0) {
        totalRemoved += n;
        console.log(`[video-task-store] swept ${n} stale task(s) (total this process: ${totalRemoved})`);
      }
    } catch (err) {
      // The sweep must never crash the process. Log and continue;
      // the next tick will try again.
      console.error('[video-task-store] sweep failed:', err);
    }
  };

  const handle = setInterval(tick, stepMs);
  // unref() lets Node exit naturally when the server closes — the
  // interval will not pin the event loop open.
  if (typeof handle.unref === 'function') handle.unref();

  sweeperHandle = {
    handle,
    ttlMs,
    stepMs,
    removed: () => totalRemoved,
    stop: () => {
      clearInterval(handle);
      sweeperHandle = null;
    },
  };
  return sweeperHandle;
}

let sweeperHandle = null;

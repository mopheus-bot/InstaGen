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
// Record shape (keyed by the local `jobId` returned to the client):
//   {
//     jobId          : string,           // primary key, local UUID
//     status         : 'submitting'      // fire-and-forget submit
//                  |     | 'processing'   // accepted by MiniMax
//                  |     | 'success'      // R2 URL ready
//                  |     | 'failed'       // any failure path
//     url            : string | null,    // R2 (or MiniMax) URL on success
//     fileId         : string | null,    // MiniMax file_id on success
//     error          : string | null,    // failure reason on failed
//     minimaxTaskId  : string | null,    // MiniMax task_id, set once
//                                       // the upstream submit settles
//     title          : string,           // variant title (echoed back)
//     year           : string,           // variant year  (echoed back)
//     updatedAt      : ISO timestamp,
//     timestamp      : number            // Date.now() epoch ms
//   }
// =====================================================================

const store = new Map();

/**
 * Merge `partial` into the record stored under `jobId`, creating
 * the record if it does not exist. Always stamps `updatedAt` (ISO)
 * and `timestamp` (epoch ms). The numeric `timestamp` is what the
 * background GC sweep compares against — keeping it as a number
 * avoids parsing an ISO string on every record on every sweep.
 *
 * @param {string} jobId
 * @param {object} partial  Subset of the record shape.
 * @returns {object}        The merged record (post-write snapshot).
 */
export function setVideoTask(jobId, partial) {
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new Error('setVideoTask: jobId must be a non-empty string.');
  }
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const prev = store.get(jobId) || {
    jobId,
    status: 'submitting',
    url: null,
    fileId: null,
    error: null,
    minimaxTaskId: null,
    title: '',
    year: '',
    updatedAt: nowIso,
    timestamp: nowMs,
  };
  const next = {
    ...prev,
    ...(partial || {}),
    updatedAt: nowIso,
    timestamp: nowMs,
  };
  store.set(jobId, next);
  return next;
}

/**
 * Read a single record by its local jobId. Returns `null` if the id
 * is unknown.
 *
 * @param {string} jobId
 * @returns {object|null}
 */
export function getVideoTask(jobId) {
  return store.has(jobId) ? { ...store.get(jobId) } : null;
}

/**
 * Read many records in one call. Missing ids come back as `null` so
 * the caller can distinguish "not yet arrived" from "never submitted."
 *
 * @param {string[]} jobIds
 * @returns {object}  { [jobId]: record | null }
 */
export function getVideoTasks(jobIds) {
  const out = {};
  for (const id of jobIds) {
    out[id] = store.has(id) ? { ...store.get(id) } : null;
  }
  return out;
}

/**
 * Look up a record by its upstream MiniMax taskId. The callback
 * path (api/video-callback.js) only knows the MiniMax id, but the
 * primary key in this store is the local jobId — so the callback
 * does a reverse scan via this helper. O(n) over the Map; fine for
 * the volume we expect (≤ a few dozen in-flight jobs at a time on
 * a small deployment).
 *
 * @param {string} minimaxTaskId
 * @returns {object|null}
 */
export function getVideoTaskByMinimaxId(minimaxTaskId) {
  if (typeof minimaxTaskId !== 'string' || minimaxTaskId.length === 0) return null;
  for (const rec of store.values()) {
    if (rec && rec.minimaxTaskId === minimaxTaskId) return { ...rec };
  }
  return null;
}

/**
 * Drop a record. Used by cleanup jobs (not currently wired) and by
 * tests.
 *
 * @param {string} jobId
 * @returns {boolean}  true if a record was removed.
 */
export function deleteVideoTask(jobId) {
  return store.delete(jobId);
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

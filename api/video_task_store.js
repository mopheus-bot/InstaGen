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
// Stored record shape (per task_id):
//   {
//     status    : 'processing' | 'success' | 'failed' | 'unknown',
//     url       : string | null,   // hosted video URL on success
//     fileId    : string | null,   // MiniMax file_id on success
//     error     : string | null,   // failure reason on failed
//     updatedAt : ISO timestamp
//   }
// =====================================================================

const store = new Map();

/**
 * Merge `partial` into the record stored under `taskId`, creating
 * the record if it does not exist. Always stamps `updatedAt`.
 *
 * @param {string} taskId
 * @param {object} partial  Subset of the record shape.
 * @returns {object}        The merged record (post-write snapshot).
 */
export function setVideoTask(taskId, partial) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('setVideoTask: taskId must be a non-empty string.');
  }
  const prev = store.get(taskId) || {
    status: 'processing',
    url: null,
    fileId: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
  const next = {
    ...prev,
    ...(partial || {}),
    updatedAt: new Date().toISOString(),
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

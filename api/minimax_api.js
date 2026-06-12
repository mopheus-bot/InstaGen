// =====================================================================
// InstaGen — MiniMax video API helpers
// =====================================================================
// Wraps the four HTTP calls InstaGen makes to MiniMax's video
// pipeline, so the orchestrating code in generate-daily-videos.js
// doesn't have to repeat URL/header plumbing for each. The two
// operations that matter for the I2V + first-frame path:
//
//   1. submitVideoTask  — POST /v1/video_generation
//      (with first_frame_image and optional last_frame_image or
//       subject_reference). Returns { taskId }.
//
//   2. queryVideoTask   — GET /v1/query/video_generation?task_id=…
//      Returns the live status of an async task. Status values per
//      the docs: "Preparing" | "Queueing" | "Processing" |
//      "Success" | "Fail". The CALLBACK uses lowercase
//      ("processing" | "success" | "failed") so mapStatus() handles
//      both shapes.
//
//   3. retrieveVideoFile — GET /v1/files/retrieve?file_id=…
//      Returns { file: { file_id, bytes, created_at, filename,
//      purpose, download_url }, base_resp }. Used after a task
//      resolves to Success to get the actual video bytes URL.
//
//   4. pollVideoTask — server-side polling loop. Calls queryVideoTask
//      every `intervalMs` until the task settles, the timeout
//      elapses, or `signal` aborts. Fires the appropriate
//      `onSuccess` / `onFailure` / `onTimeout` callback.
//
// Required env: MINIMAX_API_KEY (the existing variable).
// =====================================================================

const API_BASE    = 'https://api.minimax.io';
const SUBMIT_URL  = `${API_BASE}/v1/video_generation`;
const QUERY_URL   = `${API_BASE}/v1/query/video_generation`;
const RETRIEVE_URL = `${API_BASE}/v1/files/retrieve`;

/** Tiny shared sleep helper so callers don't need their own. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------
// MiniMax uses different shapes in different places:
//   - The CALLBACK payload (api/video-callback.js) uses lowercase:
//     "processing" | "success" | "failed" (per the docs' callback
//     status values section).
//   - The QUERY API response (this file) uses PascalCase:
//     "Preparing" | "Queueing" | "Processing" | "Success" | "Fail".
// mapStatus() accepts either and returns the canonical lowercase form
// the rest of the system uses.

const STATUS_MAP = {
  // PascalCase from the query API
  Preparing:  'processing',
  Queueing:   'processing',
  Processing: 'processing',
  Success:    'success',
  Fail:       'failed',
  // Lowercase from the callback (passes through)
  processing: 'processing',
  success:    'success',
  failed:     'failed',
  // Conservative default
  unknown:    'processing',
};

export function mapStatus(raw) {
  if (typeof raw !== 'string') return 'processing';
  return STATUS_MAP[raw] || 'processing';
}

// ---------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------
/**
 * Submit a text-to-video or image-to-video task. Returns the taskId.
 *
 * Throws with the actual MiniMax `base_resp.status_msg` if the
 * submission is rejected. The error-ordering is critical: check
 * `base_resp.status_code` BEFORE checking `task_id`, because a
 * rejected submission returns `task_id: ""` — checking task_id
 * first would throw a misleading "missing task_id" instead of the
 * real reason.
 */
export async function submitVideoTask(opts) {
  const {
    prompt,
    model,
    duration,
    resolution,
    callbackUrl,
    firstFrameImageUrl,
    lastFrameImageUrl,   // optional — first+last frame mode
    signal,
  } = opts;

  const body = { model, prompt, duration, resolution, callback_url: callbackUrl };
  if (firstFrameImageUrl) body.first_frame_image = firstFrameImageUrl;
  if (lastFrameImageUrl)  body.last_frame_image  = lastFrameImageUrl;

  const res = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '<unreadable>');
    throw new Error(`Video submit ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();

  const code = data?.base_resp?.status_code;
  if (typeof code === 'number' && code !== 0) {
    const msg = data?.base_resp?.status_msg;
    throw new Error(
      `Video API rejected task (code ${code}` +
      (msg ? `: ${msg}` : '') +
      `)`
    );
  }
  if (typeof data?.task_id !== 'string' || data.task_id.length === 0) {
    throw new Error('Video API response missing task_id.');
  }
  return { taskId: data.task_id };
}

// ---------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------
/**
 * Query the live status of a single task. Returns the parsed body
 * (caller maps the status via mapStatus). Throws on transport failure.
 */
export async function queryVideoTask(taskId, signal) {
  const url = `${QUERY_URL}?task_id=${encodeURIComponent(taskId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${process.env.MINIMAX_API_KEY}` },
    signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '<unreadable>');
    throw new Error(`Video query ${res.status}: ${errBody.slice(0, 300)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------
// File retrieve
// ---------------------------------------------------------------------
/**
 * Given a file_id (returned in a Success query response), get the
 * actual download URL for the video bytes. Returns the parsed body;
 * caller reads `body.file.download_url`.
 */
export async function retrieveVideoFile(fileId, signal) {
  const url = `${RETRIEVE_URL}?file_id=${encodeURIComponent(fileId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${process.env.MINIMAX_API_KEY}` },
    signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '<unreadable>');
    throw new Error(`Video file retrieve ${res.status}: ${errBody.slice(0, 300)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------
/**
 * Server-side polling against the query API. Runs in the background
 * (caller does NOT await this). On settle, fires the matching
 * callback. The caller's job is to write to the in-memory task
 * store / R2 / daily content store inside the callback.
 *
 * Options:
 *   - taskId        : the MiniMax task id (string)
 *   - intervalMs    : poll cadence (default 10s)
 *   - timeoutMs     : hard cap (default 6 min)
 *   - signal        : optional AbortSignal — pass the request.signal
 *                     on a live request, or a fresh
 *                     `new AbortController().signal` for a
 *                     fire-and-forget background poll.
 *   - onSuccess({ taskId, fileId, downloadUrl })
 *   - onFailure({ taskId, error })
 *   - onTimeout({ taskId })
 *   - onTick({ taskId, status })   — fired before each sleep too
 *                                     (useful for progress logs)
 *
 * The loop is intentionally NOT cancellable from the outside except
 * via the AbortSignal — we don't expose a "stop" handle, because
 * the in-memory task store + R2 write should always be allowed to
 * complete unless the process is shutting down.
 */
export async function pollVideoTask(opts) {
  const {
    taskId,
    intervalMs = 10_000,
    timeoutMs  = 6 * 60 * 1000,
    signal,
    onSuccess = () => {},
    onFailure = () => {},
    onTimeout = () => {},
    onTick    = () => {},
  } = opts;

  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) {
        onTimeout({ taskId });
        return;
      }
      let data;
      try {
        data = await queryVideoTask(taskId, signal);
      } catch (err) {
        // Transport blip — try again next tick. Don't fire onFailure
        // for transient errors; only fire on a definitive "Fail"
        // status from MiniMax itself.
        await sleep(intervalMs, signal).catch(() => {});
        continue;
      }

      const status = mapStatus(data?.status);
      onTick({ taskId, status });

      if (status === 'success') {
        // Pull the file URL.
        const fileId = data?.file_id;
        if (!fileId) {
          onFailure({ taskId, error: 'Success status but no file_id in query response.' });
          return;
        }
        try {
          const fileData = await retrieveVideoFile(fileId, signal);
          const downloadUrl = fileData?.file?.download_url;
          if (!downloadUrl) {
            onFailure({ taskId, error: 'File retrieve response missing download_url.' });
            return;
          }
          onSuccess({ taskId, fileId, downloadUrl });
          return;
        } catch (err) {
          onFailure({ taskId, error: `File retrieve failed: ${err.message}` });
          return;
        }
      }

      if (status === 'failed') {
        onFailure({
          taskId,
          error: data?.base_resp?.status_msg || 'MiniMax reported task failure.',
        });
        return;
      }

      // Still preparing / queueing / processing — wait and try again.
      await sleep(intervalMs, signal).catch(() => {});
    }
    onTimeout({ taskId });
  } catch (err) {
    // The sleep helper throws on signal abort. Treat as a timeout.
    onTimeout({ taskId });
  }
}

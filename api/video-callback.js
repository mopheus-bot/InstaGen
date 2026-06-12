// =====================================================================
// InstaGen — MiniMax video callback
// =====================================================================
// Public endpoint (no auth) that MiniMax's video_generation API calls
// when one of our async video tasks changes state.
//
// Two kinds of inbound POSTs (per the MiniMax docs):
//
//   (1) Handshake / validation:
//         { "challenge": "<random string>" }
//       We must echo the challenge back within 3 seconds, otherwise
//       MiniMax will not register the callback_url.
//
//   (2) Status update:
//         { "task_id": "...",
//           "status":  "processing" | "success" | "failed",
//           "file_id": "...",          // on success
//           "base_resp": { status_code, status_msg } }
//       We reverse-lookup the LOCAL jobId (primary key in our store)
//       by the MiniMax taskId and persist the snapshot there so the
//       frontend's poll of /api/video-status can pick it up.
//
// Route:  POST /api/video-callback
// Env:    (none — the store is in-process)
// =====================================================================

import {
  setVideoTask,
  getVideoTaskByMinimaxId,
} from './video_task_store.js';
import { withCors } from './_request.js';
import { jsonResponse } from './_helpers.js';

export const GET = withCors(async () => {
  return jsonResponse(
    {
      error: 'Method not allowed.',
      hint: 'This endpoint is the MiniMax video callback target. It accepts POST only.',
    },
    405,
    { Allow: 'POST' }
  );
});

export const POST = withCors(async (request, ctx) => {
  // MiniMax sends JSON in the body. Read defensively — a malformed
  // payload should NOT crash the handler (MiniMax would treat the
  // crash as a failed delivery and retry).
  //
  // Note on CORS: this is a server-to-server webhook from MiniMax
  // and is NOT browser-driven, so there is normally no `Origin`
  // header. The withCors wrapper is still applied so an in-browser
  // debug call from the dev tools would also work, and so the
  // resolved client IP (if any) is captured for audit logs.
  if (ctx?.ip) console.log(`[ip] ${ctx.ip}`);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400);
  }

  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'Body must be a JSON object.' }, 400);
  }

  // (1) Handshake — echo the challenge back. MiniMax expects this
  // within 3 seconds; we are well under that.
  if (typeof body.challenge === 'string' && body.challenge.length > 0) {
    return jsonResponse({ challenge: body.challenge });
  }

  // (2) Status update. We accept any of the documented statuses and
  // ignore anything we don't recognize (a future MiniMax status
  // string would still be persisted verbatim so the frontend can
  // surface it).
  const minimaxTaskId = body.task_id;
  if (typeof minimaxTaskId !== 'string' || minimaxTaskId.length === 0) {
    return jsonResponse({ error: 'Missing task_id.' }, 400);
  }

  // Reverse-lookup the LOCAL jobId by the MiniMax taskId. The
  // store is keyed by jobId (returned to the client in the 202),
  // so a callback for a task we've never seen — or one that was
  // GC'd — is a no-op rather than a 404. The 200 keeps MiniMax
  // from retrying.
  const existing = getVideoTaskByMinimaxId(minimaxTaskId);
  if (!existing) {
    // Not necessarily an error: the submit may have failed before
    // we could record the minimaxTaskId, or the record may have
    // aged out. Ack so MiniMax stops retrying.
    return jsonResponse({ status: 'unknown-task', minimaxTaskId });
  }

  const statusRaw = typeof body.status === 'string' ? body.status : 'unknown';
  // 'submitting' is the fire-and-forget local state; the callback
  // can only move it forward to 'processing' / 'success' / 'failed'.
  const normalized = ['processing', 'success', 'failed'].includes(statusRaw)
    ? statusRaw
    : 'processing';

  const fileId = typeof body.file_id === 'string' ? body.file_id : null;
  const baseResp = (body.base_resp && typeof body.base_resp === 'object')
    ? body.base_resp
    : null;

  setVideoTask(existing.jobId, {
    status: normalized,
    fileId,
    // MiniMax's success payload may include a hosted URL under
    // various field names. Capture any of them so the frontend
    // doesn't need a follow-up call.
    url: body.url || body.video_url || body.download_url || existing.url || null,
    error: normalized === 'failed'
      ? (baseResp?.status_msg || 'MiniMax reported task failure.')
      : null,
  });

  return jsonResponse({ status: 'received', jobId: existing.jobId });
});

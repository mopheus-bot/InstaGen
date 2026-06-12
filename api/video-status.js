// =====================================================================
// InstaGen — Video task status query
// =====================================================================
// Public endpoint (no auth) the frontend polls after submitting async
// text-to-video tasks via /api/generate-daily-videos.
//
//   GET /api/video-status?ids=<jobId1>,<jobId2>,<jobId3>
//
// The ids are the LOCAL jobIds returned in the 202 response from
// /api/generate-daily-videos (NOT the upstream MiniMax taskIds —
// those are an internal implementation detail). Unknown ids (cold-
// start before the submit settled, expired tasks, typos) come back
// as { status: "unknown" } so the frontend can distinguish "still
// processing" from "we never saw this id."
//
// Response shape:
//   { "tasks": {
//       "<jobId1>": { "status": "success",   "url": "https://r2/...",
//                     "title": "...", "year": "..." },
//       "<jobId2>": { "status": "processing" },
//       "<jobId3>": { "status": "submitting" },
//       "<jobId4>": { "status": "unknown" }
//   } }
//
// `status` values the frontend can render:
//   - "submitting"  — fire-and-forget: local jobId allocated, the
//                     upstream submit is still in flight.
//   - "processing"  — MiniMax accepted the task and is rendering.
//   - "success"     — `url` is set (R2 or fallback MiniMax URL).
//   - "failed"      — `error` carries the reason.
//   - "unknown"     — id not in the store.
//
// Route:  GET /api/video-status
// =====================================================================

import { getVideoTasks } from './video_task_store.js';
import { withCors } from './_request.js';
import { jsonResponse } from './_helpers.js';

// Cap the per-request id count. MiniMax submits 3 tasks per request
// in the current pipeline, so 16 is comfortable headroom; larger
// values are likely abuse.
const MAX_IDS_PER_REQUEST = 16;

export const POST = withCors(async () => {
  return jsonResponse(
    {
      error: 'Method not allowed.',
      hint: 'This endpoint accepts GET with ?ids=a,b,c. Load the app to trigger generation.',
    },
    405,
    { Allow: 'GET' }
  );
});

export const GET = withCors(async (request) => {
  const url = new URL(request.url);
  const raw = url.searchParams.get('ids') || '';
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_IDS_PER_REQUEST);

  if (ids.length === 0) {
    return jsonResponse(
      { error: 'Missing or empty `ids` query parameter.' },
      400
    );
  }

  const stored = getVideoTasks(ids);
  // Normalize: unknown ids come back as { status: "unknown" } so the
  // frontend can render "still waiting" vs "never submitted."
  const tasks = {};
  for (const id of ids) {
    const rec = stored[id];
    tasks[id] = rec
      ? {
          status: rec.status,
          url: rec.url,
          fileId: rec.fileId,
          error: rec.error,
          title: rec.title || '',
          year: rec.year || '',
        }
      : { status: 'unknown' };
  }
  return jsonResponse({ tasks });
});

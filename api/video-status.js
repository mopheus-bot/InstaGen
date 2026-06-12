// =====================================================================
// InstaGen — Video task status query
// =====================================================================
// Public endpoint (no auth) the frontend polls after submitting async
// text-to-video tasks via /api/generate-daily-videos.
//
//   GET /api/video-status?ids=t1,t2,t3
//
// Returns the stored snapshot for each id. Unknown ids (cold-start
// before the callback landed, expired tasks, typos) come back as
// { status: "unknown" } so the frontend can distinguish "still
// processing" from "we never saw this id."
//
// Response shape:
//   { "tasks": {
//       "t1": { "status": "success",   "url": "...", "fileId": "..." },
//       "t2": { "status": "processing" },
//       "t3": { "status": "unknown" }
//   } }
//
// Route:  GET /api/video-status
// =====================================================================

import { getVideoTasks } from './video_task_store.js';
import { withCors } from './_request.js';

// Cap the per-request id count. MiniMax submits 3 tasks per request
// in the current pipeline, so 16 is comfortable headroom; larger
// values are likely abuse.
const MAX_IDS_PER_REQUEST = 16;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

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
      ? { status: rec.status, url: rec.url, fileId: rec.fileId, error: rec.error }
      : { status: 'unknown' };
  }
  return jsonResponse({ tasks });
});

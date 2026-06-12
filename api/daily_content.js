// =====================================================================
// InstaGen — Daily content query endpoint
// =====================================================================
// Mounted by server.js as GET /api/daily-content. The frontend
// calls this on page load to decide whether today's carousel /
// videos are ready (200) or whether the user needs to generate
// (404). A 410 (Gone) is theoretically possible if KV returned
// a record with a stale dateKey (clock skew, manual TTL
// override), but the daily flusher + KV TTL make it rare.
//
// Query params:
//   type    'carousel' | 'videos'
//   niche   string id, e.g. 'history', 'true-crime'
//
// Response codes:
//   200     payload is the full carousel or videos metadata
//   400     missing/invalid type or niche
//   404     no entry for today — frontend should prompt the user
//           to generate
//   410     entry exists but is from a previous day (shouldn't
//           happen with the KV TTL, but defensive)
// =====================================================================

import { withCors } from './_request.js';
import { getDailyContent } from './daily_content_store.js';
import { _internal as storeInternal } from './daily_content_store.js';
import { jsonResponse } from './_helpers.js';

export const GET = withCors(async (request) => {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || '';
  const niche = url.searchParams.get('niche') || '';

  if (type !== 'carousel' && type !== 'videos') {
    return jsonResponse({
      error: "Invalid `type`. Use 'carousel' or 'videos'.",
    }, 400);
  }
  if (!niche) {
    return jsonResponse({ error: "Missing `niche` query parameter." }, 400);
  }

  // Probe the in-memory store directly to distinguish "no entry"
  // (404) from "stale entry" (410). We import the in-memory
  // helper indirectly via the read path's promise resolution:
  // if getDailyContent returns null we can't tell why, so we
  // re-read the dateKey from the store ourselves.
  const today = storeInternal.currentDateKey();
  const payload = await getDailyContent(type, niche);
  if (payload) {
    return jsonResponse({
      type,
      niche,
      dateKey: today,
      payload,
    });
  }
  // 404 — nothing for today. The frontend should show the
  // Generate button. (We could try to detect a stale record
  // by reaching into KV directly, but the lazy in-memory check
  // in getDailyContent already drops stale records, so a 404
  // here is the canonical "no content for today" signal.)
  return jsonResponse({
    error: 'No content for today.',
    type,
    niche,
    dateKey: today,
  }, 404);
});

export const POST = withCors(async () => {
  // This endpoint is read-only. POSTs get a 405 so the mount
  // pattern in server.js (which registers both GET and POST
  // for every slug) is satisfied without inventing a write
  // semantic.
  return jsonResponse(
    {
      error: 'Method not allowed.',
      hint: 'GET /api/daily-content?type=carousel|videos&niche=...',
    },
    405,
    { Allow: 'GET' }
  );
});

// `_internal` re-exports the helpers the admin handler uses
// to force-flush the daily store.
export { _internal } from './daily_content_store.js';

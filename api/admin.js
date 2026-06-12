// =====================================================================
// InstaGen — Admin dashboard endpoints
// =====================================================================
// Mounted by server.js under /api/admin/*. These endpoints expose
// the in-memory usage log to the operator's dashboard and let
// them send a test Telegram message + clear the log. The gate
// middleware in api/_gate.js already requires a valid session
// cookie, so anything that reaches these handlers has been
// authenticated.
//
// Routes (server.js mounts each as both GET and POST where useful):
//   /api/admin/usage        GET   — full snapshot (rate card,
//                                   totals, recent log)
//   /api/admin/usage/clear  POST  — reset the in-memory log
//   /api/admin/usage/test   POST  — send a synthetic test message
//                                   to the configured Telegram chat
//   /api/admin/usage/config GET   — telegram-configured boolean
//                                   (the dashboard uses it to
//                                   enable/disable the test button)
// =====================================================================

import { withCors } from './_request.js';
import {
  getUsageSnapshot,
  clearUsageLog,
  sendTestNotification,
  telegramConfigured,
} from './_usage.js';

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ---------------------------------------------------------------------
// GET /api/admin/usage
// ---------------------------------------------------------------------
export const GET = withCors(async () => {
  return jsonResponse({
    ok: true,
    snapshot: getUsageSnapshot(),
  });
});

// ---------------------------------------------------------------------
// POST /api/admin/usage
// The body chooses the action so a single mounted route covers
// "clear" and "test" without a sprawling route table. Recognised
// actions:
//   { action: "clear" }   — wipes the in-memory log + totals
//   { action: "test"  }   — sends a synthetic Telegram message
//   anything else         — 400
// ---------------------------------------------------------------------
export const POST = withCors(async (request) => {
  let body = {};
  try {
    body = (await request.json()) || {};
  } catch {
    /* empty body is fine */
  }

  const action = String(body.action || '').toLowerCase();
  if (action === 'clear') {
    return jsonResponse({ ok: true, result: clearUsageLog() });
  }
  if (action === 'test') {
    const result = await sendTestNotification();
    return jsonResponse({ ok: true, result });
  }
  return jsonResponse({ error: 'Unknown action. Use {action:"clear"} or {action:"test"}.' }, 400);
});

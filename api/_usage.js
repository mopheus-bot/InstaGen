// =====================================================================
// InstaGen — Usage tracker + outbound notifier
// =====================================================================
// One central place that:
//   1. Receives a per-call usage report from the API handlers (text
//      tokens, image count, video count, optional model + duration).
//   2. Computes a USD price from the env-driven rate card.
//   3. Pushes a single Telegram message summarising the call's
//      consumption + cost.
//   4. Appends an entry to an in-process ring buffer so the admin
//      dashboard can show recent activity.
//
// Why Telegram? It is the operator's chosen channel (set by the
// user when wiring this in). The chat id is a long-lived integer,
// messages are free, and the Bot HTTP API needs only a single
// POST. Falls back to console.log if Telegram is not configured.
//
// Env (all optional — module no-ops cleanly when missing):
//   BOT_API_TOKEN              Bot token from @BotFather for %BOT%
//                              (the operator's chosen bot username —
//                              set the actual name in BotFather, the
//                              token here in the deploy env)
//   ADMIN_TELEGRAM_CHAT_ID     Numeric chat id the bot should DM
//   ADMIN_PRICE_INPUT_PER_MTOK USD per 1M input tokens  (default 3)
//   ADMIN_PRICE_OUTPUT_PER_MTOK USD per 1M output tokens (default 15)
//   ADMIN_PRICE_IMAGE          USD per image             (default 0.04)
//   ADMIN_PRICE_VIDEO_PER_SEC  USD per second of video   (default 0.10)
//   ADMIN_USAGE_LOG_SIZE       Max entries kept in RAM   (default 200)
//
// Required imports: node:crypto (HMAC for the session cookie in
// the auth module — not used here, kept in for shared namespace).
// =====================================================================

// ---------------------------------------------------------------------
// Rate card (env-driven, with safe defaults)
// ---------------------------------------------------------------------
const PRICE = Object.freeze({
  inputPerMTok:  Number(process.env.ADMIN_PRICE_INPUT_PER_MTOK  || 3),
  outputPerMTok: Number(process.env.ADMIN_PRICE_OUTPUT_PER_MTOK || 15),
  image:         Number(process.env.ADMIN_PRICE_IMAGE          || 0.04),
  videoPerSec:   Number(process.env.ADMIN_PRICE_VIDEO_PER_SEC  || 0.10),
});

const LOG_SIZE = Math.max(10, Number(process.env.ADMIN_USAGE_LOG_SIZE) || 200);

// ---------------------------------------------------------------------
// In-process ring buffer of recent usage events
// ---------------------------------------------------------------------
const log = [];
let totals = {
  textInputTokens:  0,
  textOutputTokens: 0,
  imageCount:       0,
  videoSeconds:     0,
  usd:              0,
  events:           0,
};

// "Today" is a separate counter that resets whenever the server-
// local date rolls over. The day key is checked on every
// recordUsage() call so a single midnight-spanning long-running
// process will start a fresh tally on the next call. We do NOT
// spawn a timer — the rollover happens lazily on the first
// recordUsage() of the new day, which is correct for a process
// that's only ever asked about totals when activity is happening.
let todayDateKey = currentDateKey();
let totalToday = {
  textInputTokens:  0,
  textOutputTokens: 0,
  imageCount:       0,
  videoSeconds:     0,
  usd:              0,
  events:           0,
};

function currentDateKey() {
  // YYYY-MM-DD in the server's local timezone. Matches the key
  // the carousel handler uses for its niche-scoped cache, so the
  // admin's "today" lines up with the carousel's date.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rolloverTodayIfNeeded() {
  const k = currentDateKey();
  if (k !== todayDateKey) {
    todayDateKey = k;
    totalToday = {
      textInputTokens:  0,
      textOutputTokens: 0,
      imageCount:       0,
      videoSeconds:     0,
      usd:              0,
      events:           0,
    };
  }
}

function append(entry) {
  rolloverTodayIfNeeded();

  log.push(entry);
  if (log.length > LOG_SIZE) log.shift();

  // Lifetime totals (since process start).
  totals.events          += 1;
  totals.textInputTokens  += entry.textInputTokens  || 0;
  totals.textOutputTokens += entry.textOutputTokens || 0;
  totals.imageCount       += entry.imageCount       || 0;
  totals.videoSeconds     += entry.videoSeconds     || 0;
  totals.usd              += entry.usd              || 0;

  // Per-day totals — a single midnight rollover drops the prior
  // day's running total so the operator can compare to yesterday
  // by checking the log entries (timestamps are ISO 8601).
  totalToday.events          += 1;
  totalToday.textInputTokens  += entry.textInputTokens  || 0;
  totalToday.textOutputTokens += entry.textOutputTokens || 0;
  totalToday.imageCount       += entry.imageCount       || 0;
  totalToday.videoSeconds     += entry.videoSeconds     || 0;
  totalToday.usd              += entry.usd              || 0;
}

// ---------------------------------------------------------------------
// Price math
// ---------------------------------------------------------------------
/**
 * Compute the USD cost of one call. Returns a number rounded to
 * 6 decimal places — small enough that micro-differences in
 * token counts don't accumulate, large enough that a $0.000004
 * rounding artifact can never push a $0.00 entry to $0.01.
 */
function computeCost({ textInputTokens = 0, textOutputTokens = 0, imageCount = 0, videoSeconds = 0 }) {
  const inputCost  = (textInputTokens  / 1_000_000) * PRICE.inputPerMTok;
  const outputCost = (textOutputTokens / 1_000_000) * PRICE.outputPerMTok;
  const imageCost  = imageCount   * PRICE.image;
  const videoCost  = videoSeconds * PRICE.videoPerSec;
  const total = inputCost + outputCost + imageCost + videoCost;
  return Math.round(total * 1_000_000) / 1_000_000;
}

function fmtUsd(n) {
  if (n < 0.01) return `$${n.toFixed(6)}`;
  if (n < 1)    return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// ---------------------------------------------------------------------
// Telegram notifier
// ---------------------------------------------------------------------
// We build the message on every call so the operator sees the
// delta (this-call) AND the running total (since process start).
// That way a single abusive client becomes obvious — the deltas
// keep climbing while the totals race ahead.

/**
 * Send one Telegram message. Fire-and-forget — failures are logged
 * to stderr but never throw, so a Telegram outage cannot break a
 * content-generation call.
 */
async function sendTelegram(text) {
  const token = process.env.BOT_API_TOKEN;
  const chat  = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'telegram-not-configured' };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text,
        // Plain text — Telegram parses basic Markdown, but on a
        // phone notification the unstyled form is the most
        // reliable.
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[usage][telegram] ${res.status}: ${body.slice(0, 200)}`);
      return { sent: false, reason: `http-${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error('[usage][telegram] failed:', err.message);
    return { sent: false, reason: 'exception' };
  }
}

/**
 * Record one usage event. The shape is intentionally permissive —
 * every handler reports only the fields it actually used, and the
 * function fills in the rest with zeros.
 *
 * The notification is sent as a single message after a small
 * microtask hop so multiple parallel image calls in the same
 * handler can be coalesced. For now we send one message per
 * `recordUsage` call (the operator wants per-call visibility to
 * spot attacks — coalescing would defeat the point).
 *
 * @param {object}  opts
 * @param {string}  opts.route        e.g. "/api/generate-content"
 * @param {string}  [opts.niche]      Active niche id, if any
 * @param {string}  [opts.model]      Model that was used
 * @param {number}  [opts.textInputTokens]
 * @param {number}  [opts.textOutputTokens]
 * @param {number}  [opts.imageCount]
 * @param {number}  [opts.videoSeconds]
 * @param {number}  [opts.videoCount]
 * @param {string}  [opts.ip]         Resolved end-user IP
 * @returns {Promise<{usd: number, entry: object}>}
 */
export async function recordUsage(opts) {
  const o = opts || {};
  const entry = {
    ts:         new Date().toISOString(),
    route:      String(o.route || 'unknown'),
    niche:      o.niche || null,
    model:      o.model || null,
    textInputTokens:  Number(o.textInputTokens  || 0),
    textOutputTokens: Number(o.textOutputTokens || 0),
    imageCount:       Number(o.imageCount       || 0),
    videoCount:       Number(o.videoCount       || 0),
    videoSeconds:     Number(o.videoSeconds     || 0),
    ip:               o.ip || null,
  };
  entry.usd = computeCost(entry);
  append(entry);

  // Console breadcrumb (always — useful even when Telegram is
  // unconfigured, and the operator can `railway logs | grep usage`).
  console.log(
    `[usage] route=${entry.route} ` +
    `in=${entry.textInputTokens} out=${entry.textOutputTokens} ` +
    `img=${entry.imageCount} vid=${entry.videoCount}@${entry.videoSeconds}s ` +
    `usd=${entry.usd.toFixed(6)} ip=${entry.ip || '?'}`
  );

  // Build the human-readable notification. We send it
  // asynchronously and do NOT await — the caller should not be
  // blocked by a slow Telegram API.
  const lines = [
    `🔔 InstaGen usage`,
    `route: ${entry.route}`,
    entry.niche ? `niche: ${entry.niche}` : null,
    entry.model ? `model: ${entry.model}` : null,
    `text: ${fmtInt(entry.textInputTokens)} in / ${fmtInt(entry.textOutputTokens)} out`,
    entry.imageCount ? `images: ${entry.imageCount}` : null,
    entry.videoCount ? `videos: ${entry.videoCount} × ${entry.videoSeconds}s` : null,
    `this call: ${fmtUsd(entry.usd)}`,
    `today (${todayDateKey}): ${fmtUsd(totalToday.usd)} across ${totalToday.events} call(s)`,
    `running total: ${fmtUsd(totals.usd)} across ${totals.events} call(s)`,
    `ip: ${entry.ip || 'unknown'}`,
  ].filter(Boolean);
  sendTelegram(lines.join('\n')).catch(() => {});

  return { usd: entry.usd, entry };
}

// ---------------------------------------------------------------------
// Admin queries
// ---------------------------------------------------------------------
export function getUsageSnapshot() {
  rolloverTodayIfNeeded();
  return {
    rateCard: { ...PRICE },
    totals: { ...totals },
    // `total_today` is the per-day running total. The dashboard
    // renders it next to the lifetime totals so the operator can
    // see at a glance how much today's traffic has cost.
    total_today: { ...totalToday },
    today_date: todayDateKey,
    log: log.slice().reverse(),   // newest first
  };
}

export function clearUsageLog() {
  rolloverTodayIfNeeded();
  log.length = 0;
  totals = {
    textInputTokens:  0,
    textOutputTokens: 0,
    imageCount:       0,
    videoSeconds:     0,
    usd:              0,
    events:           0,
  };
  // `total_today` is intentionally NOT reset here — clearing
  // the log should not make the day's running cost disappear.
  return { ok: true };
}

/**
 * Send a synthetic test notification so the operator can confirm
 * the Telegram wiring is correct without burning real API calls.
 */
export async function sendTestNotification() {
  const stamp = new Date().toISOString();
  const text =
    `✅ InstaGen admin test\n` +
    `timestamp: ${stamp}\n` +
    `If you can read this, the bot is wired up correctly.`;
  const res = await sendTelegram(text);
  return { ...res, timestamp: stamp };
}

export function telegramConfigured() {
  return Boolean(process.env.BOT_API_TOKEN && process.env.ADMIN_TELEGRAM_CHAT_ID);
}

// Re-exports for the admin dashboard.
export const _internal = { PRICE, LOG_SIZE };

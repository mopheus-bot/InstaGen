// =====================================================================
// InstaGen — Content generation handler
// Route: POST /api/generate-content
// =====================================================================
// Dual-model pipeline:
//   Step 1 — Text synthesis (MiniMax-M3)        → 8 historical events
//   Step 2 — Image parallelization (image-01)   → 8 visuals via Promise.all
//
// Persona + visual aesthetic per niche are resolved at request time by
// the Prompt Factory in api/niche_profiles.js. This file no longer
// carries its own NICHES map — the factory is the single source of truth.
//
// Required env:
//   MINIMAX_API_KEY
//
// Notes:
//   - This handler is mounted by server.js as POST /api/generate-content
//     (Express). It uses the Web Fetch API Request/Response shape so the
//     same code can be reused on any platform that speaks Web Fetch.
//   - Place a fallback image at public/assets/placeholder-error.png so the
//     UI never breaks when an image slice fails.
//   - Project is "type": "module" (see package.json), so this file runs as
//     native ESM. No transpilation, no require(), no CommonJS.
// =====================================================================

// ---------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------
import { resolveNicheProfile } from './niche_profiles.js';
import { buildNicheQuery } from './niche_queries.js';
import { withCors, getClientIp } from './_request.js';
import { recordUsage } from './_usage.js';
import { setDailyContent } from './daily_content_store.js';
import { r2PutObject, r2Configured } from './cf_r2.js';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------
const TEXT_API_URL = 'https://api.minimax.io/anthropic/v1/messages';
const IMAGE_API_URL = 'https://api.minimax.io/v1/image_generation';
const PLACEHOLDER_IMAGE = '/assets/placeholder-error.png';

// Default aesthetic signature — used only as a defensive fallback if a
// profile is somehow missing its imageStyleSuffix. The per-niche
// signature is what actually drives the image model.
const DEFAULT_AESTHETIC_SUFFIX =
  ', historical cinematic film still, documentary textures, ' +
  'highly photorealistic, square crop';

// Target slide count — the system prompt also enforces this, but we
// cap defensively after parsing in case the model returns extras.
const TARGET_SLIDE_COUNT = 8;

// ---------------------------------------------------------------------
// Niche persona + image aesthetic
// ---------------------------------------------------------------------
// Resolved per-request via the Prompt Factory in api/niche_profiles.js.
// Each profile supplies the complete text system prompt, the per-niche
// image style suffix, the display label, and the sampling temperature.
// An unknown / missing / malformed niche id always falls back to the
// 'history' profile, so the original engine's behavior is preserved.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Date helpers (run on the server, use server-local timezone)
// ---------------------------------------------------------------------

/** YYYY-MM-DD in the server's local timezone. Used as `dateKey` in the response. */
function getDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "January 7" style label injected into the system prompt. */
function getPrettyDate() {
  return new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------
// Step 1 — Text synthesis (niche-aware agent)
// ---------------------------------------------------------------------

/**
 * The niche-aware text-generation agent.
 *
 * Issues a single POST to the MiniMax Anthropic-compatible endpoint
 * (https://api.minimax.io/anthropic/v1/messages), pinned to the
 * MiniMax-M3 model, with the persona's FULL system prompt delivered
 * via the top-level `system` field (per the Anthropic Messages API
 * contract — NOT as a {role:"system"} entry in the messages array).
 *
 * The system prompt comes from the resolved niche profile (see
 * api/niche_profiles.js). Each profile pins its own persona rules
 * AND the strict JSON-array data contract, so the model cannot
 * drift into a different output shape just because the persona
 * changes. The factory also supplies the sampling temperature per
 * profile (default 0.6).
 *
 * Response shape (Anthropic Messages):
 *   { content: [
 *       { type: "thinking", thinking: "..." },   // optional, may appear first
 *       { type: "text",     text:     "..." },
 *       ...
 *     ] }
 *
 * We extract the first `text` block (skipping any `thinking` blocks).
 *
 * @param {string}        currentDate  Human-readable date (e.g., "January 7").
 * @param {string}        nicheId      Active niche id from the request
 *                                     body. Resolved by the Prompt
 *                                     Factory to a full profile object
 *                                     (text system prompt, label,
 *                                     temperature, image suffix).
 * @param {AbortSignal}   [signal]     Optional AbortSignal — typically
 *                                     `request.signal` from the Web
 *                                     Fetch handler. When the client
 *                                     disconnects, the in-flight fetch
 *                                     is cancelled.
 * @returns {Promise<string>}          The raw assistant text content.
 * @throws  If the request fails, the response is non-2xx, or the
 *          body is empty.
 */
async function runHistoricalTextAgent(currentDate, nicheId, signal) {
  const apiKey = process.env.MINIMAX_API_KEY;
  const profile = resolveNicheProfile(nicheId);

  // The profile carries the COMPLETE system prompt — persona, topic
  // rules, and the JSON-array data contract are all defined there.
  // No further assembly is needed here.
  const systemPrompt = profile.textSystemPrompt;
  const temperature = typeof profile.textTemperature === 'number'
    ? profile.textTemperature
    : 0.6;

  // Resolve the niche-specific query context (search terms, category
  // filters, date window, and the explicit query directive) from the
  // Data Access Layer in api/niche_queries.js. This is the
  // "conditional query builder" the spec calls for: it tells the
  // archivist LLM EXACTLY which slice of history to query for this
  // niche on this date (e.g. "court case, heist, mystery, unsolved,
  // arrest" for true_crime) BEFORE the AI filter agent ever sees the
  // results. The directive is the first line of the user message so
  // the model reads the search brief before anything else.
  const queryContext = buildNicheQuery(nicheId);
  console.log(
    `[niche-query] active=${queryContext.id} window="${queryContext.dateWindow}" ` +
    `terms=${queryContext.searchTerms.length} categories=${queryContext.categoryFilters.length}`
  );

  const response = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Anthropic SDK normally uses `x-api-key`; MiniMax's gateway
      // accepts either, and we keep the Bearer form for parity with
      // the image endpoint.
      Authorization: `Bearer ${apiKey}`,
      // Pin the Anthropic Messages protocol version MiniMax emulates.
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      // System prompt lives at the top level in the Anthropic format.
      system: systemPrompt,
      messages: [
        // Query directive FIRST (the search brief for this niche on
        // this date), then the human-readable date + format reminder.
        // The profile's system prompt already pins the JSON contract
        // and persona; the directive is a focused, niche-specific
        // search instruction that scopes WHICH data to fetch.
        {
          role: 'user',
          content:
            `${queryContext.directive}\n\n` +
            `Today is ${currentDate}. Return the 8 events for this date ` +
            `in the "${profile.label}" niche as a raw JSON array.`,
        },
      ],
      // Per-niche temperature from the profile (default 0.6).
      temperature,
      max_tokens: 4096,
    }),
    // Forward the AbortSignal so a client disconnect cancels the
    // upstream fetch instead of leaving it running.
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    throw new Error(
      `Text API responded ${response.status}: ${errBody.slice(0, 300)}`
    );
  }

  const data = await response.json();

  // Primary: Anthropic Messages shape — `content` is an array of blocks.
  // Find the first block whose type is "text" and return its `text`.
  const content = Array.isArray(data?.content) ? data.content : [];
  const textBlock = content.find((b) => b && b.type === 'text');

  // Fallbacks: OpenAI chat-completions shape and a few other
  // belt-and-suspenders fields in case the gateway ever varies.
  const text = (
    textBlock?.text ??
    data?.choices?.[0]?.message?.content ??
    data?.reply ??
    data?.output?.text ??
    data?.text ??
    ''
  );

  // Return the text AND the usage block so the caller can charge
  // for the call. The Anthropic Messages shape puts
  //   { input_tokens, output_tokens }
  // at the top level of the response. OpenAI chat-completions uses
  //   { prompt_tokens, completion_tokens, total_tokens }.
  // We accept both.
  const usage = {
    inputTokens:  Number(data?.usage?.input_tokens  ?? data?.usage?.prompt_tokens     ?? 0),
    outputTokens: Number(data?.usage?.output_tokens ?? data?.usage?.completion_tokens ?? 0),
  };
  return { text, usage };
}

/**
 * Defensively sanitizes the LLM string before JSON.parse().
 *
 * Steps (in order):
 *   1. Trim outer whitespace.
 *   2. Explicit conditional checks to strip a leading ```json or ```
 *      markdown fence if the model slipped one in.
 *   3. Strip a trailing ``` markdown fence.
 *   4. Final trim pass.
 *
 * Does NOT call JSON.parse() — the caller does that inside its own
 * try/catch so a syntax anomaly is caught gracefully.
 */
function sanitizeLlmOutput(rawText) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    throw new Error('LLM returned empty or non-string content.');
  }

  // 1) Outer whitespace.
  let cleaned = rawText.trim();

  // 2) Explicit fallback conditional checks for the leading fence.
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice('```json'.length);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }

  // 3) Trailing fence (the CRITICAL CONSTRAINT in the system prompt
  // tells the model not to emit one, but we belt-and-suspenders it).
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }

  // 4) Final trim after stripping.
  return cleaned.trim();
}

/**
 * Try to recover a JSON array of event objects from a raw LLM
 * response, in three strategies:
 *
 *   1) `sanitizeLlmOutput` + `JSON.parse` (strips ``` fences and
 *      tries the whole string verbatim).
 *   2) If (1) throws, regex-extract the slice between the first
 *      `[` and the last `]` in the sanitized string and parse that
 *      substring. This catches the common case where the model
 *      wraps the array in prose like:
 *         "Sure, here are today's events: [...]\nLet me know..."
 *   3) If (2) still throws or yields a non-array, rethrow the
 *      original (1) error so the caller logs the most diagnostic
 *      message (the first parser usually points at the actual
 *      syntax issue).
 *
 * Returns the parsed array. Throws on any failure with the most
 * informative error message.
 *
 * @param {string} rawText
 * @returns {object[]}
 */
function parseEventsArray(rawText) {
  const cleaned = sanitizeLlmOutput(rawText);
  let firstErr;
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    firstErr = new Error('parse returned non-array value.');
  } catch (e) {
    firstErr = e;
  }

  // Strategy 2: slice between the first [ and the last ]. If those
  // characters don't both appear, we have nothing to extract.
  const openIdx = cleaned.indexOf('[');
  const closeIdx = cleaned.lastIndexOf(']');
  if (openIdx >= 0 && closeIdx > openIdx) {
    const slice = cleaned.slice(openIdx, closeIdx + 1);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) {
        console.warn(
          `[parse] recovered from prose-wrapped LLM output ` +
          `(${cleaned.length - slice.length} chars trimmed).`
        );
        return parsed;
      }
    } catch (e) {
      // Fall through — prefer the FIRST error so the log points at
      // the actual syntax anomaly rather than the truncated slice.
    }
  }

  throw firstErr;
}

/**
 * Normalizes one event object from the parsed array into the shape we
 * need downstream (year/title/description as strings, image_prompt
 * guaranteed to be a non-empty string).
 */
function normalizeEvent(raw, index) {
  const title = String(raw?.title ?? `Event ${index + 1}`).slice(0, 120);
  const description = String(raw?.description ?? '').slice(0, 320);
  const imagePrompt =
    typeof raw?.image_prompt === 'string' && raw.image_prompt.trim().length > 0
      ? raw.image_prompt
      : `${title}, cinematic, dramatic lighting, atmospheric scene`;

  return {
    year: String(raw?.year ?? 'Unknown'),
    title,
    description,
    image_prompt: imagePrompt,
  };
}

// ---------------------------------------------------------------------
// Step 2 — Image generation (per-slice, fault-isolated)
// ---------------------------------------------------------------------

/**
 * Calls the MiniMax image-generation endpoint for a single prompt.
 * Returns a `data:image/jpeg;base64,...` URL string ready to drop
 * into an <img src=...>, or throws on transport / API error.
 *
 * Per MiniMax's docs, the response shape is:
 *   { data: { image_base64: [ "<b64>", "<b64>", ... ] } }
 * We request `response_format: "base64"` so the gateway returns the
 * image bytes inline (no CORS, no expiry, no extra HTTP hop).
 *
 * @param {string}      apiKey
 * @param {string}      imagePrompt
 * @param {string}      [styleSuffix]  Per-niche visual signature
 *                                     resolved from the active
 *                                     profile. Falls back to
 *                                     DEFAULT_AESTHETIC_SUFFIX if
 *                                     missing/empty.
 * @param {AbortSignal} [signal]       Forwarded AbortSignal — when
 *                                     the client disconnects, the
 *                                     in-flight image request is
 *                                     cancelled.
 */
async function callImageAPI(apiKey, imagePrompt, styleSuffix, signal) {
  const suffix = (typeof styleSuffix === 'string' && styleSuffix.length > 0)
    ? styleSuffix
    : DEFAULT_AESTHETIC_SUFFIX;
  const fullPrompt = `${imagePrompt}${suffix}`;

  const response = await fetch(IMAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'image-01',
      prompt: fullPrompt,
      aspect_ratio: '9:16',
      response_format: 'base64',
    }),
    // Forward the AbortSignal so a client disconnect cancels the
    // upstream fetch instead of leaving it running.
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    throw new Error(
      `Image API responded ${response.status}: ${errBody.slice(0, 300)}`
    );
  }

  const data = await response.json();

  // Primary path: MiniMax Anthropic/OpenAI-compatible gateway returns
  // { data: { image_base64: [ "<b64>", ... ] } }. Wrap the first
  // entry as a data URL the browser can render directly.
  const base64Array = data?.data?.image_base64;
  if (Array.isArray(base64Array) && base64Array.length > 0 && base64Array[0]) {
    return `data:image/jpeg;base64,${base64Array[0]}`;
  }

  // Fallback chain in case the gateway ever returns a hosted URL
  // (older API versions, alternative regions, etc.).
  const hostedUrl =
    data?.data?.[0]?.url ??
    data?.images?.[0]?.url ??
    data?.images?.[0] ??
    data?.image_url ??
    data?.output?.image_url ??
    null;
  if (hostedUrl) return hostedUrl;

  // Nothing recognizable in the response — let the caller fall back
  // to the placeholder via the existing null check in generateImageSafely.
  return null;
}

/**
 * Fault-isolated wrapper around callImageAPI. This is the function
 * passed into Promise.all() so that a single slice failure (rate limit,
 * network hiccup, malformed response) NEVER poisons the whole carousel —
 * the failing slice just gets the local placeholder, and the remaining
 * successful slides still return uninterrupted.
 *
 * @param {string}      apiKey
 * @param {string}      imagePrompt
 * @param {number}      slideIndex
 * @param {string}      [styleSuffix]  Per-niche visual signature
 *                                     forwarded to callImageAPI.
 * @param {AbortSignal} [signal]       Forwarded to callImageAPI. If
 *                                     the client disconnects
 *                                     mid-flight, the AbortError is
 *                                     rethrown so the entire
 *                                     pipeline terminates (no point
 *                                     continuing to spend API credits
 *                                     on a response that has no
 *                                     listener).
 */
/**
 * Decode a data:image/jpeg;base64,… string into raw JPEG bytes.
 * Returns null on any parse error. Used by the R2 upload step
 * below — the carousel store and the in-flight response are
 * JSON-friendly URLs, so the base64 bytes never travel further
 * than the immediate upload.
 */
function dataUrlToJpegBytes(dataUrl) {
  const m = /^data:image\/jpeg;base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}

/**
 * Hand the generated JPEG bytes to Cloudflare R2 and return the
 * public URL. Returns null if R2 is unconfigured, the input is
 * not a data: URL we recognise, or the upload fails. The caller
 * falls back to the data: URL in those cases so the carousel
 * still renders.
 */
async function uploadImageToR2(slideIndex, nicheId, dateKey, imageUrl) {
  if (!r2Configured()) return null;
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith('data:image/')) return null;
  const bytes = dataUrlToJpegBytes(imageUrl);
  if (!bytes) return null;
  // Key: images/<dateKey>/<niche>/<slide-index>.jpg — flat enough
  // for the R2 console to scan, namespaced enough that two niches
  // on the same day don't collide.
  const key = `images/${dateKey}/${nicheId}/slice-${String(slideIndex).padStart(2, '0')}.jpg`;
  try {
    return await r2PutObject({ key, body: bytes, contentType: 'image/jpeg' });
  } catch (err) {
    console.error(`[r2] image slice ${slideIndex} upload failed: ${err.message}`);
    return null;
  }
}

async function generateImageSafely(apiKey, imagePrompt, slideIndex, styleSuffix, signal) {
  try {
    const url = await callImageAPI(apiKey, imagePrompt, styleSuffix, signal);
    if (!url) {
      console.error(`[image] slice ${slideIndex}: no URL in response, using placeholder`);
      return PLACEHOLDER_IMAGE;
    }
    return url;
  } catch (err) {
    // Rethrow AbortError so the pipeline stops cleanly on client
    // disconnect. All other errors (rate limit, network hiccup,
    // malformed response) fall through to the placeholder.
    if (err?.name === 'AbortError') throw err;
    console.error(`[image] slice ${slideIndex} failed: ${err.message}`);
    return PLACEHOLDER_IMAGE;
  }
}

// ---------------------------------------------------------------------
// Response helper — wraps a JS value in a Web Fetch API Response so the
// handler works on both the Node.js Express runtime and any other
// platform that mounts Web Fetch handlers (Workers, Deno, Bun, etc.).
// ---------------------------------------------------------------------
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ---------------------------------------------------------------------
// Handler — exported as a NAMED export per HTTP method (Web Fetch API
// signature). server.js picks the `GET` / `POST` export per route and
// converts Express req/res into a Web Request/Response round-trip.
// Using `export default` would have been misread as the legacy
// `(req, res) => void` Node.js signature and our return value would
// have been ignored. Named export = unambiguous, future-proof.
// ---------------------------------------------------------------------

// Last-resort safety net. If anything in the handler throws outside the
// top-level try/catch (unhandled async rejection, sync throw from a
// top-level constant initializer, etc.), catch it and try to send a
// 500 instead of taking the Express process down.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

export const GET = withCors(async (_request, ctx) => {
  // Friendly response for direct browser hits (e.g., someone pasting
  // the URL into the address bar). The actual app flow is via POST
  // from public/app.js.
  return jsonResponse(
    {
      error: 'Method not allowed.',
      hint: 'This endpoint accepts POST only. Load the app at the site root to trigger generation.',
    },
    405,
    { Allow: 'POST' }
  );
});

export const POST = withCors(async (request, ctx) => {
  // No method guard needed — server.js routes the POST() export
  // only for POST requests. GET/PUT/etc. fall through to Express's
  // built-in 405 handling.
  //
  // `request` is the standard Web Request object built by server.js
  // from the Express req. We don't read the body here directly,
  // but we do forward `request.signal` to the upstream fetch calls
  // so a client disconnect cancels the in-flight MiniMax requests
  // instead of leaving them to run to completion (and burn API credits).

  // --- Auth / config guard -----------------------------------------
  const apiKey = process.env.MINIMAX_API_KEY;
  // Log the resolved end-user IP for ops/audit. Behind Cloudflare the
  // raw `request` IP is a Cloudflare edge IP; `ctx.ip` is the real
  // client (from CF-Connecting-IP / X-Forwarded-For).
  if (ctx?.ip) console.log(`[ip] ${ctx.ip}`);
  if (!apiKey) {
    return jsonResponse({
      error: 'Server misconfigured: MINIMAX_API_KEY is not set.',
    }, 500);
  }

  // --- Date context (computed on every invocation) -----------------
  const dateKey = getDateKey();
  const prettyDate = getPrettyDate();

  // --- Niche context (from POST body) -------------------------------
  // The frontend posts { niche: 'true-crime' | 'history' | ... }.
  // We tolerate a missing/unknown body by letting the factory fall
  // back to the 'history' profile, so an empty payload keeps the
  // original engine's behavior. Both kebab-case (legacy) and
  // snake_case (current) ids are accepted — see resolveNicheProfile.
  let requestedNiche;
  try {
    const body = await request.json();
    if (body && typeof body.niche === 'string') {
      requestedNiche = body.niche;
    }
  } catch {
    // No body / non-JSON body — fine, the factory will fall back.
  }
  const profile = resolveNicheProfile(requestedNiche);
  console.log(`[niche] active=${profile.id}`);

  try {
    // -----------------------------------------------------------------
    // STEP 1 — Text synthesis via MiniMax-M3 (niche-aware agent)
    // -----------------------------------------------------------------
    console.log(`[text] requesting events for ${prettyDate} (${dateKey}) · niche=${profile.id} ...`);

    // Hand the dynamically-resolved current date AND the requested
    // niche id to the agent. The agent resolves the id to a full
    // profile (system prompt, temperature) via the factory.
    const llmResult = await runHistoricalTextAgent(prettyDate, profile.id, request.signal);
    const rawLlmText = llmResult?.text ?? '';
    const textUsage  = llmResult?.usage ?? { inputTokens: 0, outputTokens: 0 };

    if (!rawLlmText) {
      throw new Error('Text API returned empty content.');
    }
    console.log(`[text] received ${rawLlmText.length} chars`);

    // Defensive JSON parse — try a few strategies in order, so a
    // model that wraps the array in prose or drops a trailing
    // fence still produces a valid carousel instead of 502ing the
    // whole request.
    //
    //   1) Strip markdown fences (``` / ```json) then JSON.parse.
    //   2) On failure, regex-extract the slice between the first
    //      "[" and the matching last "]" and parse that. Handles
    //      "Sure! Here you go: [...]\n\nLet me know if ...".
    //   3) On failure, return a 502 with the parser error so the
    //      caller sees a real diagnostic.
    let events;
    let parseErr;
    try {
      events = parseEventsArray(rawLlmText);
    } catch (e) {
      parseErr = e;
    }

    if (!Array.isArray(events) || events.length === 0) {
      console.error('[parse] failed:', parseErr?.message || 'unknown');
      console.error('[parse] raw snippet:', rawLlmText.slice(0, 500));
      return jsonResponse({
        error: 'Model output could not be parsed as a JSON array.',
        details: parseErr?.message || 'parse returned empty/non-array',
      }, 502);
    }

    // Cap to TARGET_SLIDE_COUNT and normalize each entry. We ship what
    // the model gives us if it returned fewer than 8 — better to return
    // a partial carousel than a 502.
    const targetEvents = events
      .slice(0, TARGET_SLIDE_COUNT)
      .map((e, i) => normalizeEvent(e, i));

    // -----------------------------------------------------------------
    // STEP 2 — Concurrent image generation via image-01
    // -----------------------------------------------------------------
    // 8 requests fire in parallel via Promise.all. Each is wrapped in
    // generateImageSafely() which catches its own non-Abort errors
    // internally and falls back to the placeholder, so a single
    // failure cannot reject the whole Promise.all() and take down
    // the entire carousel. AbortError (client disconnect) is
    // rethrown so the pipeline terminates cleanly. The per-niche
    // image style suffix drives the visual identity of every slice.
    console.log(`[image] dispatching ${targetEvents.length} parallel requests ...`);
    const imageUrls = await Promise.all(
      targetEvents.map((event, idx) =>
        generateImageSafely(apiKey, event.image_prompt, idx, profile.imageStyleSuffix, request.signal)
      )
    );

    // "Success" = the slice produced a usable image URL. The image
    // API returns `data:image/jpeg;base64,...` URLs by default
    // (response_format: 'base64' is requested above), so the right
    // exclusion is "not the placeholder" — NOT "not a data URL".
    // An earlier version of this filter also required `!data:`
    // which silently counted every successful slice as a failure
    // and made the admin usage / Telegram alert report `img=0`
    // for every call.
    const placeholderCount = imageUrls.filter(
      (u) => u === PLACEHOLDER_IMAGE
    ).length;
    const successCount = imageUrls.length - placeholderCount;
    console.log(
      `[image] ${successCount}/${targetEvents.length} succeeded ` +
      `(${placeholderCount} placeholder)`
    );

    // -----------------------------------------------------------------
    // STEP 2.4 — Offload image bytes to Cloudflare R2 (best-effort)
    // -----------------------------------------------------------------
    // If R2 is configured, upload each successful data: URL to the
    // bucket and replace it in the response with the public URL.
    // The original data: URL is kept as the fallback so the
    // carousel still renders when R2 is unreachable. The bytes
    // never sit in server memory — we decode, hash, and stream
    // straight to R2 inside `r2PutObject`.
    //
    // Note: the upload happens AFTER Promise.all so a single slow
    // R2 PUT doesn't bottleneck the burst. Total wall-clock is
    // `min(8 × R2 latency)` not `sum`, but we still log the count.
    if (r2Configured()) {
      const r2Results = await Promise.allSettled(
        imageUrls.map((url, idx) =>
          uploadImageToR2(idx, profile.id, dateKey, url).then(
            (r2Url) => ({ idx, r2Url })
          )
        )
      );
      let r2Ok = 0, r2Fail = 0;
      for (const r of r2Results) {
        if (r.status === 'fulfilled' && r.value.r2Url) {
          imageUrls[r.value.idx] = r.value.r2Url;
          r2Ok++;
        } else {
          r2Fail++;
        }
      }
      console.log(
        `[r2] image upload: ${r2Ok}/${imageUrls.length} succeeded` +
        (r2Fail ? ` (${r2Fail} fell back to data: URL)` : '')
      );
    }

    // -----------------------------------------------------------------
    // STEP 2.5 — Record usage (text + images) for the admin alert.
    // -----------------------------------------------------------------
    // Two separate recordUsage calls: one for the text agent (token
    // counts) and one for the image burst (count of generated
    // images, priced at the per-image rate). The notifier fires
    // once per call so the operator sees a text row AND an image
    // row in Telegram, making a runaway image loop obvious.
    recordUsage({
      route: '/api/generate-content',
      niche: profile.id,
      model: 'MiniMax-M3',
      textInputTokens:  textUsage.inputTokens,
      textOutputTokens: textUsage.outputTokens,
      ip: ctx?.ip || null,
    }).catch(() => {});
    recordUsage({
      route: '/api/generate-content',
      niche: profile.id,
      model: 'image-01',
      imageCount: successCount,
      ip: ctx?.ip || null,
    }).catch(() => {});

    // -----------------------------------------------------------------
    // STEP 3 — Assemble the response payload (matches the frontend
    // data contract in public/app.js).
    // -----------------------------------------------------------------
    const imageStyleSuffix = profile.imageStyleSuffix || DEFAULT_AESTHETIC_SUFFIX;
    const slides = targetEvents.map((event, idx) => ({
      year: event.year,
      title: event.title,
      description: event.description,
      // Surface the full image prompt so the UI can show + let the user
      // copy it. The prompt is the verbatim text we sent to the image
      // model (including the per-niche imageStyleSuffix).
      imagePrompt: `${event.image_prompt}${imageStyleSuffix}`,
      imageUrl: imageUrls[idx],
    }));

    const responsePayload = {
      dateKey,                                // YYYY-MM-DD (cache key)
      generatedAt: new Date().toISOString(),  // ISO timestamp
      niche: profile.id,                      // echoed back for client display
      nicheLabel: profile.label,              // human-readable label
      slides,
    };

    // Persist to the daily content store (in-memory + Cloudflare KV
    // with TTL = seconds until next midnight). Fire-and-forget — the
    // user gets the response immediately; the KV write completes
    // in the background. setDailyContent stamps the payload with
    // the current dateKey so the read path can verify freshness.
    setDailyContent('carousel', profile.id, responsePayload).catch((err) => {
      console.error('[daily-content] write carousel failed:', err.message);
    });

    return jsonResponse(responsePayload);
  } catch (err) {
    // Catches anything that escaped the inner try/catches (text-API
    // failure, normalizeEvent throwing on a truly malformed object,
    // etc). Per-slice image failures are handled inside
    // generateImageSafely and never reach here.
    console.error('[pipeline] fatal:', err);
    return jsonResponse({
      error: 'Generation pipeline failed.',
      details: err.message,
    }, 500);
  }
});

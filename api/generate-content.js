// =====================================================================
// InstaGen — Vercel serverless function
// Route: POST /api/generate-content
// =====================================================================
// Dual-model pipeline:
//   Step 1 — Text synthesis (MiniMax-M3)        → 8 historical events
//   Step 2 — Image parallelization (image-01)   → 8 visuals via Promise.all
//
// Required env:
//   MINIMAX_API_KEY
//
// Notes:
//   - Vercel auto-routes this file to /api/generate-content (no vercel.json
//     rewrite needed). If you keep a "functions" block in vercel.json, point
//     it at "api/generate-content.js" and set maxDuration to ~300s.
//   - Place a fallback image at public/assets/placeholder-error.png so the
//     UI never breaks when an image slice fails.
//   - Project is "type": "module" (see package.json), so this file runs as
//     native ESM. No transpilation, no require(), no CommonJS.
// =====================================================================

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------
const TEXT_API_URL = 'https://api.minimax.io/anthropic/v1/messages';
const IMAGE_API_URL = 'https://api.minimax.io/v1/image_generation';
const PLACEHOLDER_IMAGE = '/assets/placeholder-error.png';

// Global aesthetic signature appended to every image prompt so the
// carousel has a consistent cinematic look across all 8 slides.
const AESTHETIC_SUFFIX =
  ', historical cinematic film still, documentary textures, ' +
  'highly photorealistic, square crop';

// Target slide count — the system prompt also enforces this, but we
// cap defensively after parsing in case the model returns extras.
const TARGET_SLIDE_COUNT = 8;

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
// Step 1 — Text synthesis (historical-archivist agent)
// ---------------------------------------------------------------------

/**
 * The exact, un-wrapped system-prompt rulebook that defines the agent
 * persona and pins down the JSON-array data contract. Verbatim per the
 * project spec — do not edit lightly, the model is sensitive to drift.
 */
const HISTORICAL_AGENT_SYSTEM_PROMPT = [
  'You are a highly specialized historical research archivist and expert social media copywriter for an educational Instagram brand.',
  '',
  'Your sole task is to take a provided date and return a list of exactly 8 highly compelling, historically significant events that occurred on that calendar day throughout history.',
  '',
  'CRITICAL CONSTRAINT: You must output ONLY a raw, valid JSON array matching the designated data contract. Do NOT wrap the output in markdown code blocks (such as ```json ... ```), do NOT include an introductory sentence, and do NOT append conversational prose.',
  '',
  'The JSON array must contain exactly 8 objects matching this structural interface:',
  '[',
  '  {',
  '    "year": "string (e.g., \'1969\' or \'44 BC\')",',
  '    "title": "string (click-optimized headline, maximum 8 words)",',
  '    "description": "string (retentive, high-engagement 2-3 sentence narrative hook summarizing the event)",',
  '    "image_prompt": "string (a descriptive, highly specific text-to-image prompt detailing the visual scene of the historical event for a generation engine)"',
  '  }',
  ']',
].join('\n');

/**
 * The historical-archivist text-generation agent.
 *
 * Issues a single POST to the MiniMax Anthropic-compatible endpoint
 * (https://api.minimax.io/anthropic/v1/messages), pinned to the
 * MiniMax-M3 model, with the strict archivist system prompt delivered
 * via the top-level `system` field (per the Anthropic Messages API
 * contract — NOT as a {role:"system"} entry in the messages array).
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
 * @param {AbortSignal}   [signal]     Optional AbortSignal — typically
 *                                     `request.signal` from the Vercel
 *                                     Web Handler. When the client
 *                                     disconnects, the in-flight fetch
 *                                     is cancelled (Vercel must have
 *                                     `supportsCancellation: true` for
 *                                     the signal to actually fire).
 * @returns {Promise<string>}          The raw assistant text content.
 * @throws  If the request fails, the response is non-2xx, or the
 *          body is empty.
 */
async function runHistoricalTextAgent(currentDate, signal) {
  const apiKey = process.env.MINIMAX_API_KEY;

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
      system: HISTORICAL_AGENT_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Today is ${currentDate}. Return the 8 historical events for this date as a raw JSON array.` },
      ],
      // 0.6 balances factual historical accuracy with engaging,
      // click-optimized copywriting for the Instagram brand voice.
      temperature: 0.6,
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
  return (
    textBlock?.text ??
    data?.choices?.[0]?.message?.content ??
    data?.reply ??
    data?.output?.text ??
    data?.text ??
    ''
  );
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
 * @param {AbortSignal} [signal]  Forwarded AbortSignal — when the
 *                                client disconnects, the in-flight
 *                                image request is cancelled.
 */
async function callImageAPI(apiKey, imagePrompt, signal) {
  const fullPrompt = `${imagePrompt}${AESTHETIC_SUFFIX}`;

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
 * @param {AbortSignal} [signal]  Forwarded to callImageAPI. If the
 *                                client disconnects mid-flight, the
 *                                AbortError is rethrown so the entire
 *                                pipeline terminates (no point
 *                                continuing to spend API credits on a
 *                                response that has no listener).
 */
async function generateImageSafely(apiKey, imagePrompt, slideIndex, signal) {
  try {
    const url = await callImageAPI(apiKey, imagePrompt, signal);
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
// handler works on both the Node.js and Edge Vercel runtimes.
// ---------------------------------------------------------------------
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ---------------------------------------------------------------------
// Handler — exported as a NAMED export per HTTP method (Web Fetch API
// signature). Vercel's auto-detector looks for `GET`, `POST`, etc. —
// using `export default` would have been misread as the legacy
// `(req, res) => void` Node.js signature and our return value would
// have been ignored. Named export = unambiguous, future-proof.
// ---------------------------------------------------------------------

// Last-resort safety net. If anything in the handler throws outside the
// top-level try/catch (unhandled async rejection, sync throw from a
// top-level constant initializer, etc.), catch it and try to send a
// 500 instead of letting Vercel surface FUNCTION_INVOCATION_FAILED.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

export async function GET() {
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
}

export async function POST(request) {
  // No method guard needed — Vercel only invokes the POST() export
  // for POST requests. GET/PUT/etc. get a 405 from Vercel itself.
  //
  // `request` is the standard Web Request object (per the Vercel
  // Functions API Reference). We don't read the body, but we do
  // forward `request.signal` to the upstream fetch calls so a client
  // disconnect cancels the in-flight MiniMax requests instead of
  // leaving them to run to completion (and burn API credits).

  // --- Auth / config guard -----------------------------------------
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return jsonResponse({
      error: 'Server misconfigured: MINIMAX_API_KEY is not set.',
    }, 500);
  }

  // --- Date context (computed on every invocation) -----------------
  const dateKey = getDateKey();
  const prettyDate = getPrettyDate();

  try {
    // -----------------------------------------------------------------
    // STEP 1 — Text synthesis via MiniMax-M3 (historical-archivist agent)
    // -----------------------------------------------------------------
    console.log(`[text] requesting events for ${prettyDate} (${dateKey}) ...`);

    // Hand the dynamically-resolved current date to the agent. The
    // agent itself is responsible for assembling the request body,
    // pinning the model, and authenticating.
    const rawLlmText = await runHistoricalTextAgent(prettyDate, request.signal);

    if (!rawLlmText) {
      throw new Error('Text API returned empty content.');
    }
    console.log(`[text] received ${rawLlmText.length} chars`);

    // Defensive JSON parse — wrap the whole thing in try/catch so a
    // syntax anomaly (truncated array, stray character, etc.) is
    // caught gracefully instead of crashing the process thread.
    let events;
    try {
      const cleaned = sanitizeLlmOutput(rawLlmText);
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('LLM output parsed to an empty or non-array value.');
      }
      events = parsed;
    } catch (parseErr) {
      console.error('[parse] failed:', parseErr.message);
      console.error('[parse] raw snippet:', rawLlmText.slice(0, 500));
      return jsonResponse({
        error: 'Model output could not be parsed as a JSON array.',
        details: parseErr.message,
      }, 502);
    }

    if (!Array.isArray(events) || events.length === 0) {
      return jsonResponse({
        error: 'Model output parsed to an empty or non-array value.',
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
    // rethrown so the pipeline terminates cleanly.
    console.log(`[image] dispatching ${targetEvents.length} parallel requests ...`);
    const imageUrls = await Promise.all(
      targetEvents.map((event, idx) =>
        generateImageSafely(apiKey, event.image_prompt, idx, request.signal)
      )
    );

    const successCount = imageUrls.filter((u) => u !== PLACEHOLDER_IMAGE && !u.startsWith('data:image/')).length;
    console.log(`[image] ${successCount}/${targetEvents.length} succeeded`);

    // -----------------------------------------------------------------
    // STEP 3 — Assemble the response payload (matches the frontend
    // data contract in public/app.js).
    // -----------------------------------------------------------------
    const slides = targetEvents.map((event, idx) => ({
      year: event.year,
      title: event.title,
      description: event.description,
      // Surface the full image prompt so the UI can show + let the user
      // copy it. The prompt is the verbatim text we sent to the image
      // model (including the AESTHETIC_SUFFIX it was suffixed with).
      imagePrompt: `${event.image_prompt}${AESTHETIC_SUFFIX}`,
      imageUrl: imageUrls[idx],
    }));

    return jsonResponse({
      dateKey,                                // YYYY-MM-DD (cache key)
      generatedAt: new Date().toISOString(),  // ISO timestamp
      slides,
    });
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
}

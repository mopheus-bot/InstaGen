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
const TEXT_API_URL = 'https://api.minimax.io/v1/text_generation';
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
 * Issues a single POST to the MiniMax text-generation endpoint,
 * pinned to the MiniMax-M3 model, with the strict archivist system
 * prompt that forces a raw JSON-array response. The returned string
 * is the raw `data.choices[0].message.content` payload (with a
 * couple of belt-and-suspenders fallbacks in case the gateway shape
 * ever varies).
 *
 * @param {string} currentDate  Human-readable date (e.g., "January 7").
 * @returns {Promise<string>}   The raw assistant content string.
 * @throws  If the request fails, the response is non-2xx, or the
 *          body is empty.
 */
async function runHistoricalTextAgent(currentDate) {
  const apiKey = process.env.MINIMAX_API_KEY;

  const response = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      messages: [
        { role: 'system', content: HISTORICAL_AGENT_SYSTEM_PROMPT },
        { role: 'user', content: `Today is ${currentDate}. Return the 8 historical events for this date as a raw JSON array.` },
      ],
      // 0.6 balances factual historical accuracy with engaging,
      // click-optimized copywriting for the Instagram brand voice.
      temperature: 0.6,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    throw new Error(
      `Text API responded ${response.status}: ${errBody.slice(0, 300)}`
    );
  }

  const data = await response.json();

  // Primary path per spec: data.choices[0].message.content.
  // Fallbacks cover gateways that nest the reply under alternate fields.
  return (
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
 * Returns a hosted image URL string, or throws on transport / API error.
 */
async function callImageAPI(apiKey, imagePrompt) {
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
      aspect_ratio: '1:1',
      n: 1,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    throw new Error(
      `Image API responded ${response.status}: ${errBody.slice(0, 300)}`
    );
  }

  const data = await response.json();

  // Try every plausible field the gateway might use.
  return (
    data?.data?.[0]?.url ??
    data?.images?.[0]?.url ??
    data?.images?.[0] ??
    data?.image_url ??
    data?.output?.image_url ??
    null
  );
}

/**
 * Fault-isolated wrapper around callImageAPI. This is the function
 * passed into Promise.all() so that a single slice failure (rate limit,
 * network hiccup, malformed response) NEVER poisons the whole carousel —
 * the failing slice just gets the local placeholder, and the remaining
 * successful slides still return uninterrupted.
 */
async function generateImageSafely(apiKey, imagePrompt, slideIndex) {
  try {
    const url = await callImageAPI(apiKey, imagePrompt);
    if (!url) {
      console.error(`[image] slice ${slideIndex}: no URL in response, using placeholder`);
      return PLACEHOLDER_IMAGE;
    }
    return url;
  } catch (err) {
    // Log and fall through to the placeholder. Note we intentionally
    // do NOT rethrow — the Promise.all() must complete so the response
    // can still be assembled for the surviving slices.
    console.error(`[image] slice ${slideIndex} failed: ${err.message}`);
    return PLACEHOLDER_IMAGE;
  }
}

// ---------------------------------------------------------------------
// Handler — exported as default so Vercel picks it up as the function
// entry point. Signature is (req, res) to match Vercel's serverless
// request/response interface.
// ---------------------------------------------------------------------
export default async function handler(req, res) {
  // Method guard — this endpoint is POST-only.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // --- Auth / config guard -----------------------------------------
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server misconfigured: MINIMAX_API_KEY is not set.',
    });
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
    const rawLlmText = await runHistoricalTextAgent(prettyDate);

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
      return res.status(502).json({
        error: 'Model output could not be parsed as a JSON array.',
        details: parseErr.message,
      });
    }

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(502).json({
        error: 'Model output parsed to an empty or non-array value.',
      });
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
    // generateImageSafely() which catches its own errors internally,
    // so a single failure cannot reject the whole Promise.all() and
    // take down the entire carousel.
    console.log(`[image] dispatching ${targetEvents.length} parallel requests ...`);
    const imageUrls = await Promise.all(
      targetEvents.map((event, idx) =>
        generateImageSafely(apiKey, event.image_prompt, idx)
      )
    );

    const successCount = imageUrls.filter((u) => u !== PLACEHOLDER_IMAGE).length;
    console.log(`[image] ${successCount}/${targetEvents.length} succeeded`);

    // -----------------------------------------------------------------
    // STEP 3 — Assemble the response payload (matches the frontend
    // data contract in public/app.js).
    // -----------------------------------------------------------------
    const slides = targetEvents.map((event, idx) => ({
      year: event.year,
      title: event.title,
      description: event.description,
      imageUrl: imageUrls[idx],
    }));

    return res.status(200).json({
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
    return res.status(500).json({
      error: 'Generation pipeline failed.',
      details: err.message,
    });
  }
}

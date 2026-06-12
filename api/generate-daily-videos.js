// =====================================================================
// InstaGen — Daily videos generation handler
// Route: POST /api/generate-daily-videos
// =====================================================================
// Five-step pipeline that turns one calendar day into 3 short-form videos:
//
//   Step 1 — Text synthesis (MiniMax-M3)   → 8 historical events for today
//   Step 2 — Filtering agent (MiniMax-M3)  → 3 video variants of the
//                                            most-viral single event
//   Step 3 — Image parallelization         → 3 variants × 4 scenes = 12
//                                            images (image-01)
//   Step 4 — Video bundling                → MP4 per variant, via either
//                                            an external Remotion/HeyGen-
//                                            style webhook OR a local
//                                            ffmpeg child_process (lazy
//                                            import, optional dep)
//   Step 5 — Response                      → { videos: [{url,title,year}] }
//
// Persona + visual aesthetic per niche are resolved at request time by
// the Prompt Factory in api/niche_profiles.js. This file previously
// ignored the niche field; it now honors it for Step 1 (text) and
// Step 3 (image aesthetic).
//
// Required env:
//   MINIMAX_API_KEY
//
// Optional env (Step 4 provider switch):
//   EXTERNAL_VIDEO_WEBHOOK   URL that accepts the bundle payload and
//                            returns { url }. Wins over ffmpeg if both
//                            are set.
//   BUNDLE_PROVIDER=ffmpeg   Use the lazy-imported ffmpeg path. Requires
//                            the `ffmpeg-static` and `fluent-ffmpeg`
//                            packages to be installed locally — they
//                            are NOT in package.json by default.
//   VIDEO_TEMP_DIR           Writable directory for ffmpeg output.
//                            Defaults to public/videos on a long-lived
//                            host, /tmp/videos when the deployment
//                            filesystem is ephemeral (e.g. containers
//                            without a mounted volume). The external
//                            webhook path is the recommended production
//                            answer regardless.
//
// Notes:
//   - This handler is mounted by server.js as POST /api/generate-daily-videos
//     (Express). It uses the Web Fetch API Request/Response shape so the
//     same code can be reused on any platform that speaks Web Fetch.
//   - "type": "module" is set in package.json, so this file runs as
//     native ESM — no require(), no transpilation.
//   - request.signal is forwarded to every upstream fetch so a client
//     disconnect cancels the in-flight MiniMax calls instead of
//     burning API credits.
// =====================================================================

// ---------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------
import { resolveNicheProfile } from './niche_profiles.js';
import { buildNicheQuery } from './niche_queries.js';
import { withCors, getClientIp, getPublicOrigin } from './_request.js';
import { recordUsage } from './_usage.js';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------
const TEXT_API_URL = 'https://api.minimax.io/anthropic/v1/messages';
const IMAGE_API_URL = 'https://api.minimax.io/v1/image_generation';

// Default vertical visual signature. Used only as a defensive fallback
// if a profile is somehow missing its imageStyleSuffix. The per-niche
// signature from the Prompt Factory is what actually drives the image
// model.
const DEFAULT_AESTHETIC_SUFFIX =
  ', historical cinematic film still, documentary textures, ' +
  'highly photorealistic, vertical 9:16 crop';

// Archivist target — same 8-event roster that the carousel route
// generates. We only need it as input to the filtering agent, not
// for direct rendering, so the field names match the source contract.
const TARGET_EVENT_COUNT = 8;

// Filtering-agent target — exactly 3 video variants of the SAME
// chosen event. Three gives the frontend a useful A/B surface for
// hook/script testing without exploding the wall-clock.
const TARGET_VARIANT_COUNT = 3;

// Image prompt count per variant. 4 scenes × ~4s each = ~16s, the
// sweet spot for a 15-second voiceover with a 1-second buffer.
const SCENES_PER_VARIANT = 4;

// Hard ceiling on total image API parallelism. The MiniMax image
// gateway occasionally 429s above ~8 concurrent calls per key; we
// cap defensively to avoid cascading failures.
const MAX_IMAGE_PARALLELISM = 6;

// File-system path for ffmpeg output. On ephemeral container hosts
// (where /tmp is writable but not persisted across deploys) we use
// /tmp/videos; on a long-lived host with a mounted volume the
// public/videos folder is preferred so the bundled MP4 is reachable
// by the static asset layer.
const VIDEO_TEMP_DIR = (() => {
  if (process.env.VIDEO_TEMP_DIR) return process.env.VIDEO_TEMP_DIR;
  // Ephemeral container detection: RAILWAY / FLY / RENDER set
  // environment hints that /tmp is the only writable scratch space.
  // Set FORCE_EPHEMERAL_TMP=1 in your environment to force this path
  // on any other host.
  const ephemeral =
    process.env.FORCE_EPHEMERAL_TMP === '1' ||
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    Boolean(process.env.FLY_APP_NAME) ||
    Boolean(process.env.RENDER);
  return ephemeral ? '/tmp/videos' : 'public/videos';
})();

// Public URL prefix for the local-dev ffmpeg output. On a production
// deployment we don't reach this branch (no webhook + no ffmpeg
// binary in the container image), but we resolve the constant up
// front so the URL builder below can stay simple.
const VIDEO_PUBLIC_PREFIX = '/videos';

// ---------------------------------------------------------------------
// Text-to-video provider (MiniMax /v1/video_generation) — opt-in via
// BUNDLE_PROVIDER=minimax_video. When set, the POST handler submits
// one async task per variant and returns 202 with the task IDs; the
// existing webhook / ffmpeg / manifest paths stay untouched.
// Defaults are env-driven per the project spec — no hardcoded model
// or duration constants here.
// ---------------------------------------------------------------------
const MINIMAX_VIDEO_URL = 'https://api.minimax.io/v1/video_generation';
const DEFAULT_VIDGEN_MODEL = 'MiniMax-Hailuo-2.3';
const DEFAULT_VIDGEN_DURATION = 6;
const DEFAULT_VIDGEN_RESOLUTION = '768P';
const VIDEO_CALLBACK_PATH = '/api/video-callback';
const VIDEO_STATUS_PATH = '/api/video-status';

// Per-category preset for the text-to-video provider. The frontend
// passes `category` in the POST body and the engine uses the preset
// to pick a camera command + a composition line in the prompt.
// Unknown categories fall through to 'reel' (vertical short-form,
// the project default).
const CATEGORY_PRESETS = {
  reel:   { camera: '[Static shot, Push in]', composition: 'Vertical 9:16 composition, close framing, mobile-first viewing.' },
  tall:   { camera: '[Static shot, Push in]', composition: 'Vertical 9:16 composition, close framing, mobile-first viewing.' },
  square: { camera: '[Static shot]',          composition: 'Square 1:1 composition, balanced framing.' },
  wide:   { camera: '[Pan right]',            composition: 'Wide 16:9 composition, cinematic framing.' },
};
const DEFAULT_CATEGORY = 'reel';

// ---------------------------------------------------------------------
// Date helpers (server-local timezone)
// ---------------------------------------------------------------------

/** YYYY-MM-DD in the server's local timezone. */
function getDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "January 7" style label injected into the system prompts. */
function getPrettyDate() {
  return new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------
// Shared LLM output sanitization
// ---------------------------------------------------------------------

/**
 * Defensive trim + fence strip. The system prompts tell the model
 * not to emit markdown fences, but the same belt-and-suspenders
 * pattern from api/generate-content.js is reused here so a stray
 * ```json ... ``` is handled without a 502.
 */
function sanitizeLlmOutput(rawText) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    throw new Error('LLM returned empty or non-string content.');
  }
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice('```json'.length);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

// ---------------------------------------------------------------------
// Step 1 — Text synthesis (niche-aware agent)
// ---------------------------------------------------------------------

/**
 * Step 1 agent. Calls MiniMax-M3 with the active niche's full system
 * prompt (resolved by the Prompt Factory in api/niche_profiles.js) and
 * returns both the raw assistant text AND the niche query context
 * that was used to scope the query. The caller JSON.parses the text
 * into an 8-element array that feeds the filtering agent, and passes
 * the query context down so the filter agent knows what slice of
 * history it is picking the top item FROM.
 *
 * @param {string}        currentDate  Human-readable date (e.g., "January 7").
 * @param {string}        nicheId      Active niche id. The factory
 *                                     resolves it to a full profile
 *                                     (system prompt, label, temperature).
 *                                     An unknown / missing id falls
 *                                     back to the 'history' profile.
 * @param {AbortSignal}   [signal]     Forwarded AbortSignal — when the
 *                                     client disconnects, the in-flight
 *                                     fetch is cancelled.
 * @returns {Promise<{rawText: string, queryContext: object}>}
 *                                    `rawText` is the raw assistant
 *                                    text (caller parses). `queryContext`
 *                                    is the frozen niche query context
 *                                    (search terms, directive, etc.)
 *                                    that the caller threads into
 *                                    the filtering agent.
 */
async function runHistoricalTextAgent(currentDate, nicheId, signal) {
  const apiKey = process.env.MINIMAX_API_KEY;
  const profile = resolveNicheProfile(nicheId);
  const temperature = typeof profile.textTemperature === 'number'
    ? profile.textTemperature
    : 0.6;

  // Resolve the niche-specific query context (search terms, category
  // filters, date window, and the explicit query directive) from the
  // Data Access Layer in api/niche_queries.js. This is the
  // "conditional query builder" the spec calls for: it scopes WHICH
  // slice of history the archivist queries (e.g. "court case, heist,
  // mystery, unsolved, arrest" for true_crime; "archaeological
  // discovery, astronomical anomaly, monolith milestone" for
  // unsolved_earth) before the AI filter agent ever sees the events.
  // The directive is the first line of the user message so the model
  // reads the search brief before anything else.
  const queryContext = buildNicheQuery(nicheId);
  console.log(
    `[videos][niche-query] active=${queryContext.id} window="${queryContext.dateWindow}" ` +
    `terms=${queryContext.searchTerms.length} categories=${queryContext.categoryFilters.length}`
  );

  const response = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      system: profile.textSystemPrompt,
      messages: [
        // Query directive FIRST (the search brief for this niche on
        // this date), then the human-readable date + format reminder.
        {
          role: 'user',
          content:
            `${queryContext.directive}\n\n` +
            `Today is ${currentDate}. Return the 8 events for this date ` +
            `in the "${profile.label}" niche as a raw JSON array.`,
        },
      ],
      temperature,
      max_tokens: 4096,
    }),
    signal,
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    throw new Error(`Text API responded ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await response.json();
  const textBlock = Array.isArray(data?.content)
    ? data.content.find((b) => b && b.type === 'text')
    : null;
  const rawText = (
    textBlock?.text ??
    data?.choices?.[0]?.message?.content ??
    data?.reply ??
    data?.output?.text ??
    data?.text ??
    ''
  );
  const usage = {
    inputTokens:  Number(data?.usage?.input_tokens  ?? data?.usage?.prompt_tokens     ?? 0),
    outputTokens: Number(data?.usage?.output_tokens ?? data?.usage?.completion_tokens ?? 0),
  };
  // Return BOTH the raw text, the usage block, AND the query
  // context. The query context is what the AI filter agent needs
  // in Step 2 to know which slice of history it is selecting the
  // top item from.
  return { rawText, queryContext, usage };
}

/** Normalize one archivist event into a stable shape. */
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
// Step 2 — Filtering agent (viral-content curator)
// ---------------------------------------------------------------------

/**
 * VERBATIM system prompt from the spec. Do not edit lightly — the
 * model is sensitive to small wording changes around "exactly ONE"
 * and "exactly three objects". The wire-up depends on receiving a
 * 3-element array.
 */
const FILTERING_AGENT_SYSTEM_PROMPT = [
  'You are a viral social media content curator. Analyze the following list of historical events that happened on this day. Select exactly the ONE most fascinating, dramatic, or emotionally engaging events that would perform best as viral videos (high shock value, deep mystery, unique trivia, or extreme nostalgia). Return a structured JSON array containing exactly three objects. Each object must have:',
  '1. \'title\': A short punchy name for the event.',
  '2. \'hook\': A captivating 2-second opening sentence.',
  '3. \'script\': A high-retention 15-second video script optimized for voiceover.',
  '4. \'image_prompts\': An array of 4 detailed visual prompts corresponding to chronological scenes in the script to feed into our image generator.',
].join('\n');

/**
 * Step 2 agent. Sends the normalized 8-event list to MiniMax-M3
 * with the filtering system prompt and returns the raw text. The
 * caller parses it into a 3-element array of variants.
 *
 * The optional `queryContext` (resolved by the Data Access Layer
 * in api/niche_queries.js) lets the filter agent know WHICH slice
 * of history Step 1 queried for, so the "single most viral event"
 * it picks is viral WITHIN the niche's intent (e.g. an unsolved
 * case for true_crime, a hard-won breakthrough for women) — not
 * just a generic viral event that may not match the niche at all.
 * Two pieces of the context are used:
 *   - structuredHint is appended to the system prompt as a
 *     "NICHE FILTERING HINT" so the rule is enforced as a hard
 *     constraint, not just user-message context.
 *   - directive is prepended to the user message so the model
 *     sees the query brief alongside the 8 candidate events.
 *
 * @param {string}        currentDate  Human-readable date.
 * @param {Array}         events       Normalized 8-event list.
 * @param {object}        [queryContext]  Frozen niche query context
 *                                        from buildNicheQuery(). If
 *                                        omitted (e.g. legacy caller
 *                                        or a unit test), the agent
 *                                        falls back to its base
 *                                        system prompt.
 * @param {AbortSignal}   [signal]     Forwarded AbortSignal.
 * @returns {Promise<string>}          Raw assistant text (caller parses).
 */
async function runFilteringAgent(currentDate, events, queryContext, signal) {
  const apiKey = process.env.MINIMAX_API_KEY;

  // Compose the system prompt. If the niche provided a structured
  // hint, append it as a hard rule — this is what tells the filter
  // agent e.g. "prioritize unsolved cases, dramatic heists, and
  // forensic firsts" for true_crime, or "prioritize hard-won
  // breakthroughs over soft 'first to be photographed' entries"
  // for women.
  const baseSystem = FILTERING_AGENT_SYSTEM_PROMPT;
  const nicheHint = (queryContext && typeof queryContext.structuredHint === 'string')
    ? queryContext.structuredHint.trim()
    : '';
  const systemPrompt = nicheHint
    ? `${baseSystem}\n\nNICHE FILTERING HINT: ${nicheHint}`
    : baseSystem;

  // Serialize the event list as compact JSON inside a fenced user
  // message. We wrap in triple-backticks defensively (the system
  // prompt itself does NOT add fences; the user message fences
  // here are just for the model's reading comfort).
  const eventsJson = JSON.stringify(events);
  const queryDirective = (queryContext && typeof queryContext.directive === 'string')
    ? `${queryContext.directive}\n\n`
    : '';
  const response = await fetch(TEXT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content:
            // Query brief FIRST so the model reads what was queried
            // (e.g. "court case, heist, mystery, unsolved, arrest")
            // before scanning the 8 candidates. Then the date and
            // the events. Then the format reminder.
            `${queryDirective}` +
            `Today is ${currentDate}. Here are the 8 historical events:\n\n` +
            `\`\`\`json\n${eventsJson}\n\`\`\`\n\n` +
            `Return exactly 3 video-variant objects for the single most viral ` +
            `event in the "${(queryContext && queryContext.label) || ''}" niche, ` +
            `as a raw JSON array.`,
        },
      ],
      // Slightly higher temperature than the archivist — the
      // filtering agent is being asked to be creative with hooks
      // and scripts across 3 variants of the same event, so some
      // variance is desired.
      temperature: 0.8,
      max_tokens: 4096,
    }),
    signal,
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    throw new Error(`Filtering API responded ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await response.json();
  const textBlock = Array.isArray(data?.content)
    ? data.content.find((b) => b && b.type === 'text')
    : null;
  const text = (
    textBlock?.text ??
    data?.choices?.[0]?.message?.content ??
    data?.reply ??
    data?.output?.text ??
    data?.text ??
    ''
  );
  const usage = {
    inputTokens:  Number(data?.usage?.input_tokens  ?? data?.usage?.prompt_tokens     ?? 0),
    outputTokens: Number(data?.usage?.output_tokens ?? data?.usage?.completion_tokens ?? 0),
  };
  return { text, usage };
}

/**
 * Normalize one filtering-agent variant. Forces 4 image_prompts by
 * padding or trimming — the bundler downstream assumes exactly
 * 4 scenes per variant and we don't want to crash mid-pipeline if
 * the model over- or under-shoots.
 */
function normalizeVariant(raw, index) {
  const title = String(raw?.title ?? `Variant ${index + 1}`).slice(0, 120);
  const hook = String(raw?.hook ?? '').slice(0, 240);
  const script = String(raw?.script ?? '').slice(0, 1200);
  const rawPrompts = Array.isArray(raw?.image_prompts) ? raw.image_prompts : [];
  const prompts = rawPrompts
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .slice(0, SCENES_PER_VARIANT)
    .map((p) => p.trim());
  // Pad to exactly 4 with a derived prompt so the bundler always
  // has 4 frames per variant.
  while (prompts.length < SCENES_PER_VARIANT) {
    prompts.push(`${title}, cinematic wide shot, atmospheric scene, dramatic lighting`);
  }
  return { title, hook, script, image_prompts: prompts };
}

// ---------------------------------------------------------------------
// Step 3 — Image generation (per-scene, fault-isolated, rate-capped)
// ---------------------------------------------------------------------

/**
 * Single image-API call. Mirrors the carousel helper. Returns a
 * data URL or throws — fault isolation happens one level up in
 * generateImageSafely().
 *
 * @param {string}      apiKey
 * @param {string}      imagePrompt
 * @param {string}      [styleSuffix]  Per-niche visual signature
 *                                     resolved from the active
 *                                     profile. Falls back to
 *                                     DEFAULT_AESTHETIC_SUFFIX if
 *                                     missing/empty.
 * @param {AbortSignal} [signal]       Forwarded AbortSignal.
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
      aspect_ratio: '9:16',     // vertical, short-form native
      response_format: 'base64',
    }),
    signal,
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    throw new Error(`Image API responded ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await response.json();
  const base64Array = data?.data?.image_base64;
  if (Array.isArray(base64Array) && base64Array.length > 0 && base64Array[0]) {
    return `data:image/jpeg;base64,${base64Array[0]}`;
  }
  const hostedUrl =
    data?.data?.[0]?.url ??
    data?.images?.[0]?.url ??
    data?.images?.[0] ??
    data?.image_url ??
    data?.output?.image_url ??
    null;
  return hostedUrl;
}

/**
 * Fault-isolated image call. A single 429/timeout returns null so
 * the rest of the variant still ships with a placeholder for the
 * bad frame. AbortError is rethrown so a client disconnect
 * terminates the whole pipeline cleanly.
 *
 * @param {string}      apiKey
 * @param {string}      imagePrompt
 * @param {string}      ctxLabel
 * @param {string}      [styleSuffix]  Per-niche visual signature
 *                                     forwarded to callImageAPI.
 * @param {AbortSignal} [signal]       Forwarded AbortSignal.
 */
async function generateImageSafely(apiKey, imagePrompt, ctxLabel, styleSuffix, signal) {
  try {
    const url = await callImageAPI(apiKey, imagePrompt, styleSuffix, signal);
    if (!url) {
      console.error(`[image] ${ctxLabel}: empty response, using null placeholder`);
      return null;
    }
    return url;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.error(`[image] ${ctxLabel} failed: ${err.message}`);
    return null;
  }
}

/**
 * Bounded-concurrency map. Runs `worker` over each item with at
 * most `limit` in flight at any time. Returns results in the
 * ORIGINAL order, even though they complete out of order.
 *
 * We hand-roll this rather than using a third-party dep so the
 * serverless bundle stays small. The pattern is the standard
 * "next-batch" pool: launch `limit` workers, and whenever one
 * finishes, launch the next pending item.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    () => runOne()
  );
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------
// Step 4 — Video bundling (provider-agnostic integration boundary)
// ---------------------------------------------------------------------
//
// Two real paths and one safe stub:
//
//   (a) EXTERNAL_VIDEO_WEBHOOK set  → POST the bundle payload there,
//                                     expect { url } back. Production
//                                     default. Recommended for container
//                                     deployments because /tmp is not
//                                     publicly served and ffmpeg isn't
//                                     shipped in the default image.
//
//   (b) BUNDLE_PROVIDER=ffmpeg       → lazy-import ffmpeg-static +
//                                     fluent-ffmpeg, write an MP4 to
//                                     VIDEO_TEMP_DIR, return the
//                                     public URL. Best for local dev
//                                     and CI renderers.
//
//   (c) neither set                  → write a JSON manifest to
//                                     VIDEO_TEMP_DIR and return its
//                                     public URL. Lets the frontend
//                                     preview the script/hook/images
//                                     and unblocks UI work while the
//                                     real bundler is wired up.
//
// All three paths return a URL string that is dropped straight
// into the response. The handler does not care which one fired.

/** Build the bundle payload (the contract a Remotion/HeyGen-style
 *  external renderer would consume). Includes the script for
 *  TTS, the 4 image data URLs, and timing metadata. */
function buildBundlePayload(variant, year, images) {
  return {
    title: variant.title,
    year,
    hook: variant.hook,
    script: variant.script,
    duration_seconds: 15,
    // 4 frames evenly spaced across 15s ≈ 3.75s per frame. The
    // external renderer is free to interpolate (Ken Burns, cross-
    // fade, etc.) between them.
    scenes: images.map((imageUrl, idx) => ({
      index: idx,
      // 0.0s, 3.75s, 7.5s, 11.25s
      start_seconds: idx * (15 / images.length),
      imageUrl,
    })),
  };
}

/** Lazy import for the ffmpeg path. Returns { ffmpegPath, ffmpeg }
 *  or throws if the optional deps are not installed. */
async function loadFfmpegDeps() {
  // Dynamic import keeps the ffmpeg path out of the cold-start
  // path for users who only run the external webhook.
  let ffmpegStatic;
  try {
    ffmpegStatic = (await import('ffmpeg-static')).default;
  } catch {
    throw new Error(
      'BUNDLE_PROVIDER=ffmpeg but the `ffmpeg-static` package is not installed. ' +
      '`npm install ffmpeg-static fluent-ffmpeg` or unset BUNDLE_PROVIDER.'
    );
  }
  if (!ffmpegStatic) {
    throw new Error('ffmpeg-static returned a falsy binary path.');
  }
  const { default: ffmpeg } = await import('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegStatic);
  return { ffmpeg };
}

/**
 * Decode a data URL into raw bytes. The image API returns
 * `data:image/jpeg;base64,...` and ffmpeg needs an actual file on
 * disk (or a stream). We decode to a Buffer and write to a temp
 * path so the ffmpeg concat demuxer can read it.
 */
function dataUrlToBuffer(dataUrl) {
  const match = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  return Buffer.from(match[1], 'base64');
}

/**
 * (b) ffmpeg path. Concatenates 4 stills into a 15s vertical MP4
 * with a 1-second crossfade between each. No audio track here —
 * the script text is sent to the external TTS step (or read by
 * the on-screen caption renderer). Throws on failure.
 */
async function bundleWithFfmpeg(payload, outPath) {
  const { ffmpeg } = await loadFfmpegDeps();

  // Materialize each scene image to a temp file ffmpeg can read.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const tmpDir = await fs.mkdtemp(`${VIDEO_TEMP_DIR}/scene-`);

  try {
    const scenePaths = [];
    for (let i = 0; i < payload.scenes.length; i++) {
      const buf = dataUrlToBuffer(payload.scenes[i].imageUrl);
      if (!buf) throw new Error(`Scene ${i} image is not a data URL.`);
      const scenePath = path.join(tmpDir, `scene-${i}.jpg`);
      await fs.writeFile(scenePath, buf);
      scenePaths.push(scenePath);
    }

    // Each still gets 15/N seconds of screen time with a 1s
    // crossfade between adjacent frames. This produces a
    // 15s MP4 with smooth transitions that read as motion.
    const sceneDuration = 15 / scenePaths.length;
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg();
      scenePaths.forEach((p) => cmd.input(p).loop(sceneDuration));
      cmd
        .complexFilter(
          scenePaths
            .map((_, i) =>
              // xfade each adjacent pair.
              i === 0
                ? `[0:v]format=yuv420p,setsar=1[v${i}]`
                : `[v${i - 1}][${i}:v]xfade=transition=fade:duration=1:offset=${i * sceneDuration - 1}[v${i}]`
            )
            .join(';') + `;` +
            // Final output filter: scale to vertical 9:16, 30fps.
            `[v${scenePaths.length - 1}]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[outv]`
        )
        .outputOptions(['-map [outv]', '-c:v libx264', '-pix_fmt yuv420p', '-r 30'])
        .output(outPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
  } finally {
    // Best-effort cleanup of the per-variant tmp dir. Failures
    // here are non-fatal — /tmp may already be reaped on ephemeral
    // hosts, and we don't want a cleanup error to mask the success
    // of the bundle step above.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Build the per-variant video prompt. Combines the hook + script
 * (the actual story), the niche's image style signature (so the
 * text-to-video model matches the carousel aesthetic), the
 * category's camera command + composition line, and a closing
 * "static shot" so the final frame settles on a clean image.
 *
 * The MiniMax endpoint caps prompts at 2000 characters; we trim
 * from the END of the body (hook + script) and keep the camera
 * commands + composition + style suffix intact, since those shape
 * the actual output.
 */
function buildVideoPrompt(variant, nicheProfile, category) {
  const preset = CATEGORY_PRESETS[category] || CATEGORY_PRESETS[DEFAULT_CATEGORY];
  // The niche's imageStyleSuffix begins with ", " (it's designed to
  // be appended to a free-form image_prompt). For the video prompt
  // we already have a clean composition sentence, so strip the
  // leading separator to avoid ", ," artifacts.
  const rawStyle = nicheProfile.imageStyleSuffix || DEFAULT_AESTHETIC_SUFFIX;
  const styleSuffix = rawStyle.replace(/^,\s*/, '');
  // Style + camera directives go first so they survive the trim.
  const head = `${preset.composition} ${styleSuffix} ${preset.camera} [Static shot]`;
  const body = `${variant.hook}\n\n${variant.script}`;
  const combined = `${head}\n\n${body}`;
  const PROMPT_CAP = 2000;
  if (combined.length <= PROMPT_CAP) return combined;
  // Trim the body, keep the head. Reserve a small joiner budget.
  const headBudget = head.length + 4; // "\n\n" + head
  const bodyBudget = Math.max(0, PROMPT_CAP - headBudget - 8); // " ..." ellipsis
  return `${head}\n\n${body.slice(0, bodyBudget)} ...`;
}

/**
 * Submit one variant to MiniMax's video_generation endpoint and
 * return the task_id from the response. Throws on transport
 * failure, non-2xx, or a missing task_id — the caller catches
 * per-variant and skips the variant, mirroring the existing
 * Step 4 fault-isolation pattern.
 *
 * The same endpoint handles BOTH text-to-video and image-to-video.
 * The two modes are distinguished by whether `firstFrameImageUrl`
 * is provided:
 *   - T2V (text-to-video): pass `null`. The model animates from the
 *     prompt alone.
 *   - I2V (image-to-video): pass a data URL (or hosted URL). The
 *     model uses it as the starting frame and the prompt describes
 *     the motion.
 *
 * Per the MiniMax docs, `first_frame_image` accepts a public URL
 * OR a base64 Data URL — the data URL we pass from our image API
 * works as-is.
 */
async function submitMinimaxVideoTask(variant, profile, category, firstFrameImageUrl, callbackUrl, signal) {
  const apiKey = process.env.MINIMAX_API_KEY;
  const model = process.env.VIDGEN_MODEL || DEFAULT_VIDGEN_MODEL;
  const duration = Number.isInteger(parseInt(process.env.VIDGEN_DURATION, 10))
    ? parseInt(process.env.VIDGEN_DURATION, 10)
    : DEFAULT_VIDGEN_DURATION;
  const resolution = process.env.VIDGEN_RESOLUTION || DEFAULT_VIDGEN_RESOLUTION;

  const prompt = buildVideoPrompt(variant, profile, category);
  const body = {
    model,
    prompt,
    duration,
    resolution,
    callback_url: callbackUrl,
  };
  if (firstFrameImageUrl) {
    body.first_frame_image = firstFrameImageUrl;
  }
  const response = await fetch(MINIMAX_VIDEO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    throw new Error(`Video API responded ${response.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await response.json();
  // Documented response shape: { task_id, base_resp: { status_code, status_msg } }
  //
  // Check `base_resp.status_code` FIRST so a rejected submission
  // surfaces the actual reason ("invalid params", "auth failed",
  // "callback url unreachable", etc.) instead of a misleading
  // "missing task_id" — when MiniMax rejects a submission it
  // returns `task_id: ""`, which would otherwise be the only
  // signal the caller sees. Order matters: never let the empty-
  // task_id check mask a more informative error.
  const code = data?.base_resp?.status_code;
  if (typeof code === 'number' && code !== 0) {
    const statusMsg = data?.base_resp?.status_msg;
    throw new Error(
      `Video API rejected task (code ${code}` +
      (statusMsg ? `: ${statusMsg}` : '') +
      `)`
    );
  }
  if (typeof data?.task_id !== 'string' || data.task_id.length === 0) {
    throw new Error('Video API response missing task_id.');
  }
  return data.task_id;
}

/**
 * Submit every variant to MiniMax in parallel. Returns an array of
 * `{ taskId, title, hook, script, year }` for the variants whose
 * submission succeeded — failed submissions are logged and skipped
 * (the frontend will render one fewer card).
 *
 * `firstFrames` is optional and must be aligned by index with
 * `variants`. Pass `null` (or omit the entry) for T2V; pass the
 * data URL string for I2V.
 *
 * Uses bounded concurrency (`mapWithConcurrency`) so we don't blow
 * past the MiniMax gateway's per-key rate limit.
 */
async function submitMinimaxVideoTasks(variants, profile, year, category, firstFrames, callbackUrl, signal) {
  const submitted = [];
  await mapWithConcurrency(
    variants,
    MAX_IMAGE_PARALLELISM,
    async (variant, vIdx) => {
      try {
        const firstFrame = (Array.isArray(firstFrames) && firstFrames[vIdx]) || null;
        const taskId = await submitMinimaxVideoTask(variant, profile, category, firstFrame, callbackUrl, signal);
        submitted[vIdx] = {
          taskId,
          title: variant.title,
          hook: variant.hook,
          script: variant.script,
          year,
        };
      } catch (err) {
        console.error(`[videos][step4-t2v] variant ${vIdx + 1} submit failed: ${err.message}`);
      }
    }
  );
  return submitted.filter(Boolean);
}

/**
 * Generate the I2V first-frame image for each variant. For I2V,
 * the model needs an anchor image plus a text prompt describing
 * the motion — we use the FIRST scene from each variant
 * (`image_prompts[0]`) so the opening frame of the video matches
 * the opening frame of the carousel slide it accompanies.
 *
 * Returns an array aligned with `variants`: `{ variant, firstFrame }`
 * on success, `null` on failure (so the caller can filter the
 * failed pairs and skip the corresponding I2V submission).
 *
 * Uses the same image generator + bounded concurrency as Step 3.
 */
async function generateI2VFirstFrames(variants, profile, signal) {
  const apiKey = process.env.MINIMAX_API_KEY;
  const out = new Array(variants.length).fill(null);
  await mapWithConcurrency(
    variants,
    MAX_IMAGE_PARALLELISM,
    async (variant, vIdx) => {
      const firstPrompt = Array.isArray(variant.image_prompts) ? variant.image_prompts[0] : null;
      if (typeof firstPrompt !== 'string' || firstPrompt.length === 0) {
        console.error(`[videos][step3-i2v] variant ${vIdx + 1} has no image_prompts[0]`);
        return;
      }
      const url = await generateImageSafely(
        apiKey,
        firstPrompt,
        `i2v-frame-v${vIdx + 1}`,
        profile.imageStyleSuffix,
        signal
      );
      if (url) {
        out[vIdx] = { variant, firstFrame: url };
      } else {
        console.error(`[videos][step3-i2v] variant ${vIdx + 1} first frame generation failed`);
      }
    }
  );
  return out;
}

/**
 * Step 4 dispatcher. Returns the public URL of the bundled
 * video. The variant index lets the URL be unique per render
 * and lets the bundler name files deterministically.
 */
async function bundleVideo(variant, year, images, variantIndex, signal) {
  const payload = buildBundlePayload(variant, year, images);
  const id = `${getDateKey()}-v${variantIndex + 1}`;

  // (a) External webhook path.
  const webhook = process.env.EXTERNAL_VIDEO_WEBHOOK;
  if (webhook) {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...payload }),
      signal,
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '<unreadable>');
      throw new Error(
        `Video webhook responded ${response.status}: ${errBody.slice(0, 300)}`
      );
    }
    const data = await response.json();
    if (!data?.url) {
      throw new Error('Video webhook response missing `url` field.');
    }
    return data.url;
  }

  // (b) ffmpeg path.
  if (process.env.BUNDLE_PROVIDER === 'ffmpeg') {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(VIDEO_TEMP_DIR, { recursive: true });
    const filename = `${id}.mp4`;
    const outPath = path.join(VIDEO_TEMP_DIR, filename);
    await bundleWithFfmpeg(payload, outPath);
    return `${VIDEO_PUBLIC_PREFIX}/${filename}`;
  }

  // (c) Manifest stub — no real bundler configured. Write the
  // payload to disk so the frontend can at least open and inspect
  // it. The URL points at the manifest file, not an MP4.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(VIDEO_TEMP_DIR, { recursive: true });
  const filename = `${id}.json`;
  await fs.writeFile(
    path.join(VIDEO_TEMP_DIR, filename),
    JSON.stringify(
      {
        id,
        note:
          'No video bundler configured. Set EXTERNAL_VIDEO_WEBHOOK for production ' +
          'or BUNDLE_PROVIDER=ffmpeg (plus `npm i ffmpeg-static fluent-ffmpeg`) ' +
          'for local dev.',
        ...payload,
      },
      null,
      2
    )
  );
  return `${VIDEO_PUBLIC_PREFIX}/${filename}`;
}

// ---------------------------------------------------------------------
// Response helper — Web Fetch API Response so the handler works on
// any runtime that mounts Web Fetch handlers (Node Express, Workers,
// Deno, Bun, etc.).
// ---------------------------------------------------------------------
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ---------------------------------------------------------------------
// Safety net
// ---------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

export const GET = withCors(async () => {
  return jsonResponse(
    {
      error: 'Method not allowed.',
      hint: 'This endpoint accepts POST only. The video flow is triggered from the "Generate Daily Videos" button in the UI.',
    },
    405,
    { Allow: 'POST' }
  );
});

export const POST = withCors(async (request, ctx) => {
  // --- Auth / config guard -----------------------------------------
  const apiKey = process.env.MINIMAX_API_KEY;
  // Log the resolved end-user IP. Behind Cloudflare the raw request
  // IP is a CF edge IP; ctx.ip is the real client (from
  // CF-Connecting-IP / X-Forwarded-For).
  if (ctx?.ip) console.log(`[ip] ${ctx.ip}`);
  if (!apiKey) {
    return jsonResponse({
      error: 'Server misconfigured: MINIMAX_API_KEY is not set.',
    }, 500);
  }

  const dateKey = getDateKey();
  const prettyDate = getPrettyDate();

  // --- Niche + category context (from POST body) ---------------------
  // The frontend posts { niche, category }. `niche` selects the
  // persona + visual style; `category` is consumed by the text-to-
  // video provider (BUNDLE_PROVIDER=minimax_video) to pick camera
  // commands and a composition line. Both fields are optional —
  // missing or unknown values fall back to defaults so an empty
  // payload keeps the original engine's behavior.
  let requestedNiche;
  let requestedCategory;
  try {
    const body = await request.json();
    if (body && typeof body.niche === 'string') {
      requestedNiche = body.niche;
    }
    if (body && typeof body.category === 'string') {
      requestedCategory = body.category;
    }
  } catch {
    // No body / non-JSON body — fine, defaults apply.
  }
  const profile = resolveNicheProfile(requestedNiche);
  const category = (requestedCategory && CATEGORY_PRESETS[requestedCategory])
    ? requestedCategory
    : DEFAULT_CATEGORY;
  console.log(`[niche] active=${profile.id}`);
  console.log(`[category] active=${category}`);

  // Build the absolute callback URL up front so the text-to-video
  // provider can register it with MiniMax. We prefer PUBLIC_URL
  // (the Cloudflare-fronted apex domain) when set, so the webhook
  // lands on the public domain — where Cloudflare's WAF / rate
  // limits / TLS already apply — instead of the raw deployment
  // host. Falls back to the request's own host for local dev.
  const videoCallbackUrl = (() => {
    const origin = getPublicOrigin(request);
    if (origin) return `${origin}${VIDEO_CALLBACK_PATH}`;
    try {
      const u = new URL(request.url);
      return `${u.protocol}//${u.host}${VIDEO_CALLBACK_PATH}`;
    } catch {
      return null;
    }
  })();

  try {
    // -----------------------------------------------------------------
    // STEP 1 — Fetch the 8-event roster for today.
    //
    // The archivist agent returns BOTH the raw text and the niche
    // query context that scoped the query. We thread the context
    // down to the AI filter agent in Step 2 so it knows which slice
    // of history it is picking the top item FROM.
    // -----------------------------------------------------------------
    console.log(`[videos][step1] requesting events for ${prettyDate} (${dateKey}) · niche=${profile.id} ...`);
    const { rawText: rawEventsText, queryContext, usage: step1Usage } = await runHistoricalTextAgent(prettyDate, profile.id, request.signal);
    if (!rawEventsText) throw new Error('Archivist agent returned empty content.');

    let events;
    try {
      const cleaned = sanitizeLlmOutput(rawEventsText);
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Archivist output parsed to an empty or non-array value.');
      }
      events = parsed;
    } catch (parseErr) {
      console.error('[videos][step1] parse failed:', parseErr.message);
      return jsonResponse({
        error: 'Archivist agent output could not be parsed as a JSON array.',
        details: parseErr.message,
      }, 502);
    }

    const normalizedEvents = events
      .slice(0, TARGET_EVENT_COUNT)
      .map((e, i) => normalizeEvent(e, i));
    console.log(`[videos][step1] received ${normalizedEvents.length} events`);

    // -----------------------------------------------------------------
    // STEP 2 — Filtering agent picks the single most-viral event and
    // returns 3 hook/script variants.
    //
    // The niche query context from Step 1 is passed through so the
    // filter agent sees the same search brief the archivist used,
    // AND its system prompt gets a "NICHE FILTERING HINT" appended
    // (e.g. "prioritize unsolved cases, dramatic heists, and
    // forensic firsts" for true_crime) so the top-pick is viral
    // WITHIN the niche's intent — not just generically viral.
    // -----------------------------------------------------------------
    console.log(`[videos][step2] requesting ${TARGET_VARIANT_COUNT} variants from filtering agent ...`);
    const filterResult = await runFilteringAgent(prettyDate, normalizedEvents, queryContext, request.signal);
    const rawVariantsText = filterResult?.text ?? '';
    const step2Usage = filterResult?.usage ?? { inputTokens: 0, outputTokens: 0 };
    if (!rawVariantsText) throw new Error('Filtering agent returned empty content.');

    let variantsRaw;
    try {
      const cleaned = sanitizeLlmOutput(rawVariantsText);
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Filtering agent output parsed to an empty or non-array value.');
      }
      variantsRaw = parsed;
    } catch (parseErr) {
      console.error('[videos][step2] parse failed:', parseErr.message);
      return jsonResponse({
        error: 'Filtering agent output could not be parsed as a JSON array.',
        details: parseErr.message,
      }, 502);
    }

    const variants = variantsRaw
      .slice(0, TARGET_VARIANT_COUNT)
      .map((v, i) => normalizeVariant(v, i));

    if (variants.length === 0) {
      return jsonResponse({
        error: 'Filtering agent returned no usable variants.',
      }, 502);
    }
    console.log(`[videos][step2] received ${variants.length} variants`);

    // The first normalized event's year is our anchor — the
    // filtering agent is supposed to pick ONE of the 8 events, and
    // we use the first event's year as a reasonable default for
    // the response. (The script/title carry the actual identity.)
    const anchorYear = normalizedEvents[0]?.year ?? 'Unknown';

    // -----------------------------------------------------------------
    // BRANCH — Text-to-video provider (BUNDLE_PROVIDER=minimax_video)
    //
    // When this provider is selected, the pipeline does NOT
    // generate the 4 stills per variant (the text-to-video model
    // produces motion from the prompt directly). We submit one
    // task per variant and return 202 with the task IDs so the
    // frontend polls /api/video-status for completion. The server
    // is decoupled from the long-running render — MiniMax POSTs
    // back to /api/video-callback when each task resolves.
    // -----------------------------------------------------------------
    if (process.env.BUNDLE_PROVIDER === 'minimax_video') {
      if (!videoCallbackUrl) {
        return jsonResponse({
          error: 'Could not derive callback URL from the incoming request.',
        }, 500);
      }
      console.log(`[videos][step4-t2v] submitting ${variants.length} tasks to MiniMax (callback=${videoCallbackUrl}) ...`);
      const submitted = await submitMinimaxVideoTasks(
        variants, profile, anchorYear, category, null, videoCallbackUrl, request.signal
      );
      if (submitted.length === 0) {
        return jsonResponse({
          error: 'Text-to-video submission failed for every variant.',
        }, 502);
      }
      // Record video-usage now that the tasks are accepted by the
      // gateway. We price per-second so a 6s clip and a 12s clip
      // surface different cost lines in the admin alert.
      const t2vDuration = Number.isInteger(parseInt(process.env.VIDGEN_DURATION, 10))
        ? parseInt(process.env.VIDGEN_DURATION, 10)
        : DEFAULT_VIDGEN_DURATION;
      recordUsage({
        route: '/api/generate-daily-videos',
        niche: profile.id,
        model: process.env.VIDGEN_MODEL || DEFAULT_VIDGEN_MODEL,
        videoCount: submitted.length,
        videoSeconds: submitted.length * t2vDuration,
        ip: ctx?.ip || null,
      }).catch(() => {});
      const statusUrl = `${VIDEO_STATUS_PATH}?ids=${submitted.map((t) => t.taskId).join(',')}`;
      console.log(`[videos][step4-t2v] submitted ${submitted.length}/${variants.length} tasks; statusUrl=${statusUrl}`);
      // 202 Accepted — the work continues asynchronously, frontend
      // polls statusUrl for completion.
      return jsonResponse(
        {
          status: 'processing',
          provider: 'minimax_video',
          dateKey,
          generatedAt: new Date().toISOString(),
          niche: profile.id,
          nicheLabel: profile.label,
          category,
          tasks: submitted,
          statusUrl,
        },
        202,
        { Location: statusUrl }
      );
    }

    // -----------------------------------------------------------------
    // BRANCH — Image-to-video provider (BUNDLE_PROVIDER=minimax_i2v)
    //
    // Same async task model as T2V, but each variant carries a
    // first-frame image (generated from `image_prompts[0]` with the
    // niche's image style) so the I2V model animates from a known
    // anchor instead of inventing the opening frame. Only one
    // image call per variant here (vs 4 for the carousel path) —
    // the I2V model does the rest.
    // -----------------------------------------------------------------
    if (process.env.BUNDLE_PROVIDER === 'minimax_i2v') {
      if (!videoCallbackUrl) {
        return jsonResponse({
          error: 'Could not derive callback URL from the incoming request.',
        }, 500);
      }
      console.log(`[videos][step3-i2v] generating ${variants.length} first-frame images ...`);
      const firstFrames = await generateI2VFirstFrames(variants, profile, request.signal);
      const validPairs = firstFrames.filter(Boolean);
      const failedCount = variants.length - validPairs.length;
      if (validPairs.length === 0) {
        return jsonResponse({
          error: 'First-frame image generation failed for every variant.',
        }, 502);
      }
      if (failedCount > 0) {
        console.warn(`[videos][step3-i2v] ${failedCount} variant(s) dropped — first frame failed`);
      }
      console.log(`[videos][step4-i2v] submitting ${validPairs.length} I2V tasks to MiniMax (callback=${videoCallbackUrl}) ...`);
      const submitted = await submitMinimaxVideoTasks(
        validPairs.map((p) => p.variant),
        profile,
        anchorYear,
        category,
        validPairs.map((p) => p.firstFrame),
        videoCallbackUrl,
        request.signal
      );
      if (submitted.length === 0) {
        return jsonResponse({
          error: 'Image-to-video submission failed for every variant.',
        }, 502);
      }
      // Record video-usage for the I2V submissions. The image
      // burst in this branch was just Step 3-i2v — one image per
      // variant (the first frame), not the full 3×4 carousel
      // image burst below.
      const i2vDuration = Number.isInteger(parseInt(process.env.VIDGEN_DURATION, 10))
        ? parseInt(process.env.VIDGEN_DURATION, 10)
        : DEFAULT_VIDGEN_DURATION;
      recordUsage({
        route: '/api/generate-daily-videos',
        niche: profile.id,
        model: process.env.VIDGEN_MODEL || DEFAULT_VIDGEN_MODEL,
        videoCount: submitted.length,
        videoSeconds: submitted.length * i2vDuration,
        ip: ctx?.ip || null,
      }).catch(() => {});
      const statusUrl = `${VIDEO_STATUS_PATH}?ids=${submitted.map((t) => t.taskId).join(',')}`;
      console.log(`[videos][step4-i2v] submitted ${submitted.length}/${validPairs.length} tasks; statusUrl=${statusUrl}`);
      return jsonResponse(
        {
          status: 'processing',
          provider: 'minimax_i2v',
          dateKey,
          generatedAt: new Date().toISOString(),
          niche: profile.id,
          nicheLabel: profile.label,
          category,
          tasks: submitted,
          statusUrl,
        },
        202,
        { Location: statusUrl }
      );
    }

    // -----------------------------------------------------------------
    // STEP 3 — Image generation for every scene in every variant.
    // Fan out 3 × 4 = 12 calls with bounded concurrency. Each
    // failure becomes null (a per-scene placeholder) rather than
    // poisoning the whole pipeline.
    // -----------------------------------------------------------------
    const workItems = [];
    variants.forEach((variant, vIdx) => {
      variant.image_prompts.forEach((prompt, sIdx) => {
        workItems.push({ vIdx, sIdx, prompt });
      });
    });

    console.log(`[videos][step3] dispatching ${workItems.length} image calls (max ${MAX_IMAGE_PARALLELISM} in flight) ...`);

    // The image map is keyed by `${vIdx}:${sIdx}` so the bundler
    // can pull the 4 frames for each variant back out. The per-niche
    // image style suffix is forwarded to every image call so all
    // 12 stills share the niche's visual identity.
    const imageMap = {};
    await mapWithConcurrency(workItems, MAX_IMAGE_PARALLELISM, async (item) => {
      const url = await generateImageSafely(
        apiKey,
        item.prompt,
        `v${item.vIdx + 1}.s${item.sIdx + 1}`,
        profile.imageStyleSuffix,
        request.signal
      );
      imageMap[`${item.vIdx}:${item.sIdx}`] = url;
    });

    const okCount = Object.values(imageMap).filter(Boolean).length;
    console.log(`[videos][step3] ${okCount}/${workItems.length} images succeeded`);

    // -----------------------------------------------------------------
    // STEP 3.5 — Record usage (text + images) for the admin alert.
    // -----------------------------------------------------------------
    // Text-agent calls (Step 1 archivist + Step 2 filter) are
    // priced by token count; the image burst is priced per image.
    // The notifier fires once per call so the operator gets a
    // separate Telegram row for each kind of consumption.
    recordUsage({
      route: '/api/generate-daily-videos',
      niche: profile.id,
      model: 'MiniMax-M3',
      textInputTokens:  step1Usage.inputTokens,
      textOutputTokens: step1Usage.outputTokens,
      ip: ctx?.ip || null,
    }).catch(() => {});
    recordUsage({
      route: '/api/generate-daily-videos',
      niche: profile.id,
      model: 'MiniMax-M3',
      textInputTokens:  step2Usage.inputTokens,
      textOutputTokens: step2Usage.outputTokens,
      ip: ctx?.ip || null,
    }).catch(() => {});
    recordUsage({
      route: '/api/generate-daily-videos',
      niche: profile.id,
      model: 'image-01',
      imageCount: okCount,
      ip: ctx?.ip || null,
    }).catch(() => {});

    // -----------------------------------------------------------------
    // STEP 4 — Bundle each variant into a video (or manifest stub).
    // -----------------------------------------------------------------
    console.log(`[videos][step4] bundling ${variants.length} videos ...`);
    const videos = [];
    for (let vIdx = 0; vIdx < variants.length; vIdx++) {
      const variant = variants[vIdx];
      const sceneImages = [];
      for (let sIdx = 0; sIdx < SCENES_PER_VARIANT; sIdx++) {
        // Null on failure — the bundler (or stub) decides what to
        // do with a missing frame.
        sceneImages.push(imageMap[`${vIdx}:${sIdx}`] ?? null);
      }
      try {
        const url = await bundleVideo(variant, anchorYear, sceneImages, vIdx, request.signal);
        videos.push({ url, title: variant.title, year: anchorYear });
      } catch (bundleErr) {
        // A single bundler failure should not poison the other
        // variants — log and skip. The frontend will simply render
        // one fewer video card.
        console.error(`[videos][step4] variant ${vIdx + 1} failed: ${bundleErr.message}`);
      }
    }

    if (videos.length === 0) {
      return jsonResponse({
        error: 'Video bundling failed for every variant.',
      }, 500);
    }

    // -----------------------------------------------------------------
    // STEP 5 — Response (matches public/app.js requestVideoGeneration).
    // -----------------------------------------------------------------
    return jsonResponse({
      dateKey,
      generatedAt: new Date().toISOString(),
      niche: profile.id,                      // echoed back for client display
      nicheLabel: profile.label,              // human-readable label
      videos,
    });
  } catch (err) {
    console.error('[videos][pipeline] fatal:', err);
    return jsonResponse({
      error: 'Video generation pipeline failed.',
      details: err.message,
    }, 500);
  }
});

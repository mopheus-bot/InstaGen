// =====================================================================
// InstaGen — Express backend (secure proxy + generation orchestrator)
// =====================================================================
// Architecture:
//   1. Serves the static frontend from /public
//   2. Exposes POST /api/generate-content which:
//        a. Resolves today's calendar date (month + day)
//        b. Calls the MiniMax text API (model: MiniMax-M3) with a rigid
//           system prompt that forces a raw JSON array of 8 events
//        c. Sanitizes + parses the LLM output defensively (with a
//           regex-extract fallback if JSON.parse fails)
//        d. Fires 8 image-generation calls in parallel via Promise.all
//           (model: image-01, endpoint /v1/image_generation), appending
//           a hard-coded aesthetic suffix to every prompt
//        e. Per-image failures are isolated — a placeholder is returned
//           for any failed slice, so the rest of the carousel still ships
//        f. Returns the assembled payload { date, slides[] } to the client
//
//   3. Runs as a long-lived Node process on Render, or as a serverless
//      function on Vercel (auto-detected via env var).
// =====================================================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import serverless from 'serverless-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM doesn't expose __dirname by default — derive it from import.meta.url
// so the static file path resolves correctly no matter where node was
// launched from (project root, a subfolder, an IDE terminal, etc.).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_API_BASE = (process.env.MINIMAX_API_BASE || 'https://api.minimax.io').replace(/\/+$/, '');

// Hard-coded visual signature appended to every image prompt.
// This guarantees a consistent, on-brand aesthetic across the carousel.
const AESTHETIC_SUFFIX =
  ', historical cinematic film still, shot on 35mm anamorphic lens, ' +
  'documentary textures, dramatic lighting, highly photorealistic, ' +
  '8k resolution, square crop --ar 1:1';

// Self-contained inline-SVG fallback so the UI never breaks even if the
// image API or any third-party placeholder service is unreachable.
const PLACEHOLDER_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
       <rect width="1024" height="1024" fill="#1a1a1a"/>
       <text x="512" y="512" font-family="system-ui,-apple-system,sans-serif"
             font-size="42" fill="#666" text-anchor="middle"
             dominant-baseline="middle">Image Unavailable</text>
     </svg>`
  );

// ---------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------
const app = express();

// Long-lived request windows for the 60-90s generation pipeline.
app.use((req, _res, next) => {
  req.setTimeout?.(300_000);
  next();
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve the frontend. The path is resolved against THIS file's location
// (via __dirname above), not the process CWD — so it works even if
// the server is launched from a different folder.
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));

// Explicit root route — belt-and-suspenders fallback in case the static
// middleware's index-file lookup is ever bypassed (e.g. trailing slash
// quirks, custom Vercel rewrites, etc.). Sends the same index.html.
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Resolves today's calendar date as { month, day, fullDate }.
 * Uses the server's local timezone, which is exactly what the user asked
 * for ("dynamically determine today's current date ... in the system").
 */
function getTodayContext() {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'long' });
  const day = now.getDate();
  return { month, day, fullDate: `${month} ${day}` };
}

/**
 * Builds the rigid system prompt that forces the LLM to return a raw
 * JSON array (no markdown, no preamble) of exactly 8 historical events.
 */
function buildSystemPrompt(month, day) {
  return [
    `You are a meticulous historical content curator.`,
    `Today is ${month} ${day}.`,
    ``,
    `Generate exactly 8 significant historical events that occurred on this`,
    `calendar date (any year, any century). Order them roughly from oldest to newest.`,
    ``,
    `ABSOLUTE OUTPUT RULES:`,
    `1. Return ONLY a raw, valid JSON array.`,
    `2. NO markdown, NO code fences, NO commentary, NO preamble, NO trailing text.`,
    `3. The response must be parseable by JSON.parse() on the first try.`,
    `4. The array must contain EXACTLY 8 objects.`,
    `5. Each object MUST match this schema exactly:`,
    `   { "year": "YYYY", "title": "...", "description": "...", "image_prompt": "..." }`,
    `   - year: 4-digit year as a string`,
    `   - title: concise headline, max 80 chars`,
    `   - description: 2-3 sentence Instagram caption, max 280 chars`,
    `   - image_prompt: vivid 60-120 word visual scene description of the`,
    `     historical moment, people, setting, and atmosphere (no aesthetic`,
    `     keywords — those are appended separately)`,
  ].join('\n');
}

/**
 * Calls the MiniMax text-generation endpoint.
 * Returns the raw assistant string (likely a JSON array).
 */
async function callTextAPI(systemPrompt, userMessage) {
  const url = `${MINIMAX_API_BASE}/v1/text_generation`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.85,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '<unreadable>');
    throw new Error(`Text API responded ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();

  // Be permissive about response shape — different MiniMax gateways
  // return different fields depending on the model + region.
  return (
    data?.choices?.[0]?.message?.content ??
    data?.reply ??
    data?.output?.text ??
    data?.text ??
    ''
  );
}

/**
 * Defensively parses the LLM text output into a JS array.
 *
 * Tries, in order:
 *   1. Direct JSON.parse() on the trimmed string
 *   2. Strip ```json fences, then re-parse
 *   3. Regex-extract the substring between the first '[' and last ']'
 *   4. Re-parse the extracted slice
 *
 * Throws if all strategies fail.
 */
function sanitizeAndParseEvents(rawText) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    throw new Error('LLM returned empty or non-string content.');
  }

  let cleaned = rawText.trim();

  // Strategy 1 + 2: strip common markdown wrappers, then parse.
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through to regex extraction */
  }

  // Strategy 3: substring extraction between first '[' and last ']'.
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');

  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const slice = cleaned.slice(firstBracket, lastBracket + 1);
    const parsed = JSON.parse(slice);
    if (Array.isArray(parsed)) return parsed;
  }

  throw new Error('Could not extract a valid JSON array from LLM output.');
}

/**
 * Calls the MiniMax image-generation endpoint for a single prompt.
 * Returns a hosted image URL (string) or throws.
 */
async function callImageAPI(imagePrompt) {
  const url = `${MINIMAX_API_BASE}/v1/image_generation`;
  const fullPrompt = `${imagePrompt}${AESTHETIC_SUFFIX}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MINIMAX_API_KEY}`,
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
    throw new Error(`Image API responded ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();

  // Try every plausible field the gateway might use.
  const candidate =
    data?.data?.[0]?.url ??
    data?.images?.[0]?.url ??
    data?.images?.[0] ??
    data?.image_url ??
    data?.output?.image_url ??
    (data?.data?.image_base64 ? `data:image/png;base64,${data.data.image_base64}` : null);

  if (!candidate) {
    throw new Error('Image API returned no recognizable URL/base64 field.');
  }
  return candidate;
}

/**
 * Wraps callImageAPI in a per-slice try/catch. Failed slices still
 * produce a slide record — they just use the placeholder image.
 */
async function generateImageSafely(imagePrompt) {
  try {
    return await callImageAPI(imagePrompt);
  } catch (err) {
    console.error(`[image] slice failed: ${err.message}`);
    return PLACEHOLDER_IMAGE;
  }
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

/** Lightweight liveness probe. */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    apiKeyConfigured: Boolean(MINIMAX_API_KEY),
  });
});

/**
 * POST /api/generate-content
 * Body: (none required — uses server-side clock)
 * Response: { date, generatedAt, slides: [{year,title,description,imageUrl}, ...] }
 */
app.post('/api/generate-content', async (req, res) => {
  // Guard: refuse to run without an API key configured.
  if (!MINIMAX_API_KEY) {
    return res.status(500).json({
      error: 'Server misconfigured: MINIMAX_API_KEY is not set.',
    });
  }

  try {
    // ----- Step A: Text generation ---------------------------------
    const { month, day, fullDate } = getTodayContext();
    const systemPrompt = buildSystemPrompt(month, day);
    const userMessage = `Generate the 8 historical events for ${fullDate}.`;

    console.log(`[text] requesting events for ${fullDate} ...`);
    const rawLlmText = await callTextAPI(systemPrompt, userMessage);

    if (!rawLlmText) {
      throw new Error('Text API returned empty content.');
    }
    console.log(`[text] received ${rawLlmText.length} chars`);

    // ----- Defensive JSON parsing ----------------------------------
    let events;
    try {
      events = sanitizeAndParseEvents(rawLlmText);
    } catch (parseErr) {
      console.error('[parse] failed:', parseErr.message);
      console.error('[parse] raw output snippet:', rawLlmText.slice(0, 500));
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

    // Cap at exactly 8 (or pad if model returned fewer — we ship what we get).
    const targetEvents = events.slice(0, 8).map((e, i) => ({
      year: String(e?.year ?? 'Unknown'),
      title: String(e?.title ?? `Event ${i + 1}`).slice(0, 120),
      description: String(e?.description ?? '').slice(0, 320),
      image_prompt:
        typeof e?.image_prompt === 'string' && e.image_prompt.trim().length > 0
          ? e.image_prompt
          : `${e?.title ?? 'historical scene'}, cinematic, dramatic lighting`,
    }));

    // ----- Step B: Parallel image generation -----------------------
    console.log(`[image] dispatching ${targetEvents.length} parallel requests ...`);
    const imageUrls = await Promise.all(
      targetEvents.map((event) => generateImageSafely(event.image_prompt))
    );
    const successCount = imageUrls.filter((u) => u !== PLACEHOLDER_IMAGE).length;
    console.log(`[image] ${successCount}/${targetEvents.length} succeeded`);

    // ----- Step C: Assemble final payload --------------------------
    const slides = targetEvents.map((event, idx) => ({
      year: event.year,
      title: event.title,
      description: event.description,
      imageUrl: imageUrls[idx],
    }));

    return res.json({
      date: fullDate,
      generatedAt: new Date().toISOString(),
      slides,
    });
  } catch (err) {
    console.error('[pipeline] fatal:', err);
    return res.status(500).json({
      error: 'Generation pipeline failed.',
      details: err.message,
    });
  }
});

// 404 fallback for /api/* (so the SPA index doesn't mask a bad route).
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------------
// Boot — long-lived process for Render, serverless handler for Vercel.
// ---------------------------------------------------------------------
const isServerless = Boolean(process.env.VERCEL) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

if (!isServerless) {
  app.listen(PORT, () => {
    console.log(`InstaGen server listening on port ${PORT}`);
    console.log(`MiniMax API base: ${MINIMAX_API_BASE}`);
    console.log(`Serving static files from: ${PUBLIC_DIR}`);
  });
}

// Vercel picks up the default export as the serverless function entry.
export default app;
export const handler = serverless(app);

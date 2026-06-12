// =====================================================================
// InstaGen — Shared handler helpers
// =====================================================================
// Common utilities used by every api/* handler. Centralized here so
// the handlers stay focused on their own pipeline logic and so a
// bug fix lands in one place rather than being copy-pasted across
// the six files that previously inlined these helpers.
//
// Contents:
//   - jsonResponse(): wrap a value in a Web Fetch API Response.
//   - getDateKey() / getPrettyDate(): server-local date helpers.
//   - sanitizeLlmOutput(): strip markdown fences from LLM text.
//   - extractLlmText(): resolve a text block from an Anthropic /
//     OpenAI-style response (with a fallback chain).
//   - extractLlmUsage(): pull token counts from either shape.
//   - uncaughtHandler(): install a process-level safety net so a
//     stray throw in a top-level constant initializer doesn't
//     take the Express process down.
//   - dataUrlToBuffer(): decode a data: URL to a Buffer (used by
//     both the image → R2 path and the ffmpeg bundler).
//   - generateJobId(): local UUID for fire-and-forget video jobs.
// =====================================================================

import crypto from 'node:crypto';

// ---------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------
/**
 * Build a Web Fetch API Response with a JSON body and the standard
 * Content-Type. Use this from every api/* handler so the conversion
 * to/from Express (server.js) is a no-op.
 */
export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ---------------------------------------------------------------------
// Date helpers (server-local timezone)
// ---------------------------------------------------------------------
/** YYYY-MM-DD in the server's local timezone. */
export function getDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "January 7" style label. */
export function getPrettyDate() {
  return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

// ---------------------------------------------------------------------
// LLM output sanitization
// ---------------------------------------------------------------------
/**
 * Strip a leading ```json / ``` fence and a trailing ``` fence, then
 * trim. The model is told not to emit fences but a few slip through.
 * Does NOT parse — the caller does that in its own try/catch.
 */
export function sanitizeLlmOutput(rawText) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    throw new Error('LLM returned empty or non-string content.');
  }
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice('```json'.length);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

/**
 * Resolve the assistant text from an Anthropic / OpenAI / generic
 * gateway response. The Anthropic Messages shape puts it in
 * `content[].text`; OpenAI chat-completions in
 * `choices[0].message.content`; a handful of smaller gateways use
 * `reply` / `output.text` / `text`. This helper walks the chain.
 */
export function extractLlmText(data) {
  const content = Array.isArray(data?.content) ? data.content : [];
  const textBlock = content.find((b) => b && b.type === 'text');
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
 * Pull { inputTokens, outputTokens } from an Anthropic / OpenAI
 * usage block. Either shape is accepted; missing fields default to 0.
 */
export function extractLlmUsage(data) {
  return {
    inputTokens:  Number(data?.usage?.input_tokens  ?? data?.usage?.prompt_tokens     ?? 0),
    outputTokens: Number(data?.usage?.output_tokens ?? data?.usage?.completion_tokens ?? 0),
  };
}

// ---------------------------------------------------------------------
// Process-level safety net
// ---------------------------------------------------------------------
/**
 * Install process-level handlers that log — and swallow — uncaught
 * exceptions and unhandled rejections. Idempotent: a second call
 * replaces the prior handlers. The HTTP error handler in server.js
 * is the primary safety net; this is the last-resort backstop.
 */
export function installUncaughtHandlers() {
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
}

// ---------------------------------------------------------------------
// data: URL → Buffer
// ---------------------------------------------------------------------
/**
 * Decode any `data:<mime>;base64,<payload>` URL into a raw Buffer.
 * Returns null on parse failure. Used by both the image → R2 path
 * and the ffmpeg bundler.
 */
export function dataUrlToBuffer(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}

// ---------------------------------------------------------------------
// Job ID
// ---------------------------------------------------------------------
/**
 * Generate a fresh local job id. Used by the fire-and-forget video
 * pipeline so the 202 response can include an id immediately (the
 * MiniMax task id is only known after the upstream submit, which
 * is no longer awaited on the request path).
 */
export function generateJobId() {
  return crypto.randomUUID();
}
